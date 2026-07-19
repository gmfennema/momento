// Generator (maker-facing) page: audio in → engravable card out.
// Everything happens in this browser tab; the audio never leaves it.

import {
  fileToFloat32,
  playPcm,
  slicePcm,
  MAX_SECONDS,
  PCM_SAMPLE_RATE,
  type Playback,
} from '../lib/audio';
import { codec2Encode } from '../lib/codec2';
import { lyraEncode, lyraSupported, warmUpLyra } from '../lib/lyra';
import { preparePcm } from '../lib/preprocess';
import { decimate2 } from '../lib/resample';
import { randomCardId, splitPayloadSizes } from '../lib/chunk';
import {
  estimatePayloadBytes,
  pickAutoTier,
  planCard,
  TIERS,
  type CardPlan,
  type CardSpec,
  type Tier,
} from '../lib/layout';
import { chunkMatrix, entryMatrix } from '../lib/qr';
import {
  computeWaveformBars,
  drawFront,
  FRONT_BAR_COUNT,
  renderFrontSvg,
  type FrontInput,
} from '../lib/front';
import { drawCard, renderSvg, type RenderInput } from '../lib/render';
import { startRecording, type RecorderHandle } from './recorder';
import { attachTrim, type TrimState } from './trim';

const PNG_DPI = 1200;
const PX_PER_MM = PNG_DPI / 25.4;

interface State {
  pcm: Int16Array | null;
  trim: TrimState;
  tierKey: 'auto' | Tier['key'];
  inverted: boolean;
  textLine: string;
  cardId: number;
  // derived
  encoded: Uint8Array | null;
  plan: CardPlan | null;
  renderInput: RenderInput | null;
  frontInput: FrontInput | null;
}

