// Pulse — a tiny noise vocoder for doppler heartbeat recordings (fetal
// heartbeats from an ultrasound or a home doppler).
//
// Why not a speech codec: a doppler heartbeat is the ultrasound echo of many
// moving scatterers, so it is shaped noise — "whoosh-whoosh" with sharp onsets
// and silent gaps, almost all of it between 150 Hz and 2.5 kHz. Codec 2 hunts
// for a voice pitch that isn't there, and Mimi (trained on speech) paints
// harmonic stripes through the whooshes and drops the onset clicks. Pulse
// instead sends exactly what defines the sound:
//
//   - the clip's average spectrum, once (16 log-spaced bands, 100 Hz–4 kHz)
//   - loudness every 10 ms (keeps the onsets and the gaps between beats sharp)
//   - how the spectrum leans away from the average every 20 ms (6 DCT terms)
//
// and the player rebuilds it from shaped noise. 175 B/s — a full 10 s clip fits
// the card at a large dot size, the encoder and decoder are a few hundred lines
// of math with no model download, and both run in node tests.
//
// Bitstream (MSB-first, zero-padded to a byte):
//   11 bits         frame count T (10 ms frames)
//   16 × 6 bits     average spectrum, in 1.5 dB steps below its loudest band
//   per frame t:    5 bits loudness, in 2 dB steps below the loudest frame
//                   (31 = silence); then, on even t only, 6 × 3 bits shape
//                   terms in 3 dB steps (two's-complement offset by 4)

import { irfft, rfft } from './fft';

export const PULSE_SAMPLE_RATE = 16000;
const HOP = 160; // 10 ms
const WIN = 320; // 20 ms Hann, 50% overlap
const NFFT = 512;
const BANDS = 16;
const F_LO = 100;
const F_HI = 4000;
const TERMS = 6; // DCT terms 1..6 (term 0 is the loudness, sent separately)
const SHAPE_EVERY = 2;

const FRAME_BITS = 11;
const MEAN_BITS = 6;
const MEAN_STEP = 1.5;
const GAIN_BITS = 5;
const GAIN_STEP = 2;
const GAIN_SILENT = (1 << GAIN_BITS) - 1;
const TERM_BITS = 3;
const TERM_STEP = 3;
const TERM_OFFSET = 1 << (TERM_BITS - 1);
/** Analysis floor: anything this far below the clip's loudest band is silence. */
const FLOOR_DB = 70;
/** Absolute floor (dB per bin of the windowed frame): below this is digital silence. */
const SILENCE_DB = -80;

export const PULSE_MAX_FRAMES = (1 << FRAME_BITS) - 1;

/** Exact payload size for a clip of `frames` 10 ms frames. */
export function pulsePayloadBytes(frames: number): number {
  const bits =
    FRAME_BITS + BANDS * MEAN_BITS + frames * GAIN_BITS + Math.ceil(frames / SHAPE_EVERY) * TERMS * TERM_BITS;
  return Math.ceil(bits / 8);
}

/** 10 ms frames in a clip of `samples` 16 kHz samples. */
export function pulseFrames(samples: number): number {
  return Math.ceil(samples / HOP);
}

// --- shared tables ---

const EDGES = Array.from({ length: BANDS + 1 }, (_, i) => F_LO * Math.pow(F_HI / F_LO, i / BANDS));
const CENTERS = Array.from({ length: BANDS }, (_, b) => Math.sqrt(EDGES[b]! * EDGES[b + 1]!));
const BINS = NFFT / 2 + 1;
const BIN_HZ = PULSE_SAMPLE_RATE / NFFT;
/** FFT bins in each band; every band is wider than one bin, so none is empty. */
const BAND_BINS: number[][] = Array.from({ length: BANDS }, (_, b) => {
  const out: number[] = [];
  for (let k = 0; k < BINS; k++) {
    const f = k * BIN_HZ;
    if (f >= EDGES[b]! && f < EDGES[b + 1]!) out.push(k);
  }
  return out;
});
const WINDOW = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN));
const COS: number[][] = Array.from({ length: TERMS }, (_, k) =>
  Array.from({ length: BANDS }, (_, n) => Math.cos((Math.PI * (k + 1) * (n + 0.5)) / BANDS)),
);

