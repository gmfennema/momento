// Player (consumer-facing) page: scan the whole card, rebuild the audio, play.
// Two entry paths — live camera scan, or uploaded photo(s) of the card.
// States: IDLE → SCANNING | PHOTOS → DECODING → READY → PLAYING (+ CAMERA_DENIED).

import { playPcm, type Playback } from '../lib/audio';
import { codec2Decode } from '../lib/codec2';
import { ChunkCollector, MODE_BY_ID } from '../lib/chunk';
import { scanPhoto, startScanner, type ScannerHandle } from './scanner';

export function mountPlayer(root: HTMLElement): void {
  root.innerHTML = `
    <div class="player">
      <h1><span class="logo">●</span> Momento</h1>
      <p class="tagline">This card holds a sound. Scan every code on it to listen — the audio exists nowhere else.</p>
      <div id="stage"></div>
    </div>
  `;
  const stage = root.querySelector<HTMLElement>('#stage')!;
  let scanner: ScannerHandle | null = null;
  let playback: Playback | null = null;
  let pcm: Int16Array | null = null;

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
        <button class="primary" id="start" style="font-size:1.1rem; padding:0.9rem 2rem">📷 Scan the card</button>
        <button id="upload" style="font-size:1.1rem; padding:0.9rem 2rem">🖼️ Upload a photo</button>
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
          <div class="coach">Hold 15–25 cm away · pan slowly over every square</div>
        </div>
      </div>
      <button id="cancel">Cancel</button>
    `;
    const scanStage = stage.querySelector<HTMLElement>('#scan-stage')!;
    const count = stage.querySelector<HTMLElement>('#count')!;
    const strip = stage.querySelector<HTMLElement>('#strip')!;
    stage.querySelector('#cancel')!.addEventListener('click', () => {
      scanner?.stop();
      scanner = null;
      showIdle();
    });

    try {
      scanner = await startScanner({
        onChunk(result) {
          if (!scanner) return;
          if (result === 'wrong-card') {
            count.textContent = 'Two cards in view?';
            return;
          }
          updateProgress(count, strip, scanner.collector);
          scanStage.classList.remove('flash');
          void scanStage.offsetWidth; // restart the animation
          scanStage.classList.add('flash');
        },
        onComplete() {
          void showDecoding(scanner!.collector);
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
          void showDecoding(collector);
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

    await process(files);
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
        <button id="upload">🖼️ Upload a photo instead</button>
      </div>
    `;
    stage.querySelector('#retry')!.addEventListener('click', () => void showScanning());
    const input = makePhotoInput((files) => {
      void showPhotos(new ChunkCollector(), files);
    });
    stage.appendChild(input);
    stage.querySelector('#upload')!.addEventListener('click', () => input.click());
  }

  async function showDecoding(collector: ChunkCollector): Promise<void> {
    scanner = null;
    stage.innerHTML = `<p class="hint">Rebuilding the audio from the card…</p>`;
    try {
      const { modeId, data } = collector.assemble();
      pcm = await codec2Decode(MODE_BY_ID[modeId]!, data);
      showReady();
    } catch {
      stage.innerHTML = `<div class="error">Couldn't rebuild the audio — please rescan the card.</div>`;
      setTimeout(showIdle, 2500);
    }
  }

  function showReady(): void {
    const seconds = pcm ? (pcm.length / 8000).toFixed(1) : '?';
    stage.innerHTML = `
      <button class="big-play" id="play">▶</button>
      <p class="hint">${seconds}s of audio, rebuilt entirely from the card.</p>
      <button id="again">Scan another card</button>
    `;
    const playBtn = stage.querySelector<HTMLButtonElement>('#play')!;
    playBtn.addEventListener('click', () => {
      if (!pcm) return;
      playback?.stop();
      playBtn.textContent = '…';
      playback = playPcm(pcm);
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

  showIdle();
}
