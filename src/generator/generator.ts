// Generator (maker-facing) page: audio in → engravable card out.
// Everything happens in this browser tab; the audio never leaves it.

import {
  fileToFloat32,
  pcmToWavBlob,
  playPcm,
  slicePcm,
  MAX_SECONDS,
  PCM_SAMPLE_RATE,
  type Playback,
} from '../lib/audio';
import { warmUpNeuralBwe } from '../lib/bwe';
import { lyraSupported, warmUpLyra } from '../lib/lyra';
import { preparePcm } from '../lib/preprocess';
import { randomCardId, splitPayload } from '../lib/chunk';
import {
  bestTierThatFits,
  estimatePayloadBytes,
  maxSecondsForTier,
  MODULE_FLOOR_MM,
  planCard,
  tierFits,
  TIERS,
  type CardPlan,
  type CardSpec,
  type Tier,
} from '../lib/layout';
import {
  decodeForPlayback,
  encodeForTier,
  previewForTier,
  type RestoredAudio,
} from '../lib/restore';
import { chunkMatrix, entryMatrix } from '../lib/qr';
import {
  computeWaveformBars,
  drawFront,
  FRONT_BAR_COUNT,
  renderFrontSvg,
  type FrontInput,
} from '../lib/front';
import { cardTexture, drawCard, renderSvg, type RenderInput } from '../lib/render';
import { brandHeader } from '../lib/brand';
import { startRecording, type RecorderHandle } from './recorder';
import { attachTrim, type TrimHandle, type TrimState } from './trim';

const PNG_DPI = 1200;
const PX_PER_MM = PNG_DPI / 25.4;

/** Shown under a preview that came back from the DSP fallback rather than the
 * neural model — the same caveat the player shows a listener. */
const DSP_NOTE = 'neural restoration unavailable here — this is the standard restoration';

interface State {
  pcm: Int16Array | null;
  trim: TrimState;
  /** The maker's *preference*. The card uses it when the clip fits it and the
   * next best fitting tier otherwise — nothing below the module floor is ever
   * built, so a preference can be aspirational without producing a bad card. */
  tierKey: Tier['key'];
  inverted: boolean;
  textured: boolean;
  textLine: string;
  voice: string;
  recordedAt: string; // 'YYYY-MM-DD' (front metadata line), '' if cleared
  cardId: number;
  // derived
  tier: Tier | null;
  encoded: Uint8Array | null;
  plan: CardPlan | null;
  renderInput: RenderInput | null;
  frontInput: FrontInput | null;
}

/** One encode of one trim window, plus the playback it restores to once the
 * maker has previewed it. Shared by the card pipeline and the tier previews so
 * neither pays for the other's work twice. */
interface EncodeEntry {
  bytes: Uint8Array;
  restored?: RestoredAudio;
}