export function mountGenerator(root: HTMLElement): void {
  root.innerHTML = `
    <h1><span class="logo">●</span> Momento</h1>
    <p class="tagline">Put 10 seconds of sound on a business card. The audio lives only in the engraving — no servers, no storage, no accounts.</p>

    <div class="panel">
      <h2>1 · Audio</h2>
      <label class="dropzone" id="dropzone">
        <input type="file" id="file-input" accept="audio/*" />
        <div><strong>Drop an audio file</strong> or tap to browse</div>
        <div class="hint">Up to ${MAX_SECONDS} seconds makes it onto the card</div>
      </label>
      <div class="row" style="margin-top:0.6rem">
        <button id="record-btn">🎙 Record</button>
        <button id="preview-btn" disabled>▶ Preview selection</button>
        <span class="hint" id="audio-status"></span>
      </div>
      <div id="trim-wrap" style="display:none; margin-top:0.75rem">
        <canvas class="waveform" id="waveform"></canvas>
        <div class="trim-hint" id="trim-hint"></div>
      </div>
    </div>

    <div class="panel">
      <h2>2 · Quality vs. density</h2>
      <div class="tiers" id="tiers"></div>
    </div>

    <div class="panel">
      <h2>3 · Card</h2>
      <div class="options">
        <label><input type="checkbox" id="invert-toggle" /> Invert for black cards (white engraving)</label>
        <label>Name line <input type="text" id="text-line" placeholder="optional" maxlength="40" /></label>
      </div>
      <div id="card-wrap" style="display:none; margin-top:0.9rem">
        <div class="card-face-label">Front</div>
        <canvas class="card-preview" id="front-preview"></canvas>
        <div class="card-face-label" style="margin-top:0.9rem">Back</div>
        <canvas class="card-preview" id="card-preview"></canvas>
        <div class="stats-line" id="stats-line"></div>
        <div id="warnings"></div>
        <div class="row" style="margin-top:0.8rem">
          <button class="primary" id="dl-front-png">Front PNG (${PNG_DPI} dpi)</button>
          <button class="primary" id="dl-front-svg">Front SVG</button>
          <button class="primary" id="dl-png">Back PNG (${PNG_DPI} dpi)</button>
          <button class="primary" id="dl-svg">Back SVG (vector)</button>
          <button id="test-scan">I want to test-scan it</button>
        </div>
        <div class="hint" id="test-hint" style="display:none">
          Open <strong>${playerUrl()}</strong> on your phone (or scan the card's entry code)
          and point the camera at this screen or a printout.
        </div>
      </div>
      <div id="error-box"></div>
    </div>

    <footer>
      Audio is compressed entirely in your browser with
      <a href="https://github.com/google/lyra" target="_blank" rel="noreferrer">Lyra</a>
      (<a href="lyra/NOTICE.md" target="_blank">notices</a>) or
      <a href="https://github.com/drowe67/codec2" target="_blank" rel="noreferrer">Codec 2</a>
      (<a href="codec2/NOTICE.md" target="_blank">LGPL 2.1 notice</a>).
      Card is 3.5″ × 2″. Engrave at the exact output size — do not rescale.
    </footer>
  `;

  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  // Lyra (the "Best" tier) needs SharedArrayBuffer; when the page isn't
  // cross-origin isolated (first-ever visit before the service worker kicks
  // in, or an old browser) fall back to Codec 2 tiers only.
  const lyraOk = lyraSupported();
  const state: State = {
    pcm: null,
    trim: { startSec: 0, endSec: 0 },
    tierKey: 'auto',
    inverted: false,
    textLine: '',
    cardId: randomCardId(),
    encoded: null,
    plan: null,
    renderInput: null,
    frontInput: null,
  };

  let playback: Playback | null = null;
  let recorder: RecorderHandle | null = null;
  let encodeSeq = 0;
  let debounceTimer = 0;
  let pcmEpoch = 0; // bumped when a new clip loads, invalidating the encode cache
  let encodeCache: { key: string; bytes: Uint8Array } | null = null;

  // --- audio input ---

  const dropzone = $('dropzone');
  const fileInput = $<HTMLInputElement>('file-input');

  async function loadBlob(blob: Blob): Promise<void> {
    setError(null);
    $('audio-status').textContent = 'Decoding…';
    try {
      const f32 = await fileToFloat32(blob);
      // Condition the clip for the vocoders: high-pass, drop edge silence
      // (silence costs card space at a fixed bitrate), normalize loudness.
      const prepared = preparePcm(f32, PCM_SAMPLE_RATE);
      const durationSec = prepared.pcm.length / PCM_SAMPLE_RATE;
      if (durationSec < 0.3) throw new Error('That clip is too short.');
      const trimmed = prepared.trimmedLeadSec + prepared.trimmedTailSec;
      state.pcm = prepared.pcm;
      state.cardId = randomCardId();
      pcmEpoch++;
      encodeCache = null;
      warmUpLyra();
      $('audio-status').textContent =
        `${durationSec.toFixed(1)}s loaded` +
        (trimmed >= 0.3 ? ` (dropped ${trimmed.toFixed(1)}s of silence)` : '');
      const wrap = $('trim-wrap');
      wrap.style.display = 'block';
      const canvas = $<HTMLCanvasElement>('waveform');
      state.trim = attachTrim(canvas, prepared.pcm, (t) => {
        state.trim = t;
        updateTrimHint();
        scheduleUpdate();
      });
      updateTrimHint();
      $<HTMLButtonElement>('preview-btn').disabled = false;
      scheduleUpdate();
    } catch (e) {
      state.pcm = null;
      $('audio-status').textContent = '';
      setError(
        e instanceof Error && e.message.includes('short')
          ? e.message
          : 'Could not decode that file. Try a common format (mp3, m4a, wav, ogg).',
      );
    }
  }

  function updateTrimHint(): void {
    const dur = state.pcm ? state.pcm.length / PCM_SAMPLE_RATE : 0;
    const sel = state.trim.endSec - state.trim.startSec;
    $('trim-hint').textContent =
      dur > MAX_SECONDS
        ? `Selected ${sel.toFixed(1)}s of ${dur.toFixed(1)}s — drag the window (or its edges) to choose what goes on the card.`
        : `Whole clip (${dur.toFixed(1)}s) goes on the card.`;
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadBlob(f);
  });
  for (const ev of ['dragover', 'dragleave', 'drop'] as const) {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop') {
        const f = (e as DragEvent).dataTransfer?.files?.[0];
        if (f) void loadBlob(f);
      }
    });
  }

  const recordBtn = $<HTMLButtonElement>('record-btn');
  recordBtn.addEventListener('click', async () => {
    if (recorder) {
      recorder.stop();
      return;
    }
    try {
      recorder = await startRecording((ms) => {
        recordBtn.textContent = `■ Stop (${Math.min(MAX_SECONDS, ms / 1000).toFixed(1)}s)`;
      });
      recordBtn.classList.add('recording');
      recordBtn.textContent = '■ Stop (0.0s)';
      const blob = await recorder.blob;
      recorder = null;
      recordBtn.classList.remove('recording');
      recordBtn.textContent = '🎙 Record';
      await loadBlob(blob);
    } catch {
      recorder = null;
      recordBtn.classList.remove('recording');
      recordBtn.textContent = '🎙 Record';
      setError('Microphone access was denied.');
    }
  });

  $('preview-btn').addEventListener('click', () => {
    if (!state.pcm) return;
    playback?.stop();
    playback = playPcm(slicePcm(state.pcm, state.trim.startSec, state.trim.endSec));
  });

  // --- tiers ---

  const tiles: Array<{ key: State['tierKey']; label: string; blurb: string }> = [
    {
      key: 'auto',
      label: 'Auto',
      blurb: 'Picks the highest quality that keeps this clip easy to scan.',
    },
    ...TIERS,
  ];
  const tiersEl = $('tiers');
  for (const tile of tiles) {
    const el = document.createElement('button');
    el.className = 'tier';
    el.dataset.key = tile.key;
    el.innerHTML = `
      <div class="name">${tile.label}</div>
      <div class="blurb">${tile.blurb}</div>
      <div class="stats" data-stats>—</div>
    `;
    if (tile.key === 'best' && !lyraOk) {
      el.disabled = true;
      el.title = 'This browser cannot run the Lyra codec.';
    }
    el.addEventListener('click', () => {
      state.tierKey = tile.key;
      renderTierSelection();
      scheduleUpdate();
    });
    tiersEl.appendChild(el);
  }
  function renderTierSelection(): void {
    tiersEl.querySelectorAll<HTMLElement>('.tier').forEach((el) => {
      el.classList.toggle('selected', el.dataset.key === state.tierKey);
    });
  }
  renderTierSelection();

  // The single card spec used for tier decisions, tier stats, AND the real
  // plan — if these diverged (e.g. one forgot the text line, whose 5mm strip
  // shrinks the modules), the auto tier could approve a card the final plan
  // renders below the scannability floor.
  function cardSpec(): CardSpec {
    return {
      inverted: state.inverted,
      textLine: state.textLine.trim() ? state.textLine : undefined,
    };
  }

  /** The concrete tier the current selection encodes with. */
  function resolveTier(seconds: number): Tier {
    if (state.tierKey === 'auto') return pickAutoTier(seconds, cardSpec(), lyraOk);
    return TIERS.find((t) => t.key === state.tierKey)!;
  }

  function updateTierStats(): void {
    const seconds = state.pcm ? state.trim.endSec - state.trim.startSec : MAX_SECONDS;
    tiersEl.querySelectorAll<HTMLElement>('.tier').forEach((el) => {
      const statsEl = el.querySelector('[data-stats]')!;
      if (el.dataset.key === 'auto') {
        try {
          statsEl.textContent = `→ ${resolveTier(seconds).label.toLowerCase()} for this clip`;
        } catch {
          statsEl.textContent = 'does not fit';
        }
        return;
      }
      const tier = TIERS.find((t) => t.key === el.dataset.key)!;
      if (tier.codec === 'lyra' && !lyraOk) {
        statsEl.textContent = 'not available in this browser';
        return;
      }
      try {
        const plan = planCard(estimatePayloadBytes(seconds, tier), cardSpec());
        statsEl.textContent = `${plan.chunkCount} codes · ${plan.moduleMm.toFixed(2)}mm dots`;
      } catch {
        statsEl.textContent = 'does not fit';
      }
    });
  }
  updateTierStats();

  // --- options ---

  $<HTMLInputElement>('invert-toggle').addEventListener('change', (e) => {
    state.inverted = (e.target as HTMLInputElement).checked;
    scheduleUpdate();
  });
  $<HTMLInputElement>('text-line').addEventListener('input', (e) => {
    state.textLine = (e.target as HTMLInputElement).value;
    scheduleUpdate();
  });
  $('test-scan').addEventListener('click', () => {
    const h = $('test-hint');
    h.style.display = h.style.display === 'none' ? 'block' : 'none';
  });

  // --- pipeline: encode → plan → render ---

  function scheduleUpdate(): void {
    clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void update(), 300);
    updateTierStats();
  }

  async function update(): Promise<void> {
    if (!state.pcm) return;
    const seq = ++encodeSeq;
    setError(null);
    try {
      const seconds = state.trim.endSec - state.trim.startSec;
      const tier = resolveTier(seconds);
      // Encoding depends only on the clip, trim window, and tier — reuse the
      // last result when only card options (text line, invert) changed, so
      // typing a caption doesn't re-run neural-codec inference per keystroke.
      const encodeKey = `${tier.key}|${pcmEpoch}|${state.trim.startSec}|${state.trim.endSec}`;
      let encoded: Uint8Array;
      if (encodeCache && encodeCache.key === encodeKey) {
        encoded = encodeCache.bytes;
      } else {
        const pcm = slicePcm(state.pcm, state.trim.startSec, state.trim.endSec);
        encoded =
          tier.codec === 'lyra'
            ? await lyraEncode(pcm)
            : await codec2Encode(tier.mode, decimate2(pcm));
        encodeCache = { key: encodeKey, bytes: encoded };
      }
      if (seq !== encodeSeq) return; // superseded
      const plan = planCard(encoded.length, cardSpec());
      const chunks = splitPayloadSizes(
        encoded,
        tier.wireVersion,
        tier.modeId,
        plan.chunkSpecs.map((s) => s.payloadBytes),
        state.cardId,
      );
      const renderInput: RenderInput = {
        plan,
        matrices: chunks.map((c, i) => chunkMatrix(c, plan.chunkSpecs[i]!.qrVersion)),
        entry: entryMatrix(playerUrl()),
        inverted: state.inverted,
      };
      state.encoded = encoded;
      state.plan = plan;
      state.renderInput = renderInput;
      // The front shows the same slice of audio the back encodes — but keeps
      // the name line even when the back drops it to protect scannability.
      state.frontInput = {
        bars: computeWaveformBars(
          slicePcm(state.pcm, state.trim.startSec, state.trim.endSec),
          FRONT_BAR_COUNT,
        ),
        inverted: state.inverted,
        textLine: state.textLine.trim() || undefined,
        durationSec: seconds,
      };
      renderPreview(tier);
    } catch (e) {
      if (seq === encodeSeq) {
        setError(e instanceof Error ? e.message : 'Something went wrong while building the card.');
      }
    }
  }

  function renderPreview(tier: Tier): void {
    const { plan, renderInput } = state;
    if (!plan || !renderInput) return;
    $('card-wrap').style.display = 'block';

    const canvas = $<HTMLCanvasElement>('card-preview');
    const previewPxPerMm = Math.max(8, Math.min(14, 1600 / plan.widthMm / 2));
    canvas.width = Math.round(plan.widthMm * previewPxPerMm * 2);
    canvas.height = Math.round(plan.heightMm * previewPxPerMm * 2);
    drawCard(canvas.getContext('2d')!, renderInput, previewPxPerMm * 2);

    if (state.frontInput) {
      const front = $<HTMLCanvasElement>('front-preview');
      front.width = canvas.width;
      front.height = canvas.height;
      drawFront(front.getContext('2d')!, state.frontInput, previewPxPerMm * 2);
    }

    const seconds = state.trim.endSec - state.trim.startSec;
    const codecLabel = tier.codec === 'lyra' ? 'Lyra 3.2 kbps' : `Codec 2 ${tier.mode}`;
    const smallCodes = plan.chunkSpecs.filter((s) => s.qrVersion !== plan.qrVersion);
    const codesLabel =
      `${plan.chunkCount - smallCodes.length} data codes (QR v${plan.qrVersion})` +
      (smallCodes.length ? ` + ${smallCodes.length} small (v${smallCodes[0]!.qrVersion})` : '');
    $('stats-line').textContent =
      `${seconds.toFixed(1)}s audio · ${codecLabel} · ${state.encoded!.length} bytes · ` +
      `${codesLabel} + 1 entry code · ` +
      `${plan.moduleMm.toFixed(2)}mm modules · ${plan.grid.cols}×${plan.grid.rows} grid`;

    const w = $('warnings');
    w.innerHTML = '';
    const msgs: string[] = [];
    if (plan.warnings.includes('module-below-0.25')) {
      msgs.push(
        '⚠ Modules are below 0.25mm — many engravers and phone cameras will struggle. Consider a lower quality tier or shorter audio.',
      );
    } else if (plan.warnings.includes('module-below-0.30')) {
      msgs.push(
        '⚠ Modules are below 0.30mm — scanning still works but needs a clean engraving and a decent camera.',
      );
    }
    if (plan.warnings.includes('text-dropped')) {
      msgs.push('ℹ The name line was dropped to keep the codes scannable.');
    }
    for (const m of msgs) {
      const div = document.createElement('div');
      div.className = 'warning';
      div.textContent = m;
      w.appendChild(div);
    }
  }

  // --- downloads ---

  $('dl-png').addEventListener('click', () => {
    const { plan, renderInput } = state;
    if (!plan || !renderInput) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(plan.widthMm * PX_PER_MM);
    canvas.height = Math.round(plan.heightMm * PX_PER_MM);
    drawCard(canvas.getContext('2d')!, renderInput, PX_PER_MM);
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, 'momento-card-back.png');
    }, 'image/png');
  });

  $('dl-svg').addEventListener('click', () => {
    if (!state.renderInput) return;
    const svg = renderSvg(state.renderInput);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'momento-card-back.svg');
  });

  $('dl-front-png').addEventListener('click', () => {
    const { plan, frontInput } = state;
    if (!plan || !frontInput) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(plan.widthMm * PX_PER_MM);
    canvas.height = Math.round(plan.heightMm * PX_PER_MM);
    drawFront(canvas.getContext('2d')!, frontInput, PX_PER_MM);
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, 'momento-card-front.png');
    }, 'image/png');
  });

  $('dl-front-svg').addEventListener('click', () => {
    if (!state.frontInput) return;
    const svg = renderFrontSvg(state.frontInput);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'momento-card-front.svg');
  });

  function setError(msg: string | null): void {
    const box = $('error-box');
    box.innerHTML = '';
    if (msg) {
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = msg;
      box.appendChild(div);
    }
  }
}

function playerUrl(): string {
  // Origin-agnostic: whatever host serves the generator also serves the player,
  // so a future custom domain needs no code change.
  return location.origin + location.pathname.replace(/index\.html$/, '') + '#p';
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
