// The card station (maker-facing): sound in → engravable card out.
// Everything happens in this browser tab; the audio and any photo never leave it.
//
// The flow is a sequence: what the card holds (a voice or a heartbeat) → the
// sound → a design → the details → engrave. The kind decides the codec — Mimi
// for a voice, Pulse for a heartbeat — and which two front designs are offered.
// The card is always built with that codec; if it can't be, the station says
// why and makes no card.

import { fileToFloat32, pcmToWavBlob, playPcm, slicePcm, MAX_SECONDS, PCM_SAMPLE_RATE, type Playback } from '../lib/audio';
import {
  MimiDownloadError,
  MimiTimeoutError,
  mimiFramesFor,
  mimiSupported,
  warmUpMimi,
  MIMI_CODE_BITS,
  MIMI_FRAME_RATE,
} from '../lib/mimi';
import { preparePcm } from '../lib/preprocess';
import { randomCardId, splitPayload } from '../lib/chunk';
import {
  CARD_SIZES,
  DEFAULT_CARD_SIZE,
  maxSecondsForTier,
  MIMI_MIN_DEPTH,
  mimiDepthForFrames,
  MODULE_FLOOR_MM,
  planCard,
  tierFits,
  TIERS,
  type CardSizeKey,
  type CardSpec,
  type Tier,
} from '../lib/layout';
import { pngWithDpi } from '../lib/png';
import { decodeForPlayback, encodeForTier, modeIdForTier, type RestoredAudio } from '../lib/restore';
import { chunkMatrix, entryMatrix } from '../lib/qr';
import {
  computeWaveformBars,
  designsFor,
  detectHeartbeat,
  drawFront,
  FONT_FAMILIES,
  FRONT_BAR_COUNT,
  FRONT_DESIGNS,
  renderFrontSvg,
  RING_BAR_COUNT,
  type FrontDesign,
  type FrontInput,
  type FrontKind,
  type FrontPhoto,
} from '../lib/front';
import { cardTexture, DEFAULT_BURN_MM, drawCard, renderSvg, type RenderInput } from '../lib/render';
import { decodePhoto, tonePhoto } from '../lib/photo';
import { startRecording, type RecorderHandle } from './recorder';
import { attachTrim, type TrimHandle, type TrimState } from './trim';

const PNG_DPI = 1200;
const PX_PER_MM = PNG_DPI / 25.4;

const MIMI_FAILED =
  "The voice model couldn't run on this device. Reload the page and try again, or use another browser.";

/** What the blank is made of. It decides both faces at once: on a black card
 * the engraved marks come out light, so the back's codes are inverted (to scan
 * as dark-on-light) and the front's photo is engraved as a negative (to read
 * true). The vector marks on the front need nothing — they're meant to be light. */
type Stock = 'black' | 'light';

const TIER_FOR: Record<FrontKind, Tier['key']> = { voice: 'best', heartbeat: 'heartbeat' };

interface State {
  kind: FrontKind;
  /** the design picked for each kind, so switching kinds and back keeps it */
  design: Record<FrontKind, FrontDesign>;
  stock: Stock;
  cardSize: CardSizeKey;
  textured: boolean;
  /** laser over-burn the back compensates for, mm per edge */
  burnMm: number;
  textLine: string;
  voice: string;
  recordedAt: string;
  cardId: number;
  pcm: Int16Array | null;
  trim: TrimState;
  photoBitmap: ImageBitmap | null;
  /** the photo toned for the current stock */
  photo: FrontPhoto | null;
  // derived — the back, once encoded
  tier: Tier | null;
  depth: number;
  encoded: Uint8Array | null;
  renderInput: RenderInput | null;
}

interface EncodeEntry {
  bytes: Uint8Array;
  restored?: RestoredAudio;
}

const VOICE_ICON = `<svg viewBox="0 0 48 24" aria-hidden="true">${[3, 7, 12, 6, 16, 20, 11, 18, 9, 14, 5, 10, 4]
  .map((h, i) => `<rect x="${2 + i * 3.6}" y="${12 - h / 2}" width="1.6" height="${h}" rx="0.8"/>`)
  .join('')}</svg>`;
