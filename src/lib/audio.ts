// Browser-only audio helpers: decode/resample to Codec2's 8 kHz mono PCM,
// playback via Web Audio, waveform drawing.

import { CODEC2_SAMPLE_RATE } from './codec2';

export const MAX_SECONDS = 10;

let sharedCtx: AudioContext | null = null;
export function audioContext(): AudioContext {
  sharedCtx ??= new AudioContext();
  void sharedCtx.resume();
  return sharedCtx;
}

/** Decode any audio blob/file and resample to 8 kHz mono Int16 PCM. */
export async function fileToPcm8k(file: Blob): Promise<{ pcm: Int16Array; durationSec: number }> {
  const arrayBuf = await file.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    void decodeCtx.close();
  }
  const targetLen = Math.ceil(decoded.duration * CODEC2_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, targetLen, CODEC2_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const f32 = rendered.getChannelData(0);
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i]! * 32767)));
  }
  return { pcm, durationSec: rendered.duration };
}

export function slicePcm(pcm: Int16Array, startSec: number, endSec: number): Int16Array {
  const a = Math.max(0, Math.floor(startSec * CODEC2_SAMPLE_RATE));
  const b = Math.min(pcm.length, Math.ceil(endSec * CODEC2_SAMPLE_RATE));
  return pcm.slice(a, b);
}

export interface Playback {
  stop(): void;
  done: Promise<void>;
}

/** Play 8 kHz PCM. Call from a user gesture the first time (autoplay policy). */
export function playPcm(pcm: Int16Array): Playback {
  const ctx = audioContext();
  const buffer = ctx.createBuffer(1, pcm.length, CODEC2_SAMPLE_RATE);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const done = new Promise<void>((resolve) => {
    src.onended = () => resolve();
  });
  src.start();
  return { stop: () => src.stop(), done };
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  pcm: Int16Array,
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

  const durationSec = pcm.length / CODEC2_SAMPLE_RATE;
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
