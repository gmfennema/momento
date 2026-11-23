// Player (consumer-facing) page: scan the whole card, rebuild the audio, play.
// Two entry paths — live camera scan, or uploaded photo(s) of the card.
// States: IDLE → SCANNING | PHOTOS → DECODING → READY → PLAYING (+ CAMERA_DENIED).

import { playPcm, type Playback } from '../lib/audio';
import { MimiDownloadError, MimiTimeoutError, warmUpMimi } from '../lib/mimi';
import { decodeForPlayback, UnknownCardError, type Restoration } from '../lib/restore';
import { ChunkCollector, WIRE_MIMI, WIRE_PULSE } from '../lib/chunk';
import { brandHeader } from '../lib/brand';
import { scanPhoto, startScanner, type ScannerHandle } from './scanner';
import { startExtraction, type Extraction } from './extract';

const icon = (body: string): string =>
  `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** The insert card from the box: three steps and three promises. */
const HOW_IT_WORKS = `
  <section class="insert" aria-labelledby="how-title">
    <h2 id="how-title">How it works</h2>
    <ol class="steps">
      <li>${icon('<path d="M5 11V6h5M22 6h5v5M27 21v5h-5M10 26H5v-5"/>')}
        <div><strong>Scan</strong><span>Scan every code on the back of the card.</span></div></li>
      <li>${icon('<rect x="10" y="4" width="12" height="24" rx="2.5"/><path d="M14.5 24.5h3"/>')}
        <div><strong>Build</strong><span>This page reads the codes and rebuilds the sound, right on your phone.</span></div></li>
      <li>${icon('<circle cx="16" cy="16" r="11.5"/><path d="M13.5 11.5v9l7-4.5z"/>')}
        <div><strong>Listen</strong><span>Hear the moment again, anytime you scan.</span></div></li>
    </ol>
    <ul class="promises">
      <li>${icon('<path d="M16 6 4 12l12 6 12-6z"/><path d="m4 17 12 6 12-6"/>')}Stored on the card</li>
      <li>${icon('<circle cx="16" cy="16" r="10"/><path d="M9 23 23 9"/>')}No subscriptions</li>
      <li>${icon('<path d="M16 16c-2.6-3.3-4.4-5-6.8-5a5 5 0 0 0 0 10c2.4 0 4.2-1.7 6.8-5s4.4-5 6.8-5a5 5 0 0 1 0 10c-2.4 0-4.2-1.7-6.8-5z"/>')}Yours to keep</li>
    </ul>
  </section>`;

export function mountPlayer(root: HTMLElement): void {
  root.innerHTML = `
    <div class="player">
      ${brandHeader()}
      <p class="lede">This card holds a sound. Scan every code on its back to listen —
        the audio exists nowhere else.</p>
      <div id="stage"></div>
    </div>
  `;
  const stage = root.querySelector<HTMLElement>('#stage')!;
  let scanner: ScannerHandle | null = null;
  let playback: Playback | null = null;
  let extraction: Extraction | null = null;
  let pcm: Int16Array | null = null;
  let pcmRate = 16000;
  let restoration: Restoration = 'mimi';

  function makePhotoInput(onFiles: (files: File[]) => void): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      if (files.length) onFiles(files);
    });
    return input;
  }

  function updateProgress(count: HTMLElement, strip: HTMLElement, collector: ChunkCollector): void {
    // The first chunk names the codec — fetch the Mimi decoder (~60 MB) only
    // for voice cards, overlapping the download with the remaining scan.
    // Heartbeat cards need no download.
    if (collector.wireVersion === WIRE_MIMI) warmUpMimi('decoder');
    const { got, total, missing } = collector.progress;
    count.textContent = total ? `${got} of ${total}` : 'Looking…';
    if (total && strip.childElementCount !== total) {
      strip.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.dataset.i = String(i);
        strip.appendChild(seg);
      }
    }
    strip.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
      seg.classList.toggle('got', !missing.includes(Number(seg.dataset.i)));
    });
  }

  function showIdle(): void {
    stage.innerHTML = `
      <div class="entry-choices">
        <button class="primary" id="start">Scan the card</button>
        <button id="upload">Upload a photo</button>
      </div>
      <p class="hint">Point your camera at the card and pan slowly across all the squares —
        or upload a clear photo that shows every square.</p>
      ${HOW_IT_WORKS}
    `;
    stage.querySelector('#start')!.addEventListener('click', () => {
      void showScanning();
    });
    const input = makePhotoInput((files) => {
      void showPhotos(new ChunkCollector(), files);
    });
    stage.appendChild(input);
    stage.querySelector('#upload')!.addEventListener('click', () => input.click());
  }

  async function showScanning(): Promise<void> {
    stage.innerHTML = `
      <div class="scan-stage" id="scan-stage">
        <div class="scan-overlay">
          <div class="progress-count" id="count">Looking…</div>
          <div class="progress-strip" id="strip"></div>
          <div class="coach" id="coach">${COACH_START}</div>
        </div>
      </div>
      <div class="row" style="justify-content:center">
        <button id="photo">Take a photo instead</button>
        <button id="cancel">Cancel</button>
      </div>
    `;
    const scanStage = stage.querySelector<HTMLElement>('#scan-stage')!;
    const count = stage.querySelector<HTMLElement>('#count')!;
    const strip = stage.querySelector<HTMLElement>('#strip')!;
    const coach = stage.querySelector<HTMLElement>('#coach')!;
    // A scan that has gone quiet gets a nudge toward what actually helps: more
    // pixels on the dots, or the photo route (the phone's own camera app
    // focuses closer and shoots far sharper than a video frame).
    let lastProgressAt = Date.now();
    const nudge = setInterval(() => {
      if (!coach.isConnected) return clearInterval(nudge);
      if (Date.now() - lastProgressAt > STUCK_AFTER_MS) coach.textContent = COACH_STUCK;
    }, 1000);
    const leave = (): ChunkCollector | null => {
      clearInterval(nudge);
      const collector = scanner?.collector ?? null;
      scanner?.stop();
      scanner = null;
      return collector;
    };
    stage.querySelector('#cancel')!.addEventListener('click', () => {
      leave();
      showIdle();
    });
    // Squares already read stay read: the photo only has to cover the rest.
    // The live camera is released first — a phone won't lend it to its own
    // camera app while this page still holds it.
    stage.querySelector('#photo')!.addEventListener('click', () => {
      void showPhotos(leave() ?? new ChunkCollector(), []);
    });

    try {
      scanner = await startScanner({
        onChunk(result) {
          if (!scanner) return;
          if (result === 'wrong-card') {
            count.textContent = 'Two cards in view?';
            return;
          }
          lastProgressAt = Date.now();
          coach.textContent = COACH_START;
          updateProgress(count, strip, scanner.collector);
          scanStage.classList.remove('flash');
          void scanStage.offsetWidth; // restart the animation
          scanStage.classList.add('flash');
        },
        onComplete() {
          clearInterval(nudge);
          void showDecoding(scanner!.collector.assemble());
        },
        onReaderBroken() {
          coach.textContent = COACH_BROKEN;
        },
      });
      scanStage.prepend(scanner.video);
      if (await scanner.torch.available) {
        const btn = document.createElement('button');
        btn.className = 'torch-btn';
        btn.textContent = '🔦';
        btn.addEventListener('click', () => void scanner?.torch.toggle());
        scanStage.querySelector('.scan-overlay')!.appendChild(btn);
      }
    } catch {
      clearInterval(nudge);
      showCameraDenied();
    }
  }

  async function showPhotos(collector: ChunkCollector, files: File[]): Promise<void> {
    stage.innerHTML = `
      <div class="photo-stage">
        <div class="progress-count" id="count">Looking…</div>
        <div class="progress-strip" id="strip"></div>
        <p class="hint" id="photo-msg">Reading photo…</p>
        <div class="row" style="justify-content:center; margin-top:0.75rem">
          <button class="primary" id="add-photo" disabled>Add another photo</button>
          <button id="restart">Start over</button>
        </div>
      </div>
    `;
    const count = stage.querySelector<HTMLElement>('#count')!;
    const strip = stage.querySelector<HTMLElement>('#strip')!;
    const msg = stage.querySelector<HTMLElement>('#photo-msg')!;
    const addBtn = stage.querySelector<HTMLButtonElement>('#add-photo')!;
    let alive = true;
    stage.querySelector('#restart')!.addEventListener('click', () => {
      alive = false;
      showIdle();
    });
    const input = makePhotoInput((more) => {
      void process(more);
    });
    stage.appendChild(input);
    addBtn.addEventListener('click', () => input.click());

    async function process(batch: File[]): Promise<void> {
      addBtn.disabled = true;
      addBtn.textContent = 'Add another photo';
      msg.textContent = batch.length > 1 ? `Reading ${batch.length} photos…` : 'Reading photo…';
      let chunks = 0;
      let wrongCard = false;
      for (const file of batch) {
        if (!alive) return;
        try {
          const result = await scanPhoto(file, collector);
          chunks += result.chunks;
          wrongCard ||= result.wrongCard;
        } catch {
          // unreadable file — reported below via chunks === 0
        }
        if (!alive) return;
        updateProgress(count, strip, collector);
        if (collector.complete) {
          void showDecoding(collector.assemble());
          return;
        }
      }
      addBtn.disabled = false;
      const { got, total, missing } = collector.progress;
      if (chunks === 0) {
        msg.textContent = wrongCard
          ? 'That photo seems to show a different card — keep to one card at a time.'
          : 'No Kept codes found in that photo. Try a sharper, closer shot in good light.';
      } else if (total && got < total) {
        msg.textContent = `Still missing ${missing.length} square${missing.length === 1 ? '' : 's'} — add another photo covering the rest of the card.`;
      }
    }

    if (files.length) {
      await process(files);
      return;
    }
    // Arrived from the live scan with no photo yet: show what was already
    // read and open the picker (still inside the tap that brought us here).
    updateProgress(count, strip, collector);
    msg.textContent = 'Take a sharp, close photo of the whole card in good light.';
    addBtn.textContent = 'Take a photo';
    addBtn.disabled = false;
    input.click();
  }

  function showCameraDenied(): void {
    stage.innerHTML = `
      <div class="error" style="text-align:left">
        <strong>Camera access is needed to scan the card live.</strong><br/>
        Enable camera permission for this site in your browser settings, then try again.
        On iPhone: Settings → Safari → Camera → Allow.
      </div>
      <div class="row" style="justify-content:center; margin-top:1rem">
        <button class="primary" id="retry">Try again</button>
        <button id="upload">Upload a photo instead</button>
      </div>
    `;
    stage.querySelector('#retry')!.addEventListener('click', () => void showScanning());
    const input = makePhotoInput((files) => {
      void showPhotos(new ChunkCollector(), files);
    });
    stage.appendChild(input);
    stage.querySelector('#upload')!.addEventListener('click', () => input.click());
  }

  async function showDecoding(card: AssembledCard): Promise<void> {
    scanner = null;
    // The card says what it holds: its format version names the codec, so a
    // heartbeat card and a voice card each get their own words from here on.
    const what = card.version === WIRE_PULSE ? 'heartbeat' : 'voice';
    stage.innerHTML = `
      <div class="extract-stage" id="extract-stage"></div>
      <p class="hint extract-note" aria-live="polite">Reading the card…</p>`;
    const note = stage.querySelector<HTMLElement>('.extract-note')!;
    // The codes come apart into the sound while it is being rebuilt.
    extraction?.stop();
    const ext = startExtraction(stage.querySelector<HTMLElement>('#extract-stage')!, card.data, card.chunks);
    extraction = ext;
    let statusShown = false;
    const caption = setTimeout(() => {
      if (!statusShown) note.textContent = `Extracting the ${what} from the card…`;
    }, 850);
    try {
      const { version, modeId, data } = card;
      // Same pipeline the generator previews with.
      const restored = await decodeForPlayback(version, modeId, data, (msg) => {
        // Only the long first-time fetch is worth a word over the animation.
        if (msg.includes('MB')) {
          statusShown = true;
          note.textContent = msg;
        }
      });
      pcm = restored.pcm;
      pcmRate = restored.sampleRate;
      restoration = restored.restoration;
      clearStashedCard();
      clearTimeout(caption);
      note.textContent = `Extracting the ${what} from the card…`;
      await ext.finish(restored.pcm, restored.sampleRate);
      if (extraction !== ext) return; // the listener moved on mid-animation
      showReady();
    } catch (e) {
      // The screens below are deliberately plain; the console keeps the cause
      // for anyone debugging a phone over USB.
      console.error('Kept: could not rebuild the audio', e);
      clearTimeout(caption);
      ext.stop();
      extraction = null;
      clearStashedCard(); // the timeout branch below re-stashes; nothing else should resume
      if (e instanceof UnknownCardError) {
        // A format this build doesn't know — decoding it anyway would play
        // garbage, so be honest instead.
        stage.innerHTML = `<div class="error">This card was made with a newer version of Kept — refresh this page and try again.</div>`;
        setTimeout(showIdle, 4000);
        return;
      }
      if (e instanceof MimiTimeoutError) {
        // The model runtime stopped answering, and it can't be restarted
        // in-page. Carry the scanned bytes (≤ 2 KB) across a reload so the
        // listener doesn't have to rescan.
        stashCard(card);
        stage.innerHTML = `<div class="error">The voice model stopped responding on this device.</div>
          <button id="retry" class="primary">Reload and try again</button>
          <button id="again">Scan another card</button>`;
        stage.querySelector('#retry')!.addEventListener('click', () => location.reload());
        stage.querySelector('#again')!.addEventListener('click', () => {
          clearStashedCard();
          showIdle();
        });
        return;
      }
      if (e instanceof MimiDownloadError) {
        // The codes were read fine; the model download failed. Keep the scan
        // and let the listener retry rather than rescanning.
        stage.innerHTML = `<div class="error">Couldn't fetch the voice model — check the connection.</div>
          <button id="retry" class="primary">Try again</button>`;
        stage.querySelector('#retry')!.addEventListener('click', () => void showDecoding(card));
        return;
      }
      if (card.version === WIRE_MIMI) {
        // The codes were read fine; the voice model itself failed (out of
        // memory, a runtime that won't start). Never fall back to something
        // that sounds worse — say so, keep the scan, and offer a retry.
        stashCard(card);
        stage.innerHTML = `<div class="error">The voice model couldn't run on this phone. Reload and try again — if it keeps failing, open this page in another browser.</div>
          <button id="retry" class="primary">Reload and try again</button>
          <button id="again">Scan another card</button>`;
        stage.querySelector('#retry')!.addEventListener('click', () => location.reload());
        stage.querySelector('#again')!.addEventListener('click', () => {
          clearStashedCard();
          showIdle();
        });
        return;
      }
      stage.innerHTML = `<div class="error">Couldn't rebuild the audio — please rescan the card.</div>`;
      setTimeout(showIdle, 2500);
    }
  }

  function showReady(): void {
    const seconds = pcm ? (pcm.length / pcmRate).toFixed(1) : '?';
    const holds =
      restoration === 'pulse'
        ? `A ${seconds}-second heartbeat, rebuilt entirely from the card.`
        : `${seconds} seconds of voice, rebuilt entirely from the card.`;
    // CC-BY attribution for the model every Mimi listener downloads.
    const creditNote =
      restoration === 'mimi'
        ? `<p class="hint">Voice decoded with Kyutai's <a href="https://huggingface.co/kyutai/mimi" target="_blank" rel="noreferrer">Mimi</a> codec (<a href="${import.meta.env.BASE_URL}mimi/NOTICE.md" target="_blank">CC-BY-4.0</a>).</p>`
        : '';
    // The waveform the codes became stays on stage and traces playback.
    const wave = stage.querySelector<HTMLElement>('#extract-stage');
    stage.innerHTML = `
      <div id="wave-slot"></div>
      <button class="big-play" id="play" aria-label="Play">▶</button>
      <p class="hint" id="holds">${holds}</p>
      ${creditNote}
      <button id="again">Scan another card</button>
    `;
    const ext = extraction;
    if (wave && ext) {
      wave.classList.add('settled');
      stage.querySelector('#wave-slot')!.replaceWith(wave);
    } else {
      stage.querySelector('#wave-slot')!.remove();
    }
    const playBtn = stage.querySelector<HTMLButtonElement>('#play')!;
    let tracer = 0;
    playBtn.addEventListener('click', () => {
      if (!pcm) return;
      playback?.stop();
      cancelAnimationFrame(tracer);
      playBtn.textContent = '…';
      const current = playPcm(pcm, pcmRate);
      playback = current;
      const trace = (): void => {
        ext?.setProgress(current.progress());
        tracer = requestAnimationFrame(trace);
      };
      if (ext) trace();
      void current.done.then(() => {
        if (playback !== current) return;
        cancelAnimationFrame(tracer);
        ext?.setProgress(-1);
        playBtn.textContent = '▶';
      });
    });
    stage.querySelector('#again')!.addEventListener('click', () => {
      playback?.stop();
      cancelAnimationFrame(tracer);
      extraction?.stop();
      extraction = null;
      pcm = null;
      showIdle();
    });
  }

  // A card stashed before a reload (see the MimiTimeoutError path) resumes
  // straight into decoding.
  const resumed = takeStashedCard();
  if (resumed) void showDecoding(resumed);
  else showIdle();
}