const HEART_ICON = `<svg viewBox="0 0 48 24" aria-hidden="true"><polyline points="1,14 12,14 15,11 18,14 21,14 23,16 26,3 29,19 31,14 35,14 38,10 41,14 47,14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

export function mountGenerator(root: HTMLElement): void {
  document.body.classList.add('station');
  const sizeOptions = (Object.keys(CARD_SIZES) as CardSizeKey[])
    .map((k) => `<option value="${k}"${k === DEFAULT_CARD_SIZE ? ' selected' : ''}>${CARD_SIZES[k].label}</option>`)
    .join('');

  root.innerHTML = `
    <header class="st-head">
      <span class="st-mark">Momento</span>
      <span class="st-sub">Card station</span>
    </header>

    <main class="st-grid">
      <section class="st-stage" aria-label="Card preview">
        <div class="stage-card" id="stage-card" data-stock="black" data-face="front">
          <div class="flip">
            <canvas class="face face-front" id="front-preview" aria-label="Front of the card"></canvas>
            <div class="face face-back">
              <canvas id="card-preview" aria-label="Back of the card"></canvas>
              <p class="back-empty" id="back-empty">The codes that hold the sound appear here once you add it.</p>
            </div>
          </div>
        </div>
        <div class="stage-bar">
          <div class="seg" role="group" aria-label="Card face">
            <button type="button" data-face="front" aria-pressed="true">Front</button>
            <button type="button" data-face="back" aria-pressed="false">Back</button>
          </div>
          <button type="button" class="btn-quiet" id="hear-card" disabled>Hear this card</button>
        </div>
        <p class="stage-summary" id="card-summary">A sample of the front. Add a sound to make it yours.</p>
        <div id="error-box" role="alert"></div>
        <div id="warnings"></div>
      </section>

      <div class="st-steps">
        <section class="step" aria-labelledby="h-kind">
          <h2 id="h-kind"><span class="n">1</span>What will the card hold?</h2>
          <div class="kinds" role="radiogroup" aria-labelledby="h-kind">
            <button type="button" class="kind" role="radio" data-kind="voice" aria-checked="true">
              ${VOICE_ICON}
              <strong>A voice</strong>
              <span>A message or a laugh, in someone's own voice. Up to ${MAX_SECONDS} seconds.</span>
            </button>
            <button type="button" class="kind" role="radio" data-kind="heartbeat" aria-checked="false">
              ${HEART_ICON}
              <strong>A heartbeat</strong>
              <span>A baby's heartbeat from an ultrasound or a home doppler, with the scan on the front.</span>
            </button>
          </div>
        </section>

        <section class="step" aria-labelledby="h-sound">
          <h2 id="h-sound"><span class="n">2</span>The sound</h2>
          <label class="drop" id="dropzone">
            <input type="file" id="file-input" accept="audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,.mp4,.mov" />
            <span class="drop-main" id="drop-main">Drop an audio or video file here, or choose one</span>
            <span class="drop-sub" id="drop-sub">MP3, M4A, WAV and most phone recordings work.</span>
          </label>
          <div class="row">
            <button type="button" class="btn" id="record-btn">Record</button>
            <button type="button" class="btn" id="preview-btn" disabled>Play the clip</button>
            <span class="status" id="audio-status"></span>
          </div>
          <div id="trim-wrap" hidden>
            <canvas class="trim" id="waveform" aria-label="Drag to choose which part goes on the card"></canvas>
            <p class="note" id="trim-hint"></p>
          </div>
        </section>

        <section class="step" aria-labelledby="h-design">
          <h2 id="h-design"><span class="n">3</span>Design</h2>
          <div class="designs" id="designs" role="radiogroup" aria-labelledby="h-design"></div>
        </section>

        <section class="step" aria-labelledby="h-details">
          <h2 id="h-details"><span class="n">4</span>Details</h2>
          <div class="fields">
            <label class="field field-wide">
              <span>Title</span>
              <input type="text" id="text-line" maxlength="40" placeholder="For Mom" autocomplete="off" />
            </label>
            <label class="field" id="voice-field">
              <span>Whose voice</span>
              <input type="text" id="voice-line" maxlength="24" placeholder="Emma" autocomplete="off" />
            </label>
            <label class="field">
              <span>Recorded</span>
              <input type="date" id="recorded-date" />
            </label>
            <div class="field field-wide" id="photo-field" hidden>
              <span>Ultrasound scan</span>
              <div class="photo-pick">
                <input type="file" id="photo-input" accept="image/*" hidden />
                <button type="button" class="btn" id="photo-btn">Choose the scan</button>
                <span class="status" id="photo-status">A photo of the printout works. It stays in this tab.</span>
              </div>
            </div>
            <div class="field field-wide">
              <span id="stock-label">Card</span>
              <div class="seg seg-wide" role="radiogroup" aria-labelledby="stock-label">
                <button type="button" data-stock="black" role="radio" aria-checked="true">Black metal</button>
                <button type="button" data-stock="light" role="radio" aria-checked="false">Light card or print</button>
              </div>
            </div>
          </div>
        </section>

        <section class="step" aria-labelledby="h-engrave">
          <h2 id="h-engrave"><span class="n">5</span>Engrave</h2>
          <p class="note">Each file comes out exactly card size. Engrave at 100%, never scaled to fit.</p>
          <div class="downloads">
            <button type="button" class="btn btn-ink" id="dl-front-png" disabled>Front PNG</button>
            <button type="button" class="btn btn-ink" id="dl-back-png" disabled>Back PNG</button>
            <button type="button" class="btn" id="dl-front-svg" disabled>Front SVG</button>
            <button type="button" class="btn" id="dl-svg" disabled>Back SVG</button>
          </div>
          <p class="note" id="download-note"></p>
          <details class="settings">
            <summary>Engraving settings</summary>
            <div class="fields">
              <label class="field field-wide">
                <span>Blank</span>
                <select id="size-select">${sizeOptions}</select>
              </label>
              <label class="field field-wide">
                <span>Laser over-burn</span>
                <select id="burn-select">
                  <option value="0">None: dots exactly as drawn</option>
                  <option value="0.04">Fine beam, 0.04 mm</option>
                  <option value="0.08" selected>Typical, 0.08 mm</option>
                  <option value="0.12">Wide beam, 0.12 mm</option>
                </select>
              </label>
              <label class="check field-wide">
                <input type="checkbox" id="texture-toggle" checked />
                <span>Hide the codes in a pixel field that runs edge to edge</span>
              </label>
            </div>
            <p class="note">A laser burns a little wider than the artwork, which thins the dots it leaves
              until phones can't read them. The back is drawn to cancel that out. If your engraved dots
              still look thin next to the gaps between them, go up a step.</p>
            <p class="tech" id="stats-line"></p>
            <div class="row">
              <button type="button" class="btn btn-small" id="download-wav-btn" disabled>Download the clip (WAV)</button>
              <button type="button" class="btn btn-small" id="test-scan">Test-scan from this screen</button>
            </div>
            <p class="note" id="test-hint" hidden>Open <strong>${playerUrl()}</strong> on your phone and point it at
              the back of the card on this screen.</p>
          </details>
        </section>
      </div>
    </main>

    <footer class="st-foot">
      Voices are compressed in your browser with
      <a href="https://huggingface.co/kyutai/mimi" target="_blank" rel="noreferrer">Mimi</a>
      (<a href="${import.meta.env.BASE_URL}mimi/NOTICE.md" target="_blank">CC-BY-4.0 notice</a>);
      heartbeats with a small codec built into this page. Nothing is uploaded.
    </footer>
  `;

  const $ = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const mimiOk = mimiSupported();
  const state: State = {
    kind: 'voice',
    design: { voice: 'wave', heartbeat: 'framed' },
    stock: 'black',
    cardSize: DEFAULT_CARD_SIZE,
    textured: true,
    burnMm: DEFAULT_BURN_MM,
    textLine: '',
    voice: '',
    recordedAt: todayIso(),
    cardId: randomCardId(),
    pcm: null,
    trim: { startSec: 0, endSec: 0 },
    photoBitmap: null,
    photo: null,
    tier: null,
    depth: 0,
    encoded: null,
    renderInput: null,
  };

  let playback: Playback | null = null;
  let recorder: RecorderHandle | null = null;
  let trimHandle: TrimHandle | null = null;
  let encodeSeq = 0;
  let debounceTimer = 0;
  let pcmEpoch = 0;
  let hearing = false;
  const encodeCache = new Map<string, EncodeEntry>();

  // --- small helpers ---

  const tier = (): Tier => TIERS.find((t) => t.key === TIER_FOR[state.kind])!;
  const design = (): FrontDesign => state.design[state.kind];
  const cardDims = () => CARD_SIZES[state.cardSize];

  function cardSpec(): CardSpec {
    const { widthMm, heightMm } = cardDims();
    return { widthMm, heightMm, inverted: state.stock === 'black', textured: state.textured };
  }

  function cacheKey(t: Tier, depth: number): string {
    return `${t.key}|${depth}|${pcmEpoch}|${state.trim.startSec}|${state.trim.endSec}`;
  }

  function rememberEncode(key: string, entry: EncodeEntry): void {
    encodeCache.set(key, entry);
    while (encodeCache.size > 8) {
      const oldest = encodeCache.keys().next().value;
      if (oldest === undefined) break;
      encodeCache.delete(oldest);
    }
  }

  function clipFrames(): number {
    if (!state.pcm) return 0;
    const a = Math.max(0, Math.floor(state.trim.startSec * PCM_SAMPLE_RATE));
    const b = Math.min(state.pcm.length, Math.ceil(state.trim.endSec * PCM_SAMPLE_RATE));
    return mimiFramesFor(b - a);
  }

  function depthFor(t: Tier): number {
    if (t.codec !== 'mimi') return 0;
    return mimiDepthForFrames(clipFrames(), cardSpec()) ?? MIMI_MIN_DEPTH;
  }

  function setError(msg: string | null): void {
    const box = $('error-box');
    box.textContent = '';
    if (msg) {
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = msg;
      box.appendChild(div);
    }
  }

  // --- the front: always live, a sample until there's a sound ---

  function frontInput(d: FrontDesign = design()): FrontInput {
    const { widthMm, heightMm, cornerMm } = cardDims();
    const heart = FRONT_DESIGNS[d].kind === 'heartbeat';
    const count = d === 'ring' ? RING_BAR_COUNT : FRONT_BAR_COUNT;
    const slice = state.pcm ? slicePcm(state.pcm, state.trim.startSec, state.trim.endSec) : null;
    return {
      design: d,
      bars: slice ? computeWaveformBars(slice, count) : sampleBars(count),
      photo: heart ? (state.photo ?? undefined) : undefined,
      heartbeat: heart ? (slice ? (detectHeartbeat(slice, PCM_SAMPLE_RATE) ?? undefined) : SAMPLE_HEARTBEAT) : undefined,
      textLine: state.textLine.trim() || (state.pcm ? undefined : heart ? 'Baby Grace' : 'For Mom'),
      voice: heart ? undefined : state.voice.trim() || undefined,
      recordedAt: state.recordedAt || undefined,
      durationSec: slice ? slice.length / PCM_SAMPLE_RATE : 8,
      widthMm,
      heightMm,
      cornerMm,
    };
  }

  /** Front downloads need a real sound, and a heartbeat design needs its scan. */
  function frontReady(): boolean {
    return !!state.pcm && (state.kind === 'voice' || !!state.photo);
  }

  const stageCard = $('stage-card');
  const frontCanvas = $<HTMLCanvasElement>('front-preview');
  const backCanvas = $<HTMLCanvasElement>('card-preview');

  /** Preview resolution: crisp on a retina screen at the stage's size, and
   * never under 18 px/mm — enough for a phone to test-scan the back straight
   * off this screen (≈6 px per 0.33 mm dot). */
  function stagePxPerMm(): number {
    const cssW = Math.max(320, stageCard.clientWidth || 560);
    return Math.max(18, Math.min(28, (cssW * Math.min(2, window.devicePixelRatio || 1)) / cardDims().widthMm));
  }

  function drawStageFront(): void {
    const { widthMm, heightMm } = cardDims();
    const ppm = stagePxPerMm();
    frontCanvas.width = Math.round(widthMm * ppm);
    frontCanvas.height = Math.round(heightMm * ppm);
    drawFront(frontCanvas.getContext('2d')!, frontInput(), ppm);
  }

  function drawStageBack(): void {
    const has = !!state.renderInput;
    backCanvas.hidden = !has;
    $('back-empty').hidden = has;
    if (!state.renderInput) return;
    const { plan } = state.renderInput;
    const ppm = stagePxPerMm();
    backCanvas.width = Math.round(plan.widthMm * ppm);
    backCanvas.height = Math.round(plan.heightMm * ppm);
    drawCard(backCanvas.getContext('2d')!, state.renderInput, ppm);
  }

  function shapeStage(): void {
    const { widthMm, heightMm, cornerMm } = cardDims();
    stageCard.style.setProperty('--ar', `${widthMm} / ${heightMm}`);
    stageCard.style.setProperty(
      '--radius',
      cornerMm ? `${((cornerMm / widthMm) * 100).toFixed(2)}% / ${((cornerMm / heightMm) * 100).toFixed(2)}%` : '2px',
    );
    stageCard.dataset.stock = state.stock;
    $('designs').dataset.stock = state.stock;
  }

  function renderDesigns(): void {
    const box = $('designs');
    box.textContent = '';
    const { widthMm, heightMm } = cardDims();
    for (const d of designsFor(state.kind)) {
      const meta = FRONT_DESIGNS[d];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'design';
      btn.dataset.design = d;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(design() === d));
      const thumb = document.createElement('canvas');
      const ppm = 7;
      thumb.width = Math.round(widthMm * ppm);
      thumb.height = Math.round(heightMm * ppm);
      thumb.style.aspectRatio = `${widthMm} / ${heightMm}`;
      drawFront(thumb.getContext('2d')!, frontInput(d), ppm);
      const label = document.createElement('strong');
      label.textContent = meta.label;
      const blurb = document.createElement('span');
      blurb.textContent = meta.blurb;
      btn.append(thumb, label, blurb);
      btn.addEventListener('click', () => {
        state.design[state.kind] = d;
        refreshFront();
      });
      box.appendChild(btn);
    }
  }

  function updateDownloads(): void {
    const front = frontReady();
    const back = !!state.renderInput;
    $<HTMLButtonElement>('dl-front-png').disabled = !front;
    $<HTMLButtonElement>('dl-front-svg').disabled = !front;
    $<HTMLButtonElement>('dl-back-png').disabled = !back;
    $<HTMLButtonElement>('dl-svg').disabled = !back;
    $<HTMLButtonElement>('hear-card').disabled = !back || hearing;
    $('download-note').textContent = !state.pcm
      ? 'Add the sound first.'
      : state.kind === 'heartbeat' && !state.photo
        ? 'Add the ultrasound scan to download the front.'
        : back
          ? ''
          : 'Building the back…';
  }

  function updateSummary(): void {
    const el = $('card-summary');
    const plan = state.renderInput?.plan;
    if (!state.pcm) {
      el.textContent = 'A sample of the front. Add a sound to make it yours.';
    } else if (!plan) {
      el.textContent = 'Building the codes for the back…';
    } else {
      const seconds = (state.trim.endSec - state.trim.startSec).toFixed(1);
      const what = state.kind === 'voice' ? 'of voice' : 'of heartbeat';
      el.textContent =
        `${seconds} seconds ${what} in ${plan.chunkCount} codes, with ${plan.moduleMm.toFixed(2)} mm dots. ` +
        (state.stock === 'black' ? 'Shown as it engraves on black metal.' : 'Shown as it engraves on a light card.');
    }
  }

  /** Front-only changes — text, design, photo — redraw without re-encoding. */
  function refreshFront(): void {
    shapeStage();
    drawStageFront();
    renderDesigns();
    updateDownloads();
  }

  function refreshAll(): void {
    refreshFront();
    drawStageBack();
    updateSummary();
    updateStats();
  }

  // --- kind ---

  function setKind(kind: FrontKind): void {
    if (state.kind === kind) return;
    state.kind = kind;
    for (const b of root.querySelectorAll<HTMLButtonElement>('.kind')) {
      b.setAttribute('aria-checked', String(b.dataset.kind === kind));
    }
    const heart = kind === 'heartbeat';
    $('voice-field').hidden = heart;
    // With no voice field beside it, the date takes the full row.
    $('recorded-date').closest('.field')!.classList.toggle('field-wide', heart);
    $('photo-field').hidden = !heart;
    $<HTMLInputElement>('text-line').placeholder = heart ? 'Baby Grace' : 'For Mom';
    $('drop-main').textContent = heart
      ? 'Drop the heartbeat recording here, or choose it'
      : 'Drop an audio or video file here, or choose one';
    $('drop-sub').textContent = heart
      ? 'From the ultrasound visit or a home doppler. Most phone recordings work.'
      : 'MP3, M4A, WAV and most phone recordings work.';
    if (kind === 'voice' && state.pcm && mimiOk) warmUpMimi('encoder');
    // The back belongs to the old kind's codec until the new encode lands.
    clearBack();
    refreshAll();
    scheduleUpdate();
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>('.kind')) {
    b.addEventListener('click', () => setKind(b.dataset.kind as FrontKind));
  }

  // --- face toggle ---

  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-face]')) {
    b.addEventListener('click', () => {
      stageCard.dataset.face = b.dataset.face!;
      for (const o of root.querySelectorAll<HTMLButtonElement>('button[data-face]')) {
        o.setAttribute('aria-pressed', String(o === b));
      }
    });
  }

  // --- audio in ---

  const dropzone = $('dropzone');
  const fileInput = $<HTMLInputElement>('file-input');

  async function loadBlob(blob: Blob, fileName?: string): Promise<void> {
    setError(null);
    $('audio-status').textContent = 'Reading the file…';
    try {
      const f32 = await fileToFloat32(blob);
      const prepared = preparePcm(f32, PCM_SAMPLE_RATE);
      const durationSec = prepared.pcm.length / PCM_SAMPLE_RATE;
      if (durationSec < 0.3) throw new Error('That clip is too short.');
      const dropped = prepared.trimmedLeadSec + prepared.trimmedTailSec;
      stopHearing();
      state.pcm = prepared.pcm;
      state.cardId = randomCardId();
      pcmEpoch++;
      encodeCache.clear();
      if (state.kind === 'voice' && mimiOk) warmUpMimi('encoder');
      const label = fileName ? `${fileName}, ${durationSec.toFixed(1)} s` : `${durationSec.toFixed(1)} s recorded`;
      $('audio-status').textContent = label + (dropped >= 0.3 ? ` (${dropped.toFixed(1)} s of silence dropped)` : '');
      $('trim-wrap').hidden = false;
      trimHandle = attachTrim($<HTMLCanvasElement>('waveform'), prepared.pcm, (t) => {
        state.trim = t;
        updateTrimHint();
        refreshFront();
        scheduleUpdate();
      });
      state.trim = trimHandle.state;
      updateTrimHint();
      $<HTMLButtonElement>('preview-btn').disabled = false;
      $<HTMLButtonElement>('download-wav-btn').disabled = false;
      clearBack();
      refreshAll();
      scheduleUpdate();
    } catch (e) {
      state.pcm = null;
      $('audio-status').textContent = '';
      $<HTMLButtonElement>('download-wav-btn').disabled = true;
      setError(
        e instanceof Error && e.message.includes('short')
          ? e.message
          : "That file couldn't be read. Try an MP3, M4A, WAV, OGG, FLAC or WebM file.",
      );
    }
  }

  function updateTrimHint(): void {
    const dur = state.pcm ? state.pcm.length / PCM_SAMPLE_RATE : 0;
    const sel = state.trim.endSec - state.trim.startSec;
    $('trim-hint').textContent =
      sel < dur - 0.05
        ? `${sel.toFixed(1)} of ${dur.toFixed(1)} seconds go on the card. Drag the window, or its edges, to choose which.`
        : `The whole clip, ${dur.toFixed(1)} seconds, goes on the card.`;
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void loadBlob(f, f.name);
  });
  for (const ev of ['dragover', 'dragleave', 'drop'] as const) {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.toggle('over', ev === 'dragover');
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
      recorder = await startRecording(
        (ms) => {
          recordBtn.textContent = `Stop, ${Math.min(MAX_SECONDS, ms / 1000).toFixed(1)} s`;
        },
        { raw: state.kind === 'heartbeat' },
      );
      recordBtn.classList.add('recording');
      recordBtn.textContent = 'Stop, 0.0 s';
      const blob = await recorder.blob;
      recorder = null;
      recordBtn.classList.remove('recording');
      recordBtn.textContent = 'Record';
      await loadBlob(blob);
    } catch {
      recorder = null;
      recordBtn.classList.remove('recording');
      recordBtn.textContent = 'Record';
      setError('The microphone is blocked. Allow it in the browser, or choose a file instead.');
    }
  });

  $('preview-btn').addEventListener('click', () => {
    if (!state.pcm) return;
    stopHearing();
    playback?.stop();
    playback = playPcm(slicePcm(state.pcm, state.trim.startSec, state.trim.endSec));
  });

  $('download-wav-btn').addEventListener('click', () => {
    if (!state.pcm) return;
    const sliced = slicePcm(state.pcm, state.trim.startSec, state.trim.endSec);
    downloadBlob(pcmToWavBlob(sliced, PCM_SAMPLE_RATE), 'momento-clip.wav');
  });

  // --- details ---

  $<HTMLInputElement>('text-line').addEventListener('input', (e) => {
    state.textLine = (e.target as HTMLInputElement).value;
    refreshFront();
  });
  $<HTMLInputElement>('voice-line').addEventListener('input', (e) => {
    state.voice = (e.target as HTMLInputElement).value;
    refreshFront();
  });
  const recordedInput = $<HTMLInputElement>('recorded-date');
  recordedInput.value = state.recordedAt;
  recordedInput.addEventListener('input', (e) => {
    state.recordedAt = (e.target as HTMLInputElement).value;
    refreshFront();
  });

  const photoInput = $<HTMLInputElement>('photo-input');
  $('photo-btn').addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    try {
      const bitmap = await decodePhoto(file);
      state.photoBitmap?.close();
      state.photoBitmap = bitmap;
      state.photo = tonePhoto(bitmap, state.stock === 'black');
      $('photo-status').textContent = 'Scan added. It stays in this tab.';
      $('photo-btn').textContent = 'Choose a different scan';
      setError(null);
      refreshFront();
    } catch {
      setError("That photo couldn't be read. Try a JPEG or PNG.");
    }
  });

  for (const b of root.querySelectorAll<HTMLButtonElement>('button[data-stock]')) {
    b.addEventListener('click', () => {
      const stock = b.dataset.stock as Stock;
      if (stock === state.stock) return;
      state.stock = stock;
      for (const o of root.querySelectorAll<HTMLButtonElement>('button[data-stock]')) {
        o.setAttribute('aria-checked', String(o === b));
      }
      // Both faces follow the stock together: the photo's negative and the
      // codes' inversion are one decision.
      if (state.photoBitmap) state.photo = tonePhoto(state.photoBitmap, stock === 'black');
      refreshFront();
      updateSummary();
      scheduleUpdate();
    });
  }

  // --- engraving settings ---

  $<HTMLSelectElement>('size-select').addEventListener('change', (e) => {
    state.cardSize = (e.target as HTMLSelectElement).value as CardSizeKey;
    refreshFront();
    scheduleUpdate();
  });
  $<HTMLSelectElement>('burn-select').addEventListener('change', (e) => {
    state.burnMm = Number((e.target as HTMLSelectElement).value);
    scheduleUpdate();
  });
  $<HTMLInputElement>('texture-toggle').addEventListener('change', (e) => {
    state.textured = (e.target as HTMLInputElement).checked;
    scheduleUpdate();
  });
  $('test-scan').addEventListener('click', () => {
    const h = $('test-hint');
    h.hidden = !h.hidden;
  });

  // --- the back: encode → plan → codes ---

  function clearBack(): void {
    state.renderInput = null;
    state.encoded = null;
    state.tier = null;
    drawStageBack();
    updateDownloads();
  }

  function scheduleUpdate(): void {
    clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => void update(), 250);
  }

  async function update(): Promise<void> {
    if (!state.pcm) return;
    const seq = ++encodeSeq;
    setError(null);
    updateSummary();
    try {
      const t = tier();
      const seconds = state.trim.endSec - state.trim.startSec;
      if (t.codec === 'mimi' && !mimiOk) {
        throw new Error("This browser can't run the voice model. Open this page in an up-to-date Chrome, Safari or Firefox.");
      }
      if (!tierFits(seconds, t, cardSpec())) {
        throw new Error(`This card holds up to ${maxSecondsForTier(t, cardSpec()).toFixed(1)} seconds. Trim the clip to fit.`);
      }
      const depth = depthFor(t);
      const key = cacheKey(t, depth);
      let encoded = encodeCache.get(key)?.bytes;
      if (!encoded) {
        const pcm = slicePcm(state.pcm, state.trim.startSec, state.trim.endSec);
        try {
          encoded = await encodeForTier(t, pcm, depth);
        } catch (err) {
          if (t.codec === 'mimi' && !(err instanceof MimiTimeoutError || err instanceof MimiDownloadError)) {
            throw new Error(MIMI_FAILED, { cause: err });
          }
          throw err;
        }
        if (seq !== encodeSeq) return;
        rememberEncode(key, { bytes: encoded });
      }
      const plan = planCard(encoded.length, cardSpec());
      if (plan.moduleMm < MODULE_FLOOR_MM) {
        throw new Error('This clip came out too large for a card that scans. Trim it a little shorter.');
      }
      const chunks = splitPayload(encoded, t.wireVersion, modeIdForTier(t, depth), plan.payloadPerChunk, state.cardId);
      if (seq !== encodeSeq) return;
      state.tier = t;
      state.depth = depth;
      state.encoded = encoded;
      state.renderInput = {
        plan,
        matrices: chunks.map((c) => chunkMatrix(c, plan.qrVersion)),
        entry: entryMatrix(playerUrl()),
        inverted: state.stock === 'black',
        burnMm: state.burnMm,
        texture: state.textured ? { seed: state.cardId } : undefined,
      };
      drawStageBack();
      updateSummary();
      updateStats();
      updateDownloads();
      renderWarnings();
    } catch (e) {
      if (seq !== encodeSeq) return;
      // No card rather than a stale one.
      clearBack();
      console.error('Momento: could not build the card', e);
      $('card-summary').textContent = 'No back yet.';
      setError(
        e instanceof MimiDownloadError
          ? "The voice model didn't download. Check the connection and try again."
          : e instanceof MimiTimeoutError
            ? 'The voice model stopped responding on this device. Reload the page and try again, or use another browser.'
            : e instanceof Error
              ? e.message
              : 'Something went wrong while building the card.',
      );
    }
  }

  function renderWarnings(): void {
    const w = $('warnings');
    w.textContent = '';
    if (state.renderInput?.plan.warnings.includes('texture-cramped')) {
      const div = document.createElement('p');
      div.className = 'note';
      div.textContent =
        'This clip fills the card, so the pixel field only reaches the margins. The codes keep their full quiet zones.';
      w.appendChild(div);
    }
  }

  function updateStats(): void {
    const { renderInput, tier: t, encoded, depth } = state;
    const el = $('stats-line');
    if (!renderInput || !t || !encoded) {
      el.textContent = '';
      return;
    }
    const { plan } = renderInput;
    const codec =
      t.codec === 'mimi'
        ? `Mimi ${((depth * MIMI_CODE_BITS * MIMI_FRAME_RATE) / 1000).toFixed(2)} kbps (${depth} codes/frame)`
        : 'Pulse heartbeat codec 1.4 kbps';
    const field = cardTexture(renderInput);
    el.textContent =
      `${codec}, ${encoded.length} bytes in ${plan.chunkCount} data codes (QR v${plan.qrVersion}) + 1 entry code, ` +
      `${plan.moduleMm.toFixed(2)}mm modules on a ${plan.grid.cols}×${plan.grid.rows} grid` +
      (field ? `, +${(field.coverage * 100).toFixed(0)}% engraved area for the texture` : '');
  }

  // --- hear this card: the scanner's own decode ---

  function stopHearing(): void {
    playback?.stop();
    playback = null;
  }

  $('hear-card').addEventListener('click', async () => {
    const t = state.tier;
    const btn = $<HTMLButtonElement>('hear-card');
    if (!t || !state.encoded || hearing) return;
    hearing = true;
    btn.disabled = true;
    btn.textContent = t.codec === 'mimi' ? 'Rebuilding the voice…' : 'Rebuilding…';
    try {
      const key = cacheKey(t, state.depth);
      const cached = encodeCache.get(key);
      let restored = cached?.restored;
      if (!restored) {
        restored = await decodeForPlayback(t.wireVersion, modeIdForTier(t, state.depth), state.encoded, (msg) => {
          btn.textContent = msg;
        });
        rememberEncode(key, { bytes: state.encoded, restored });
      }
      stopHearing();
      btn.textContent = 'Playing…';
      const pb = playPcm(restored.pcm, restored.sampleRate);
      playback = pb;
      await pb.done;
    } catch (e) {
      console.error('Momento: preview failed', e);
      setError(
        e instanceof MimiDownloadError
          ? "The voice model didn't download. Check the connection and try again."
          : t.codec === 'mimi'
            ? MIMI_FAILED
            : "This card couldn't be played back here.",
      );
    } finally {
      hearing = false;
      btn.textContent = 'Hear this card';
      updateDownloads();
    }
  });

  // --- downloads ---

  $('dl-back-png').addEventListener('click', () => {
    const r = state.renderInput;
    if (!r) return;
    const c = document.createElement('canvas');
    c.width = Math.round(r.plan.widthMm * PX_PER_MM);
    c.height = Math.round(r.plan.heightMm * PX_PER_MM);
    drawCard(c.getContext('2d')!, r, PX_PER_MM);
    downloadPng(c, 'momento-card-back.png');
  });
  $('dl-svg').addEventListener('click', () => {
    if (!state.renderInput) return;
    downloadBlob(new Blob([renderSvg(state.renderInput)], { type: 'image/svg+xml' }), 'momento-card-back.svg');
  });
  $('dl-front-png').addEventListener('click', () => {
    if (!frontReady()) return;
    const { widthMm, heightMm } = cardDims();
    const c = document.createElement('canvas');
    c.width = Math.round(widthMm * PX_PER_MM);
    c.height = Math.round(heightMm * PX_PER_MM);
    drawFront(c.getContext('2d')!, frontInput(), PX_PER_MM);
    downloadPng(c, 'momento-card-front.png');
  });
  $('dl-front-svg').addEventListener('click', () => {
    if (!frontReady()) return;
    downloadBlob(new Blob([renderFrontSvg(frontInput())], { type: 'image/svg+xml' }), 'momento-card-front.svg');
  });

  // --- first paint ---

  refreshAll();
  // The card's type is drawn on canvas, which only uses a web font once it has
  // loaded; redraw when Cormorant arrives so the preview matches the export.
  void Promise.all(
    Object.values(FONT_FAMILIES).map((fam) => document.fonts?.load(`500 20px ${fam}`).catch(() => undefined)),
  ).then(() => refreshFront());
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      drawStageFront();
      drawStageBack();
    }, 150);
  });
}

/** A two-lobed voice-like envelope for the sample front shown before a sound. */
function sampleBars(count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / Math.max(1, count - 1);
    const lobes = Math.abs(Math.sin(Math.PI * t * 2.2)) * 0.75 + 0.25 * Math.abs(Math.sin(Math.PI * t * 9.3));
    const env = Math.sin(Math.PI * t) ** 0.6;
    return Math.max(0.045, Math.min(1, lobes * env * 1.15));
  });
}

const SAMPLE_HEARTBEAT = { bpm: 148, beats: [1, 0.86, 0.95, 0.9] };

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The URL engraved in every card's entry code: the scanner home page. Fixed,
 * since an engraved card can never change; VITE_PLAYER_URL overrides it. */
const PLAYER_URL = 'https://k.gabefen.com/';

function playerUrl(): string {
  return (import.meta.env.VITE_PLAYER_URL as string | undefined) || PLAYER_URL;
}

/** A canvas as a PNG that knows its physical size, so laser software imports
 * it at exactly card size. */
function downloadPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    void blob.arrayBuffer().then((buf) => {
      downloadBlob(new Blob([pngWithDpi(new Uint8Array(buf), PNG_DPI)], { type: 'image/png' }), filename);
    });
  }, 'image/png');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
