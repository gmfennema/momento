// Camera frame loop: grab frames, hand them to zxing-wasm (multiple QR codes
// per frame), feed decoded text into the ChunkCollector. Decode calls are
// serialized — frames arriving while one is in flight are skipped.

import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { base45Decode } from '../lib/base45';
import { ChunkCollector, type AddResult } from '../lib/chunk';

// Self-hosted wasm (copied to public/zxing/ at install time) so the PWA works
// offline and nothing is pulled from a CDN.
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith('.wasm') ? `${import.meta.env.BASE_URL}zxing/${path}` : prefix + path,
  },
});

export interface ScannerCallbacks {
  onChunk(result: AddResult): void;
  onComplete(): void;
}

export interface PhotoScanResult {
  /** Momento chunks decoded from the photo (new or already-seen). */
  chunks: number;
  newChunks: number;
  wrongCard: boolean;
}

// iOS Safari caps canvas dimensions around 4096; larger photos also make
// zxing needlessly slow, and card codes stay readable well below this.
const MAX_PHOTO_DIM = 4096;

async function loadPhoto(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Some formats (e.g. HEIC on Safari) decode via <img> but not createImageBitmap.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Read every QR code in an uploaded photo and feed them into the collector. */
export async function scanPhoto(file: File, collector: ChunkCollector): Promise<PhotoScanResult> {
  const photo = await loadPhoto(file);
  const w = photo instanceof HTMLImageElement ? photo.naturalWidth : photo.width;
  const h = photo instanceof HTMLImageElement ? photo.naturalHeight : photo.height;
  if (!w || !h) throw new Error('empty image');
  const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
  if ('close' in photo) photo.close();

  const results = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), {
    formats: ['QRCode'],
    tryHarder: true,
    tryInvert: true,
    maxNumberOfSymbols: 128,
  });

  const summary: PhotoScanResult = { chunks: 0, newChunks: 0, wrongCard: false };
  for (const r of results) {
    let bytes: Uint8Array;
    try {
      bytes = base45Decode(r.text);
    } catch {
      continue; // entry QR / foreign code
    }
    const outcome = collector.add(bytes);
    if (outcome === 'new') {
      summary.chunks++;
      summary.newChunks++;
    } else if (outcome === 'duplicate') {
      summary.chunks++;
    } else if (outcome === 'wrong-card') {
      summary.wrongCard = true;
    }
  }
  return summary;
}

export interface ScannerHandle {
  video: HTMLVideoElement;
  collector: ChunkCollector;
  stop(): void;
  torch: {
    available: Promise<boolean>;
    toggle(): Promise<boolean>;
  };
}

export async function startScanner(cb: ScannerCallbacks): Promise<ScannerHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'environment',
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });

  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.autoplay = true;
  video.srcObject = stream;
  await video.play();

  const collector = new ChunkCollector();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  let running = true;
  let busy = false;

  async function processFrame(): Promise<void> {
    if (!running || busy || video.videoWidth === 0) return;
    busy = true;
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const results = await readBarcodes(imageData, {
        formats: ['QRCode'],
        tryHarder: true,
        tryInvert: true,
        maxNumberOfSymbols: 24,
      });
      for (const r of results) {
        if (!running) break;
        let bytes: Uint8Array;
        try {
          bytes = base45Decode(r.text);
        } catch {
          continue; // entry QR / foreign code
        }
        const outcome = collector.add(bytes);
        if (outcome === 'new') cb.onChunk(outcome);
        else if (outcome === 'wrong-card') cb.onChunk(outcome);
        if (collector.complete) {
          stop();
          cb.onComplete();
          return;
        }
      }
    } catch {
      // a bad frame is not fatal; keep scanning
    } finally {
      busy = false;
    }
  }

  let rafId = 0;
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const loop = (): void => {
    if (!running) return;
    void processFrame();
    if (useRVFC) {
      (video as HTMLVideoElement & {
        requestVideoFrameCallback(cb: () => void): number;
      }).requestVideoFrameCallback(loop);
    } else {
      rafId = requestAnimationFrame(() => setTimeout(loop, 120));
    }
  };
  loop();

  function stop(): void {
    running = false;
    cancelAnimationFrame(rafId);
    stream.getTracks().forEach((t) => t.stop());
  }

  const track = stream.getVideoTracks()[0];
  let torchOn = false;
  const torch = {
    available: (async () => {
      try {
        const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
        return !!caps?.torch;
      } catch {
        return false;
      }
    })(),
    async toggle(): Promise<boolean> {
      torchOn = !torchOn;
      try {
        await track?.applyConstraints({ advanced: [{ torch: torchOn } as MediaTrackConstraintSet] });
      } catch {
        torchOn = false;
      }
      return torchOn;
    },
  };

  return { video, collector, stop, torch };
}