/** Frame t is centred on sample t·HOP. */
function frameSpectrum(x: ArrayLike<number>, t: number): { re: Float64Array; im: Float64Array } {
  const buf = new Float64Array(WIN);
  const start = t * HOP - WIN / 2;
  for (let i = 0; i < WIN; i++) {
    const j = start + i;
    if (j >= 0 && j < x.length) buf[i] = x[j]! * WINDOW[i]!;
  }
  return rfft(buf, NFFT);
}

// --- bit io ---

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  finish(): Uint8Array {
    if (this.n) this.bytes.push(this.acc << (8 - this.n));
    return Uint8Array.from(this.bytes);
  }
}

class BitReader {
  private pos = 0;
  constructor(private data: Uint8Array) {}
  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.data[this.pos >> 3];
      if (byte === undefined) throw new Error('pulse: truncated payload');
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// --- encoder ---

export function pulseEncode(pcm: Int16Array): Uint8Array {
  const x = Float64Array.from(pcm, (v) => v / 32768);
  const T = Math.min(PULSE_MAX_FRAMES, Math.max(1, pulseFrames(x.length)));

  // Band log-energies per frame, floored FLOOR_DB below the loudest.
  const E: Float64Array[] = [];
  let top = -Infinity;
  for (let t = 0; t < T; t++) {
    const { re, im } = frameSpectrum(x, t);
    const e = new Float64Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      let p = 0;
      for (const k of BAND_BINS[b]!) p += re[k]! * re[k]! + im[k]! * im[k]!;
      e[b] = 10 * Math.log10(p / BAND_BINS[b]!.length + 1e-12);
      if (e[b]! > top) top = e[b]!;
    }
    E.push(e);
  }
  // Also an absolute floor, well under 16-bit dither, so digital silence stays
  // silent instead of being normalized up into noise.
  const floor = Math.max(top - FLOOR_DB, SILENCE_DB);
  for (const e of E) for (let b = 0; b < BANDS; b++) e[b] = Math.max(e[b]!, floor);

  const w = new BitWriter();
  w.write(T, FRAME_BITS);

  // Average spectrum, sent relative to its loudest band (absolute level is
  // irrelevant: playback normalizes).
  const mean = new Float64Array(BANDS);
  for (const e of E) for (let b = 0; b < BANDS; b++) mean[b]! += e[b]! / T;
  const meanTop = Math.max(...mean);
  const meanDec = new Float64Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const q = clamp(Math.round((meanTop - mean[b]!) / MEAN_STEP), 0, (1 << MEAN_BITS) - 1);
    w.write(q, MEAN_BITS);
    meanDec[b] = meanTop - q * MEAN_STEP;
  }

  // Loudness = average lean of a frame above the decoded average spectrum;
  // shape = what's left per band.
  const gain = new Float64Array(T);
  const shape: Float64Array[] = [];
  let gainTop = -Infinity;
  for (let t = 0; t < T; t++) {
    const r = Float64Array.from(E[t]!, (v, b) => v - meanDec[b]!);
    const g = r.reduce((a, v) => a + v, 0) / BANDS;
    gain[t] = g;
    if (g > gainTop) gainTop = g;
    shape.push(r.map((v) => v - g));
  }
  // A frame at the analysis floor everywhere is silence, whatever its gain.
  const silentGain = floor + 0.5;

  for (let t = 0; t < T; t++) {
    const floorFrame = E[t]!.every((v) => v <= silentGain);
    const gq = floorFrame
      ? GAIN_SILENT
      : clamp(Math.round((gainTop - gain[t]!) / GAIN_STEP), 0, GAIN_SILENT - 1);
    w.write(gq, GAIN_BITS);
    if (t % SHAPE_EVERY === 0) {
      // Sampled, not smoothed: the onset clicks last only a frame or two, and
      // averaging neighbours blurs them away (checked on a real recording).
      const cur = shape[t]!;
      for (let k = 0; k < TERMS; k++) {
        let c = 0;
        for (let n = 0; n < BANDS; n++) c += cur[n]! * COS[k]![n]!;
        c *= 2 / BANDS;
        const q = clamp(Math.round(c / TERM_STEP), -TERM_OFFSET, TERM_OFFSET - 1);
        w.write(q + TERM_OFFSET, TERM_BITS);
      }
    }
  }
  return w.finish();
}