const COACH_START = 'Fill the screen with the card · hold steady in good light';
const COACH_STUCK = 'Stuck? Turn the phone sideways so the card fills the screen — or take a photo instead';
const COACH_BROKEN = "Live scanning isn't working on this device — take a photo instead";
const STUCK_AFTER_MS = 8000;

type AssembledCard = ReturnType<ChunkCollector['assemble']>;
const STASH_KEY = 'momento-pending-card';

function clearStashedCard(): void {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    // nothing stashed that we could reach anyway
  }
}

function stashCard(card: AssembledCard): void {
  try {
    sessionStorage.setItem(
      STASH_KEY,
      JSON.stringify({ version: card.version, modeId: card.modeId, data: Array.from(card.data), chunks: card.chunks }),
    );
  } catch {
    // storage unavailable — the reload just means a rescan
  }
}

/** The stash outlives the resumed decode (it is cleared once audio is ready),
 * so a reload that lands mid-decode — e.g. a service-worker update — resumes
 * again instead of losing the card. */
function takeStashedCard(): AssembledCard | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const { version, modeId, data, chunks } = JSON.parse(raw) as { version: number; modeId: number; data: number[]; chunks?: number };
    return { version, modeId, data: Uint8Array.from(data), chunks: chunks ?? 5 };
  } catch {
    return null;
  }
}
