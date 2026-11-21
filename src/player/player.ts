// Player (consumer-facing) page: scan the whole card, rebuild the audio, play.
// Two entry paths — live camera scan, or uploaded photo(s) of the card.
// States: IDLE → SCANNING | PHOTOS → DECODING → READY → PLAYING (+ CAMERA_DENIED).

import { playPcm, type Playback } from '../lib/audio';
import { warmUpNeuralBwe } from '../lib/bwe';
import { CODEC2_SAMPLE_RATE } from '../lib/codec2';
import { warmUpLyra } from '../lib/lyra';
import { MimiDownloadError, MimiTimeoutError, warmUpMimi } from '../lib/mimi';
import {
  decodeForPlayback,
  LyraUnavailableError,
  UnknownLyraModeError,
  type Restoration,
} from '../lib/restore';
import { ChunkCollector, WIRE_CODEC2, WIRE_LYRA, WIRE_MIMI } from '../lib/chunk';
import { brandHeader } from '../lib/brand';
import { scanPhoto, startScanner, type ScannerHandle } from './scanner';

export function mountPlayer(root: HTMLElement): void {
  root.innerHTML = `
    <div class="player">
      ${brandHeader(
        'This card holds a sound. Scan every code on it to listen — the audio exists nowhere else.',
      )}
      <div id="stage"></div>
    </div>
  `;
  const stage = root.querySelector<HTMLElement>('#stage')!;
  let scanner: ScannerHandle | null = null;
  let playback: Playback | null = null;
  let pcm: Int16Array | null = null;
  let pcmRate = CODEC2_SAMPLE_RATE;
  let restoration: Restoration = 'lyra';

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
    // The first chunk names the codec — fetch that codec's wasm + models
    // (Mimi decoder ~60 MB, Lyra ~7 MB, neural enhancer ~27 MB) only for
    // cards that actually use them, overlapping the download with the
    // remaining scan.
    if (collector.wireVersion === WIRE_MIMI) warmUpMimi('decoder');
    else if (collector.wireVersion === WIRE_LYRA) warmUpLyra();
    else if (collector.wireVersion === WIRE_CODEC2) warmUpNeuralBwe();
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
          : 'No Momento codes found in that photo. Try a sharper, closer shot in good light.';
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
    stage.innerHTML = `<p class="hint">Rebuilding the audio from the card…</p>`;
    const note = stage.querySelector<HTMLElement>('.hint')!;
    try {
      const { version, modeId, data } = card;
      // Same pipeline the generator previews with, watchdog included: a Codec 2
      // card always gets a restoration, neural when it can finish, DSP when not.
      const restored = await decodeForPlayback(version, modeId, data, (msg) => {
        note.textContent = msg;
      });
      pcm = restored.pcm;
      pcmRate = restored.sampleRate;
      restoration = restored.restoration;
      clearStashedCard();
      showReady();
    } catch (e) {
      // The screens below are deliberately plain; the console keeps the cause
      // for anyone debugging a phone over USB.
      console.error('Momento: could not rebuild the audio', e);
      clearStashedCard(); // the timeout branch below re-stashes; nothing else should resume
      if (e instanceof UnknownLyraModeError) {
        // A reserved Lyra mode from a future generator — decoding it as
        // 3.2 kbps would play garbage, so be honest instead.
        stage.innerHTML = `<div class="error">This card was made with a newer version of Momento — refresh this page and try again.</div>`;
        setTimeout(showIdle, 4000);
        return;
      }
      if (e instanceof LyraUnavailableError) {
        // Most likely the first-ever visit before the isolation service
        // worker kicked in — a reload fixes that; a truly old browser won't.
        stage.innerHTML = `<div class="error">This card's audio needs one more page reload to unlock — reload and scan again. If it keeps happening, update your browser.</div>`;
        setTimeout(showIdle, 5000);
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
      stage.innerHTML = `<div class="error">Couldn't rebuild the audio — please rescan the card.</div>`;
      setTimeout(showIdle, 2500);
    }
  }

  function showReady(): void {
    const seconds = pcm ? (pcm.length / pcmRate).toFixed(1) : '?';
    // Say when the voice came back the plain way, so a listener comparing two
    // phones isn't left wondering why one sounds duller.
    const fallbackNote =
      restoration === 'dsp'
        ? `<p class="hint">Neural restoration wasn't available on this device, so this is the standard restoration.</p>`
        : '';
    // CC-BY attribution for the model every Mimi listener downloads.
    const creditNote =
      restoration === 'mimi'
        ? `<p class="hint">Voice decoded with Kyutai's <a href="https://huggingface.co/kyutai/mimi" target="_blank" rel="noreferrer">Mimi</a> codec (<a href="${import.meta.env.BASE_URL}mimi/NOTICE.md" target="_blank">CC-BY-4.0</a>).</p>`
        : '';
    stage.innerHTML = `
      <button class="big-play" id="play">▶</button>
      <p class="hint">${seconds}s of audio, rebuilt entirely from the card.</p>
      ${fallbackNote}
      ${creditNote}
      <button id="again">Scan another card</button>
    `;
    const playBtn = stage.querySelector<HTMLButtonElement>('#play')!;
    playBtn.addEventListener('click', () => {
      if (!pcm) return;
      playback?.stop();
      playBtn.textContent = '…';
      playback = playPcm(pcm, pcmRate);
      void playback.done.then(() => {
        playBtn.textContent = '▶';
      });
    });
    stage.querySelector('#again')!.addEventListener('click', () => {
      playback?.stop();
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
      JSON.stringify({ version: card.version, modeId: card.modeId, data: Array.from(card.data) }),
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
    const { version, modeId, data } = JSON.parse(raw) as { version: number; modeId: number; data: number[] };
    return { version, modeId, data: Uint8Array.from(data) };
  } catch {
    return null;
  }
}
