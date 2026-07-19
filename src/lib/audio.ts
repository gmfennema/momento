// Browser-only audio helpers: decode/resample to the internal 16 kHz mono
// PCM, playback via Web Audio, waveform drawing.
//
// Everything in the generator runs at 16 kHz (Lyra's wideband rate); the
// Codec 2 path decimates to 8 kHz at encode time (lib/resample.ts).

export const PCM_SAMPLE_RATE = 16000;

export const MAX_SECONDS = 10;

/** Decode any audio blob/file and resample to 16 kHz mono float PCM. */
export async function fileToFloat32(file: Blob): Promise<Float32Array> {
  const arrayBuf = await file.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    void decodeCtx.close();
  }
  const targetLen = Math.ceil(decoded.duration * PCM_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, targetLen, PCM_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  // Copy out — the rendered buffer's storage may be reclaimed with the context.
  return rendered.getChannelData(0).slice();
}

export function float32ToPcm(f32: Float32Array): Int16Array {
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i]! * 32767)));
  }
  return pcm;
}

export function slicePcm(
  pcm: Int16Array,
  startSec: number,
  endSec: number,
  sampleRate = PCM_SAMPLE_RATE,
): Int16Array {
  const a = Math.max(0, Math.floor(startSec * sampleRate));
  const b = Math.min(pcm.length, Math.ceil(endSec * sampleRate));
  return pcm.slice(a, b);
}

export interface Playback {
  stop(): void;
  done: Promise<void>;
}

/** Encode 16-bit mono PCM as a WAV blob. */
export function pcmToWavBlob(pcm: Int16Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeTag = (offset: number, tag: string): void => {
    for (let i = 0; i < tag.length; i++) v.setUint8(offset + i, tag.charCodeAt(i));
  };
  const dataLen = pcm.length * 2;
  writeTag(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeTag(36, 'data');
  v.setUint32(40, dataLen, true);
  const samples = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
  return new Blob([header, samples], { type: 'audio/wav' });
}

/** Play mono PCM. Call from a user gesture the first time (autoplay policy).
 * Uses an <audio> element rather than Web Audio: iOS mutes Web Audio while the
 * ringer switch is on silent and suspends AudioContexts around camera use, but
 * media-element playback is exempt from both. */
export function playPcm(pcm: Int16Array, sampleRate = PCM_SAMPLE_RATE): Playback {
  const url = URL.createObjectURL(pcmToWavBlob(pcm, sampleRate));
  const audio = new Audio(url);
  audio.setAttribute('playsinline', '');
  let finished = false;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (): void => {
    if (finished) return;
    finished = true;
    URL.revokeObjectURL(url);
    settle();
  };
  audio.onended = finish;
  audio.onerror = finish;
  void audio.play().catch(finish);
  return {
    stop: () => {
      audio.pause();
      finish();
    },
    done,
  };
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  pcm: Int16Array,
  sampleRate: number,
  selection?: [number, number], // seconds
): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 80;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const durationSec = pcm.length / sampleRate;
  if (selection) {
    const [a, b] = selection;
    ctx.fillStyle = 'rgba(94, 234, 165, 0.12)';
    ctx.fillRect((a / durationSec) * cssW, 0, ((b - a) / durationSec) * cssW, cssH);
  }

  ctx.strokeStyle = '#5eeaa5';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const samplesPerPx = Math.max(1, Math.floor(pcm.length / cssW));
  for (let x = 0; x < cssW; x++) {
    let min = 0;
    let max = 0;
    const start = x * samplesPerPx;
    for (let i = start; i < Math.min(start + samplesPerPx, pcm.length); i++) {
      const v = pcm[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const mid = cssH / 2;
    ctx.moveTo(x + 0.5, mid - (max / 32768) * mid * 0.95 - 0.5);
    ctx.lineTo(x + 0.5, mid - (min / 32768) * mid * 0.95 + 0.5);
  }
  ctx.stroke();

  if (selection) {
    const [a, b] = selection;
    ctx.fillStyle = '#5eeaa5';
    for (const s of [a, b]) {
      ctx.fillRect((s / durationSec) * cssW - 1, 0, 2, cssH);
    }
  }
}