export function mountGenerator(root: HTMLElement): void {
  root.innerHTML = `
    ${brandHeader(
      'Ten seconds of sound on a business card. The audio lives only in the engraving — no servers, no storage, no accounts.',
      'maker',
    )}

    <div class="panel">
      <h2>01 · Audio</h2>
      <label class="dropzone" id="dropzone">
        <input type="file" id="file-input" accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,.mp4,.mov" />
        <div><strong>Drop an audio file</strong> or tap to browse</div>
        <div class="hint">Supports MP3, WAV, M4A, AAC, OGG, FLAC, WebM (up to ${MAX_SECONDS} seconds)</div>
      </label>
      <div class="row" style="margin-top:0.9rem">
        <button id="upload-btn" class="primary">Upload audio</button>
        <button id="record-btn">Record</button>
        <button id="preview-btn" disabled>Play original</button>
        <button id="download-wav-btn" disabled>Download WAV</button>
        <span class="hint" id="audio-status"></span>
      </div>
      <div id="trim-wrap" style="display:none; margin-top:0.75rem">
        <canvas class="waveform" id="waveform"></canvas>
        <div class="trim-hint" id="trim-hint"></div>
      </div>
    </div>

    <div class="panel">
      <h2>02 · Voice quality</h2>
      <p class="hint" style="margin-top:0">Every tier is restored by a neural model when the card is
        scanned, and no card ever gets dots smaller than ${MODULE_FLOOR_MM.toFixed(2)}mm — a tier that
        would is simply unavailable until the clip is trimmed. Preview any tier to hear the card.</p>
      <div class="tiers" id="tiers"></div>
    </div>

    <div class="panel">
      <h2>03 · The card</h2>
      <div class="options">
        <label><input type="checkbox" id="texture-toggle" checked /> Bury the codes in a pixel field (edge-to-edge texture)</label>
        <label><input type="checkbox" id="invert-toggle" /> Invert QR codes for black cards (background stays white)</label>
        <label>Name line (front) <input type="text" id="text-line" placeholder="optional" maxlength="40" /></label>
        <label>Voice <input type="text" id="voice-line" placeholder="e.g. Emma" maxlength="24" /></label>
        <label>Recorded <input type="date" id="recorded-date" /></label>
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
          <button id="hear-card">▶ Hear this card</button>
          <button id="test-scan">I want to test-scan it</button>
        </div>
        <div class="hint" id="test-hint" style="display:none">
          Open <a href="#p"><strong>${playerUrl()}</strong></a> on your phone (or scan the card's entry code)
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
      · <a href="#p">Scan a card</a>
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
    tierKey: 'best',
    inverted: false,
    textured: true,
    textLine: '',
    voice: '',
    recordedAt: todayIso(),
    cardId: randomCardId(),
    tier: null,
    encoded: null,
    plan: null,
    renderInput: null,
    frontInput: null,
  };

  let playback: Playback | null = null;
  let recorder: RecorderHandle | null = null;
  // Tier-preview playback state (see startPreview): declared up here because
  // the first renderTiers() runs while the tiles are being built.
  let previewBusyKey: Tier['key'] | null = null;
  let previewPlaying: { key: Tier['key']; playback: Playback } | null = null;
  let previewSeq = 0;
  let trimHandle: TrimHandle | null = null;
  let encodeSeq = 0;
  let debounceTimer = 0;
  let pcmEpoch = 0; // bumped when a new clip loads, invalidating the encode cache
  const encodeCache = new Map<string, EncodeEntry>();

  function cacheKey(tier: Tier): string {
    return `${tier.key}|${pcmEpoch}|${state.trim.startSec}|${state.trim.endSec}`;
  }

  function rememberEncode(key: string, entry: EncodeEntry): void {
    encodeCache.set(key, entry);
    // Dragging the trim window mints a new key per pointer move; keep only the
    // last few so a long session doesn't hold on to every encode ever made.
    while (encodeCache.size > 8) {
      const oldest = encodeCache.keys().next().value;
      if (oldest === undefined) break;
      encodeCache.delete(oldest);
    }
  }

  // --- audio input ---

  const dropzone = $('dropzone');
  const fileInput = $<HTMLInputElement>('file-input');
  const uploadBtn = $<HTMLButtonElement>('upload-btn');
  const downloadWavBtn = $<HTMLButtonElement>('download-wav-btn');

  uploadBtn.addEventListener('click', () => {
    fileInput.click();
  });

  downloadWavBtn.addEventListener('click', () => {
    if (!state.pcm) return;
    const sliced = slicePcm(state.pcm, state.trim.startSec, state.trim.endSec);
    const wavBlob = pcmToWavBlob(sliced, PCM_SAMPLE_RATE);
    downloadBlob(wavBlob, 'converted-audio.wav');
  });

  async function loadBlob(blob: Blob, fileName?: string): Promise<void> {
    setError(null);
    $('audio-status').textContent = 'Decoding audio file…';
    try {
      const f32 = await fileToFloat32(blob);
      // Condition the clip for the vocoders: high-pass, drop edge silence
      // (silence costs card space at a fixed bitrate), normalize loudness.
      const prepared = preparePcm(f32, PCM_SAMPLE_RATE);
      const durationSec = prepared.pcm.length / PCM_SAMPLE_RATE;
      if (durationSec < 0.3) throw new Error('That clip is too short.');
      const trimmed = prepared.trimmedLeadSec + prepared.trimmedTailSec;
      stopPreview();
      state.pcm = prepared.pcm;
      state.cardId = randomCardId();
      pcmEpoch++;
      encodeCache.clear();
      warmUpLyra();
      // Previewing a tier runs the player's restoration, so start the 27 MB
      // model download now rather than at the first click on ▶ Preview.
      warmUpNeuralBwe();
      const label = fileName ? `${fileName} (${durationSec.toFixed(1)}s)` : `${durationSec.toFixed(1)}s loaded`;
      $('audio-status').textContent =
        label + (trimmed >= 0.3 ? ` (dropped ${trimmed.toFixed(1)}s of silence)` : '');
      const wrap = $('trim-wrap');
      wrap.style.display = 'block';
      const canvas = $<HTMLCanvasElement>('waveform');
      trimHandle = attachTrim(canvas, prepared.pcm, (t) => {
        state.trim = t;
        updateTrimHint();
        scheduleUpdate();
      });
      state.trim = trimHandle.state;
      updateTrimHint();
      $<HTMLButtonElement>('preview-btn').disabled = false;
      downloadWavBtn.disabled = false;
      scheduleUpdate();
    } catch (e) {
      state.pcm = null;
      $('audio-status').textContent = '';
      downloadWavBtn.disabled = true;
      setError(
        e instanceof Error && e.message.includes('short')
          ? e.message
          : 'Could not decode that file. Try a common format (mp3, m4a, wav, ogg, flac, webm).',
      );
    }
  }

  function updateTrimHint(): void {
    const dur = state.pcm ? state.pcm.length / PCM_SAMPLE_RATE : 0;
    const sel = state.trim.endSec - state.trim.startSec;
    // A short clip can also end up with a window on it — trimming to fit a
    // denser tier is exactly that.
    $('trim-hint').textContent =
      sel < dur - 0.05
        ? `Selected ${sel.toFixed(1)}s of ${dur.toFixed(1)}s — drag the window (or its edges) to choose what goes on the card.`
        : `Whole clip (${dur.toFixed(1)}s) goes on the card.`;
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadBlob(f, f.name);
  });
  for (const ev of ['dragover', 'dragleave', 'drop'] as const) {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop') {
        const f = (e as DragEvent).dataTransfer?.files?.[0];
        if (f) void loadBlob(f, f.name);
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
        recordBtn.textContent = `Stop · ${Math.min(MAX_SECONDS, ms / 1000).toFixed(1)}s`;
      });
      recordBtn.classList.add('recording');
      recordBtn.textContent = 'Stop · 0.0s';
      const blob = await recorder.blob;
      recorder = null;
      recordBtn.classList.remove('recording');
      recordBtn.textContent = 'Record';
      await loadBlob(blob, 'Microphone Recording');
    } catch {
      recorder = null;
      recordBtn.classList.remove('recording');
      recordBtn.textContent = 'Record';
      setError('Microphone access was denied.');
    }
  });

  $('preview-btn').addEventListener('click', () => {
    if (!state.pcm) return;
    stopPreview();
    playback?.stop();
    playback = playPcm(slicePcm(state.pcm, state.trim.startSec, state.trim.endSec));
  });

  // --- tiers ---

  interface Tile {
    tier: Tier;
    el: HTMLElement;
    stats: HTMLElement;
    note: HTMLElement;
    previewBtn: HTMLButtonElement;
    trimBtn: HTMLButtonElement;
    status: HTMLElement;
  }

  const tiersEl = $('tiers');
  const tiles = new Map<Tier['key'], Tile>();
  for (const tier of TIERS) {
    // A plain <div>: the tile carries its own buttons, and a button inside a
    // button is neither valid HTML nor parseable the way it reads.
    const el = document.createElement('div');
    el.className = 'tier';
    el.dataset.key = tier.key;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="name">${tier.label}</div>
      <div class="blurb">${tier.blurb}</div>
      <div class="stats" data-stats>—</div>
      <div class="tier-note" data-note></div>
      <div class="preview-row">
        <button class="small" data-preview disabled>▶ Preview</button>
        <button class="small" data-trim style="display:none">Trim</button>
        <span class="hint" data-status></span>
      </div>
    `;
    const tile: Tile = {
      tier,
      el,
      stats: el.querySelector<HTMLElement>('[data-stats]')!,
      note: el.querySelector<HTMLElement>('[data-note]')!,
      previewBtn: el.querySelector<HTMLButtonElement>('[data-preview]')!,
      trimBtn: el.querySelector<HTMLButtonElement>('[data-trim]')!,
      status: el.querySelector<HTMLElement>('[data-status]')!,
    };
    if (tier.codec === 'lyra' && !lyraOk) {
      el.setAttribute('aria-disabled', 'true');
      el.title = 'This browser cannot run the Lyra codec.';
    }
    const choose = (): void => {
      if (el.classList.contains('unavailable')) return; // trim it first
      state.tierKey = tier.key;
      renderTiers();
      scheduleUpdate();
    };
    el.addEventListener('click', choose);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose();
      }
    });
    tile.previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void startPreview(tier);
    });
    tile.trimBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      trimToFit(tier);
    });
    tiersEl.appendChild(el);
    tiles.set(tier.key, tile);
  }

  // The single card spec used for tier decisions, tier stats, AND the real
  // plan — if these diverged (e.g. one forgot that a textured back lays the
  // codes out differently), a tier could be offered whose final plan renders
  // below the scannability floor.
  function cardSpec(): CardSpec {
    return { inverted: state.inverted, textured: state.textured };
  }

  function preferredTier(): Tier {
    return TIERS.find((t) => t.key === state.tierKey)!;
  }

  /** The tier the card is actually built with: the preference when this clip
   * fits it, the best fitting rung otherwise. */
  function effectiveTier(seconds: number): Tier {
    const pref = preferredTier();
    const usable = pref.codec !== 'lyra' || lyraOk;
    if (usable && tierFits(seconds, pref, cardSpec())) return pref;
    return bestTierThatFits(seconds, cardSpec(), lyraOk);
  }

  /** Shrink the trim window to the longest clip this tier can hold, and adopt
   * the tier — the button exists precisely to unlock it. */
  function trimToFit(tier: Tier): void {
    if (!state.pcm || !trimHandle) return;
    const maxSec = maxSecondsForTier(tier, cardSpec());
    if (maxSec <= 0) return;
    const duration = state.pcm.length / PCM_SAMPLE_RATE;
    state.tierKey = tier.key;
    trimHandle.set(state.trim.startSec, Math.min(state.trim.startSec + maxSec, duration));
    updateTrimHint();
    renderTiers();
    scheduleUpdate();
  }

  function renderTiers(): void {
    const spec = cardSpec();
    const seconds = state.pcm ? state.trim.endSec - state.trim.startSec : null;
    let effective: Tier | null = null;
    if (seconds !== null) {
      try {
        effective = effectiveTier(seconds);
      } catch {
        effective = null; // nothing fits — the error surfaces from update()
      }
    }
    const pref = preferredTier();
    const prefUsable = pref.codec !== 'lyra' || lyraOk;

    for (const tile of tiles.values()) {
      const { tier } = tile;
      const usable = tier.codec !== 'lyra' || lyraOk;
      const maxSec = usable ? maxSecondsForTier(tier, spec) : 0;
      const fits = usable && (seconds === null || tierFits(seconds, tier, spec));
      const selected = effective !== null && effective.key === tier.key;
      tile.el.classList.toggle('unavailable', !fits);
      tile.el.classList.toggle('selected', selected);

      if (!usable) {
        tile.stats.textContent = 'not available in this browser';
      } else if (seconds === null) {
        tile.stats.textContent = `fits up to ${maxSec.toFixed(1)}s`;
      } else if (fits) {
        const plan = planCard(estimatePayloadBytes(seconds, tier), spec);
        tile.stats.textContent =
          `${plan.chunkCount} codes · ${plan.moduleMm.toFixed(2)}mm dots · fits up to ${maxSec.toFixed(1)}s`;
      } else {
        tile.stats.textContent = `needs ≤ ${maxSec.toFixed(1)}s — this clip is ${seconds.toFixed(1)}s`;
      }

      // Explain a silently-downgraded selection on the tile doing the work.
      const overridden = selected && pref.key !== tier.key;
      tile.note.textContent = !overridden
        ? ''
        : prefUsable
          ? `${pref.label} needs ≤ ${maxSecondsForTier(pref, spec).toFixed(1)}s — using ${tier.label} for this clip.`
          : `${pref.label} isn't available in this browser — using ${tier.label}.`;

      const canTrim = !fits && usable && seconds !== null && maxSec > 0;
      tile.trimBtn.style.display = canTrim ? '' : 'none';
      if (canTrim) tile.trimBtn.textContent = `Trim to ${maxSec.toFixed(1)}s`;

      const playing = previewPlaying?.key === tier.key;
      tile.previewBtn.disabled =
        !playing && (!state.pcm || !fits || previewBusyKey !== null);
    }
  }
  renderTiers();

  // --- tier preview: encode → decode → restore → play, exactly as a scan does ---

  function stopPreview(): void {
    previewSeq++;
    previewBusyKey = null;
    const current = previewPlaying;
    previewPlaying = null;
    if (!current) return;
    current.playback.stop();
    const tile = tiles.get(current.key);
    if (tile) tile.previewBtn.textContent = '▶ Preview';
  }

  async function startPreview(tier: Tier): Promise<void> {
    const tile = tiles.get(tier.key);
    if (!tile || !state.pcm) return;
    if (previewPlaying?.key === tier.key) {
      stopPreview();
      tile.status.textContent = '';
      renderTiers();
      return;
    }
    // One sound at a time: a second preview (or the original) would just be
    // noise over the first.
    stopPreview();
    playback?.stop();
    playback = null;
    const seq = ++previewSeq;
    previewBusyKey = tier.key;
    renderTiers();
    const setStatus = (msg: string): void => {
      if (seq === previewSeq) tile.status.textContent = msg;
    };
    try {
      const key = cacheKey(tier);
      const cached = encodeCache.get(key);
      let restored = cached?.restored;
      if (!restored) {
        if (cached?.bytes) {
          // The card pipeline already paid for this encode; only the playback
          // side is missing.
          restored = await decodeForPlayback(tier.wireVersion, tier.modeId, cached.bytes, setStatus);
          rememberEncode(key, { bytes: cached.bytes, restored });
        } else {
          const slice = slicePcm(state.pcm, state.trim.startSec, state.trim.endSec);
          const result = await previewForTier(tier, slice, setStatus);
          restored = {
            pcm: result.pcm,
            sampleRate: result.sampleRate,
            restoration: result.restoration,
          };
          rememberEncode(key, { bytes: result.bytes, restored });
        }
      }
      if (seq !== previewSeq) return;
      const audio = restored;
      tile.previewBtn.textContent = '■ Stop';
      setStatus(audio.restoration === 'dsp' ? `Playing… — ${DSP_NOTE}` : 'Playing…');
      const pb = playPcm(audio.pcm, audio.sampleRate);
      previewPlaying = { key: tier.key, playback: pb };
      void pb.done.then(() => {
        if (previewPlaying?.playback !== pb) return;
        previewPlaying = null;
        tile.previewBtn.textContent = '▶ Preview';
        setStatus(audio.restoration === 'dsp' ? DSP_NOTE : '');
        renderTiers();
      });
    } catch {
      setStatus('Preview failed on this device.');
    } finally {
      if (previewBusyKey === tier.key) previewBusyKey = null;
      renderTiers();
      updateStatsLine();
    }
  }

  $('hear-card').addEventListener('click', () => {
    if (!state.tier) return;
    void startPreview(state.tier);
  });

  // --- options ---

  $<HTMLInputElement>('invert-toggle').addEventListener('change', (e) => {
    state.inverted = (e.target as HTMLInputElement).checked;
    scheduleUpdate();
  });
  $<HTMLInputElement>('texture-toggle').addEventListener('change', (e) => {
    state.textured = (e.target as HTMLInputElement).checked;
    scheduleUpdate();
  });
  $<HTMLInputElement>('text-line').addEventListener('input', (e) => {
    state.textLine = (e.target as HTMLInputElement).value;
    scheduleUpdate();
  });
  $<HTMLInputElement>('voice-line').addEventListener('input', (e) => {
    state.voice = (e.target as HTMLInputElement).value;
    scheduleUpdate();
  });
  const recordedInput = $<HTMLInputElement>('recorded-date');
  recordedInput.value = state.recordedAt; // default to today
  recordedInput.addEventListener('input', (e) => {
    state.recordedAt = (e.target as HTMLInputElement).value;
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
    renderTiers();
  }

  async function update(): Promise<void> {
    if (!state.pcm) return;
    const seq = ++encodeSeq;
    setError(null);
    try {
      const seconds = state.trim.endSec - state.trim.startSec;
      const tier = effectiveTier(seconds);
      // Encoding depends only on the clip, trim window, and tier — reuse the
      // last result when only card options (text line, invert) changed, so
      // typing a caption doesn't re-run neural-codec inference per keystroke.
      const key = cacheKey(tier);
      let encoded = encodeCache.get(key)?.bytes;
      if (!encoded) {
        const pcm = slicePcm(state.pcm, state.trim.startSec, state.trim.endSec);
        encoded = await encodeForTier(tier, pcm);
        if (seq !== encodeSeq) return; // superseded
        rememberEncode(key, { bytes: encoded });
      }
      const plan = planCard(encoded.length, cardSpec());
      const chunks = splitPayload(
        encoded,
        tier.wireVersion,
        tier.modeId,
        plan.payloadPerChunk,
        state.cardId,
      );
      const renderInput: RenderInput = {
        plan,
        matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
        entry: entryMatrix(playerUrl()),
        inverted: state.inverted,
        // Seeded by card id so the preview, PNG, and SVG are the same field.
        texture: state.textured ? { seed: state.cardId } : undefined,
      };
      state.tier = tier;
      state.encoded = encoded;
      state.plan = plan;
      state.renderInput = renderInput;
      // The front shows the same slice of audio the back encodes, and carries
      // all the human-facing type — the back is codes and "SCAN TO LISTEN".
      state.frontInput = {
        bars: computeWaveformBars(
          slicePcm(state.pcm, state.trim.startSec, state.trim.endSec),
          FRONT_BAR_COUNT,
        ),
        textLine: state.textLine.trim() || undefined,
        voice: state.voice.trim() || undefined,
        recordedAt: state.recordedAt || undefined,
        durationSec: seconds,
      };
      renderPreview();
    } catch (e) {
      if (seq === encodeSeq) {
        setError(e instanceof Error ? e.message : 'Something went wrong while building the card.');
      }
    }
  }

  function renderPreview(): void {
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

    updateStatsLine();

    const w = $('warnings');
    w.innerHTML = '';
    // No module-size warnings to render: a tier below the floor is never
    // offered, so the only thing left to say is when the field ran out of room.
    if (plan.warnings.includes('texture-cramped')) {
      const div = document.createElement('div');
      div.className = 'warning';
      div.textContent =
        'ℹ This clip fills the card, so the pixel field only reaches the margins — the codes keep their full quiet zones. A shorter clip or a lower quality tier lets the field run between them.';
      w.appendChild(div);
    }
  }

  function updateStatsLine(): void {
    const { plan, renderInput, tier, encoded } = state;
    if (!plan || !renderInput || !tier || !encoded) return;
    const seconds = state.trim.endSec - state.trim.startSec;
    const codecLabel = tier.codec === 'lyra' ? 'Lyra 3.2 kbps' : `Codec 2 ${tier.mode}`;
    // Once the maker has previewed this exact card we know which restoration
    // their device managed — worth saying, since it is what a scanner hears.
    const restoration = encodeCache.get(cacheKey(tier))?.restored?.restoration;
    const restoreLabel =
      restoration === 'neural'
        ? ' (neural restoration)'
        : restoration === 'dsp'
          ? ' (standard restoration)'
          : '';
    const field = cardTexture(renderInput);
    $('stats-line').textContent =
      `${seconds.toFixed(1)}s audio · ${codecLabel}${restoreLabel} · ${encoded.length} bytes · ` +
      `${plan.chunkCount} data codes (QR v${plan.qrVersion}) + 1 entry code · ` +
      `${plan.moduleMm.toFixed(2)}mm modules · ${plan.grid.cols}×${plan.grid.rows} grid` +
      (field ? ` · +${(field.coverage * 100).toFixed(0)}% engraved area (texture)` : '');
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

/** Today's date as 'YYYY-MM-DD' in local time — the default for the Recorded
 * field, matching the value shape of an <input type="date">. */
function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
