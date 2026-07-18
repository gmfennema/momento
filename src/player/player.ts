// Player (consumer-facing) page: scan the whole card, rebuild the audio, play.
// States: IDLE → SCANNING → DECODING → READY → PLAYING (+ CAMERA_DENIED).

import { audioContext, playPcm, type Playback } from '../lib/audio';
import { codec2Decode } from '../lib/codec2';
import { MODE_BY_ID } from '../lib/chunk';
import { startScanner, type ScannerHandle } from './scanner';

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

  function showIdle(): void {
    stage.innerHTML = `
      <button class="primary" id="start" style="font-size:1.1rem; padding:0.9rem 2rem">📷 Scan the card</button>
      <p class="hint">Point your camera at the card and pan slowly across all the squares.</p>
    `;
    stage.querySelector('#start')!.addEventListener('click', () => {
      audioContext(); // unlock audio inside the user gesture
      void showScanning();
    });
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
          const { got, total, missing } = scanner.collector.progress;
          if (result === 'wrong-card') {
            count.textContent = 'Two cards in view?';
            return;
          }
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
          scanStage.classList.remove('flash');
          void scanStage.offsetWidth; // restart the animation
          scanStage.classList.add('flash');
        },
        onComplete() {
          void showDecoding();
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

  function showCameraDenied(): void {
    stage.innerHTML = `
      <div class="error" style="text-align:left">
        <strong>Camera access is needed to read the card.</strong><br/>
        Enable camera permission for this site in your browser settings, then try again.
        On iPhone: Settings → Safari → Camera → Allow.
      </div>
      <button class="primary" id="retry" style="margin-top:1rem">Try again</button>
    `;
    stage.querySelector('#retry')!.addEventListener('click', () => void showScanning());
  }

  async function showDecoding(): Promise<void> {
    stage.innerHTML = `<p class="hint">Rebuilding the audio from the card…</p>`;
    try {
      const { modeId, data } = scanner!.collector.assemble();
      scanner = null;
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
