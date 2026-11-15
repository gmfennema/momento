// Camera frame loop: grab frames, hand them to zxing-wasm (multiple QR codes
// per frame), feed decoded text into the ChunkCollector. Decode calls are
// serialized — frames arriving while one is in flight are skipped.

import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { chunkBytesFromScan } from '../lib/qr';
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
  /** The reader itself keeps failing (not "no code in view" — an exception on
   * every frame), so live scanning is not going to recover on this device. */
  onReaderBroken?(): void;
}

/** Consecutive reader exceptions before the scan is declared broken. A stray
 * bad frame is normal; a run this long is a dead wasm module or out of memory. */
const READER_FAILURE_LIMIT = 20;

/** Ask the camera for every pixel it has. A full card is ~270 dots wide, so a
 * 1080p frame puts 2–3.5 px on each dot at arm's-length focus distance — the
 * edge of what any reader can do, and where a real phone loses most codes. At
 * 4K the same shot has twice that. `ideal` falls back to the camera's best. */
const CAMERA_TRIES: MediaTrackConstraints[] = [
  { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
  { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
];

async function openCamera(): Promise<MediaStream> {
  let lastError: unknown;
  for (const video of CAMERA_TRIES) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video });
    } catch (e) {
      lastError = e;
      // Permission refusals won't change with a smaller request.
      if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
    }
  }
  throw lastError;
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

/**
 * One way of looking at a frame before handing it to the reader.
 *
 * A laser burns a little wider than its artwork, so on a real card the dots of
 * one colour come out fat and the other thin — a tenth of a millimetre is
 * enough that the reader finds every code and then fails each one's checksum.
 * Thickening the thin colour by a pixel or two before reading undoes that
 * (measured on photos of an engraved card: 0 of 7 codes as shot, 6 of 7 with
 * the dark dots grown). `grow` is that correction in pixels: positive thickens
 * dark, negative thins it. The correction is a physical size, so it is applied
 * to a frame scaled to at most `maxDim`, where 1–3 px spans the useful range.
 */
interface Look {
  maxDim: number;
  grow: number;
}

/** Live scan: one look per camera frame, cycling. The plain full-resolution
 * look comes round most often. */
const LIVE_LOOKS: readonly Look[] = [
  { maxDim: MAX_PHOTO_DIM, grow: 0 },
  { maxDim: 1920, grow: 1 },
  { maxDim: 1920, grow: 2 },
  { maxDim: MAX_PHOTO_DIM, grow: 0 },
  { maxDim: 1920, grow: 3 },
  { maxDim: 1920, grow: -1 },
];

/** A photo gets every look, likeliest first, until the card is complete. */
const PHOTO_LOOKS: readonly Look[] = [
  { maxDim: MAX_PHOTO_DIM, grow: 0 },
  { maxDim: 2048, grow: 1 },
  { maxDim: 2048, grow: 2 },
  { maxDim: 2048, grow: 3 },
  { maxDim: 1280, grow: 1 },
  { maxDim: 1280, grow: 2 },
  { maxDim: 2048, grow: -1 },
  { maxDim: 2048, grow: -2 },
];

type Looker = (src: CanvasImageSource, srcW: number, srcH: number, look: Look) => ImageData;

/** Canvas-only image prep: scaling is a drawImage, and growing dark (or
 * light) is the same image drawn again at small offsets with the `darken` (or
 * `lighten`) blend — a min/max filter without touching pixels in script. */
function makeLooker(): Looker {
  const make = (): CanvasRenderingContext2D =>
    document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const base = make();
  const mid = make();
  const out = make();
  const smear = (
    dst: CanvasRenderingContext2D,
    src: HTMLCanvasElement,
    blend: GlobalCompositeOperation,
    radius: number,
    dx: number,
    dy: number,
  ): void => {
    dst.globalCompositeOperation = 'copy';
    dst.drawImage(src, 0, 0);
    dst.globalCompositeOperation = blend;
    for (let d = 1; d <= radius; d++) {
      dst.drawImage(src, d * dx, d * dy);
      dst.drawImage(src, -d * dx, -d * dy);
    }
  };
  return (src, srcW, srcH, { maxDim, grow }) => {
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    for (const ctx of [base, mid, out]) {
      if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
        ctx.canvas.width = w;
        ctx.canvas.height = h;
      }
    }
    base.globalCompositeOperation = 'copy';
    base.drawImage(src, 0, 0, w, h);
    if (grow === 0) return base.getImageData(0, 0, w, h);
    const blend: GlobalCompositeOperation = grow > 0 ? 'darken' : 'lighten';
    smear(mid, base.canvas, blend, Math.abs(grow), 1, 0);
    smear(out, mid.canvas, blend, Math.abs(grow), 0, 1);
    return out.getImageData(0, 0, w, h);
  };
}

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
  const looker = makeLooker();
  const summary: PhotoScanResult = { chunks: 0, newChunks: 0, wrongCard: false };
  try {
    for (const look of PHOTO_LOOKS) {
      const results = await readBarcodes(looker(photo, w, h, look), {
        formats: ['QRCode'],
        tryHarder: true,
        tryInvert: true,
        maxNumberOfSymbols: 128,
      });
      for (const r of results) {
        const bytes = chunkBytesFromScan(r.text, r.bytes);
        if (!bytes) continue; // entry QR / foreign code
        const outcome = collector.add(bytes);
        if (outcome === 'new') {
          summary.chunks++;
          summary.newChunks++;
        } else if (outcome === 'duplicate') {
          summary.chunks++; // a code seen again in a later look still counts as found
        } else if (outcome === 'wrong-card') {
          summary.wrongCard = true;
        }
      }
      if (collector.complete) break;
    }
  } finally {
    if ('close' in photo) photo.close();
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
  const stream = await openCamera();

  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.autoplay = true;
  video.srcObject = stream;
  await video.play();

  const collector = new ChunkCollector();
  const looker = makeLooker();
  let frameNo = 0;

  let running = true;
  let busy = false;
  let readerFailures = 0;

  async function processFrame(): Promise<void> {
    if (!running || busy || video.videoWidth === 0) return;
    busy = true;
    try {
      const look = LIVE_LOOKS[frameNo++ % LIVE_LOOKS.length]!;
      const imageData = looker(video, video.videoWidth, video.videoHeight, look);
      const results = await readBarcodes(imageData, {
        formats: ['QRCode'],
        tryHarder: true,
        tryInvert: true,
        maxNumberOfSymbols: 24,
      });
      readerFailures = 0;
      for (const r of results) {
        if (!running) break;
        const bytes = chunkBytesFromScan(r.text, r.bytes);
        if (!bytes) continue; // entry QR / foreign code
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
      // a bad frame is not fatal; keep scanning — but say so if it never stops
      if (++readerFailures === READER_FAILURE_LIMIT) cb.onReaderBroken?.();
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