// --- decoder ---

/** Deterministic noise, so a card plays the same every time it is scanned. */
function noise(n: number, seed: number): Float64Array {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(1e-12, rand());
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}

export function pulseDecode(data: Uint8Array): Int16Array {
  const r = new BitReader(data);
  const T = r.read(FRAME_BITS);
  if (T === 0) return new Int16Array(0);
  const mean = new Float64Array(BANDS);
  for (let b = 0; b < BANDS; b++) mean[b] = -r.read(MEAN_BITS) * MEAN_STEP;

  const gain = new Float64Array(T);
  const keyShapes: Float64Array[] = [];
  for (let t = 0; t < T; t++) {
    const gq = r.read(GAIN_BITS);
    gain[t] = gq === GAIN_SILENT ? -Infinity : -gq * GAIN_STEP;
    if (t % SHAPE_EVERY === 0) {
      const sh = new Float64Array(BANDS);
      for (let k = 0; k < TERMS; k++) {
        const c = (r.read(TERM_BITS) - TERM_OFFSET) * TERM_STEP;
        for (let n = 0; n < BANDS; n++) sh[n]! += c * COS[k]![n]!;
      }
      keyShapes.push(sh);
    }
  }

  // Band levels per frame → per-bin magnitudes, interpolated in log-frequency
  // between band centres (silent outside them).
  const logC = CENTERS.map(Math.log);
  const binMap = Array.from({ length: BINS }, (_, k) => {
    const lf = Math.log(Math.max(1, k * BIN_HZ));
    if (lf < logC[0]! || lf > logC[BANDS - 1]!) return null;
    let b = 0;
    while (b < BANDS - 2 && lf > logC[b + 1]!) b++;
    return { b, f: (lf - logC[b]!) / (logC[b + 1]! - logC[b]!) };
  });

  const n = T * HOP;
  const src = noise(n + WIN, 0x6d6f6d);
  // Unit mean power per bin, matching the analysis' per-bin band energies.
  const frames: Array<{ re: Float64Array; im: Float64Array }> = [];
  let power = 0;
  for (let t = 0; t < T; t++) {
    const s = frameSpectrum(src, t);
    for (let k = 0; k < BINS; k++) power += s.re[k]! * s.re[k]! + s.im[k]! * s.im[k]!;
    frames.push(s);
  }
  const norm = 1 / Math.sqrt(power / (T * BINS));

  const out = new Float64Array(n + WIN);
  const wsum = new Float64Array(n + WIN);
  const level = new Float64Array(BANDS);
  for (let t = 0; t < T; t++) {
    const s = frames[t]!;
    if (gain[t] !== -Infinity) {
      const i0 = Math.floor(t / SHAPE_EVERY);
      const a = keyShapes[i0]!;
      const bShape = keyShapes[Math.min(keyShapes.length - 1, i0 + 1)]!;
      const f = (t % SHAPE_EVERY) / SHAPE_EVERY;
      for (let b = 0; b < BANDS; b++) level[b] = mean[b]! + gain[t]! + a[b]! * (1 - f) + bShape[b]! * f;
      for (let k = 0; k < BINS; k++) {
        const m = binMap[k];
        const g = m ? Math.pow(10, (level[m.b]! * (1 - m.f) + level[m.b + 1]! * m.f) / 20) * norm : 0;
        s.re[k]! *= g;
        s.im[k]! *= g;
      }
    } else {
      s.re.fill(0);
      s.im.fill(0);
    }
    const frame = irfft(s, NFFT);
    const start = t * HOP; // out[] is offset by WIN/2 so frame starts are ≥ 0
    for (let i = 0; i < WIN; i++) {
      out[start + i]! += frame[i]! * WINDOW[i]!;
      wsum[start + i]! += WINDOW[i]! * WINDOW[i]!;
    }
  }

  let peak = 0;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = i + WIN / 2;
    y[i] = wsum[j]! > 1e-6 ? out[j]! / wsum[j]! : 0;
    peak = Math.max(peak, Math.abs(y[i]!));
  }
  const scale = peak > 0 ? (0.89 * 32767) / peak : 0;
  return Int16Array.from(y, (v) => Math.round(v * scale));
}
