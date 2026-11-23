// The extraction: the card's codes come apart into the sound they hold.
//
// Everything on screen is real. The dots in the codes are the bits read off
// the card, in order; each one flies to its place in time along the clip
// (the codecs write the sound front to back, so byte order is time order);
// and the bars they finally stack into are the envelope of the audio that was
// actually rebuilt. It runs while decoding does, so it costs no extra wait:
//
//   gather  0–420 ms     the codes settle onto the stage
//   read    300–1000 ms  a beam sweeps across them, lighting what it reads
//   release 850–1700 ms  the dots lift off and stream onto the centre line
//   hold    …            they shimmer there until the sound is ready
//   form    +700 ms      they stack into the waveform, which solidifies
//
// Afterwards the waveform stays put and traces playback.


export interface Extraction {
  /** Form the waveform from the rebuilt sound; resolves once it has settled. */
  finish(pcm: Int16Array, sampleRate: number): Promise<void>;
  /** Paint playback progress (0–1) onto the settled waveform. */
  setProgress(p: number): void;
  /** Stop animating (the stage is being replaced). */
  stop(): void;
}

const MODULES = 21; // a version-1 QR's worth of modules per drawn code
const T_GATHER = 420;
const T_READ0 = 300;
const T_READ1 = 1000;
const T_REL0 = 850;
const T_REL1 = 1700;
const T_FORM = 700;

interface Dot {
  /** home in the codes, CSS px */
  hx: number;
  hy: number;
  /** spot on the centre line, as a fraction of the clip */
  t: number;
  /** release delay within the release window, 0–1 */
  delay: number;
  /** arc height for the flight */
  arc: number;
  /** shimmer phase */
  phase: number;
  /** stacking slot within its bar, −1…1 (set at form time) */
  slot: number;
  bar: number;
}

/** Bar heights for the stage: the loudest 10 ms within each bar (so a beat
 * or a syllable reads as a peak, not an average), normalised, then curved to
 * keep the quiet between beats and words visibly low. */
function displayBars(pcm: Int16Array, sampleRate: number, count: number): number[] {
  const hop = Math.max(1, Math.round(sampleRate / 100));
  const frames = Math.max(1, Math.floor(pcm.length / hop));
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let j = f * hop; j < (f + 1) * hop; j++) sum += (pcm[j]! / 32768) ** 2;
    env[f] = Math.sqrt(sum / hop);
  }
  const out = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) {
    const a = Math.floor((i * frames) / count);
    const b = Math.max(a + 1, Math.floor(((i + 1) * frames) / count));
    let peak = 0;
    for (let f = a; f < b && f < frames; f++) peak = Math.max(peak, env[f]!);
    out[i] = peak;
  }
  const sorted = [...out].sort((x, y) => x - y);
  const ref = sorted[Math.floor(sorted.length * 0.97)] || 1;
  return out.map((v) => Math.max(0.035, Math.min(1, v / ref) ** 1.5));
}

const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number): number => 1 - (1 - x) ** 3;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Module grid for one drawn code: finder patterns in three corners like a
 * real QR, and the card's own bits everywhere else. */
function codeModules(bits: (i: number) => boolean, offset: number): { grid: boolean[]; used: number } {
  const n = MODULES;
  const grid = new Array<boolean>(n * n).fill(false);
  const finder = (r: number, c: number): boolean | null => {
    for (const [fr, fc] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      const y = r - fr;
      const x = c - fc;
      if (y >= -1 && y <= 7 && x >= -1 && x <= 7) {
        if (y < 0 || y > 6 || x < 0 || x > 6) return false; // separator
        const ring = Math.min(y, x, 6 - y, 6 - x);
        return ring !== 1;
      }
    }
    return null;
  };
  let used = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const f = finder(r, c);
      grid[r * n + c] = f ?? bits(offset + used++);
    }
  }
  return { grid, used };
}

export function startExtraction(host: HTMLElement, data: Uint8Array, codes: number): Extraction {
  const canvas = document.createElement('canvas');
  canvas.className = 'extract';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'The codes on the card coming apart into the sound they hold');
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const css = getComputedStyle(host);
  const ink = css.getPropertyValue('--accent').trim() || '#d9cebd';
  const glow = css.getPropertyValue('--text').trim() || '#ece6dc';

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let W = 0;
  let H = 0;
  const resize = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth || host.clientWidth || 320;
    H = canvas.clientHeight || 220;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  // --- the codes, laid out like the card's grid ---
  const count = Math.max(2, Math.min(8, codes));
  const cols = count <= 4 ? count : Math.ceil(count / 2);
  const rows = Math.ceil(count / cols);
  const gap = 0.16; // of a code's size
  const size = Math.min((W * 0.92) / (cols + (cols - 1) * gap), (H * 0.86) / (rows + (rows - 1) * gap));
  const mod = size / MODULES;
  const gridW = cols * size + (cols - 1) * gap * size;
  const gridH = rows * size + (rows - 1) * gap * size;
  const x0 = (W - gridW) / 2;
  const y0 = (H - gridH) / 2;

  const totalBits = Math.max(1, data.length * 8);
  // Spread the card's bits across the drawn codes so every dot comes from
  // its own stretch of the sound.
  const perCode = Math.floor(totalBits / count);
  const bitAt = (i: number): boolean => {
    const b = Math.min(totalBits - 1, i);
    return ((data[b >> 3]! >> (7 - (b & 7))) & 1) === 1;
  };

  const dots: Dot[] = [];
  const finders: Array<[number, number]> = [];
  for (let k = 0; k < count; k++) {
    const cx = x0 + (k % cols) * size * (1 + gap);
    const cy = y0 + Math.floor(k / cols) * size * (1 + gap);
    const base = k * perCode;
    const stride = Math.max(1, Math.floor(perCode / (MODULES * MODULES)));
    const { grid } = codeModules((i) => bitAt(base + i * stride), 0);
    for (let r = 0; r < MODULES; r++) {
      for (let c = 0; c < MODULES; c++) {
        if (!grid[r * MODULES + c]) continue;
        const hx = cx + (c + 0.5) * mod;
        const hy = cy + (r + 0.5) * mod;
        const isFinder =
          (r < 7 && c < 7) || (r < 7 && c >= MODULES - 7) || (r >= MODULES - 7 && c < 7);
        if (isFinder) {
          finders.push([hx, hy]);
          continue;
        }
        dots.push({
          hx,
          hy,
          t: k, // placed along the clip below, once the code's dots are counted
          delay: 0.55 * (k / Math.max(1, count - 1)) * 0.6 + Math.random() * 0.4,
          arc: (Math.random() - 0.5) * H * 0.5,
          phase: Math.random() * Math.PI * 2,
          slot: 0,
          bar: 0,
        });
      }
    }
  }
  // Where in the clip each dot's bits live: its code's stretch, then its
  // reading order within the code — evenly, so the line has no seams.
  for (let k = 0; k < count; k++) {
    const mine = dots.filter((d) => d.t === k);
    mine.forEach((d, i) => {
      d.t = (k + (i + 0.5) / mine.length) / count;
    });
  }

  // --- the waveform ---
  const barCount = Math.max(36, Math.min(80, Math.floor(W / 6.5)));
  const waveL = W * 0.04;
  const waveW = W * 0.92;
  const mid = H / 2;
  const barX = (i: number): number => waveL + ((i + 0.5) / barCount) * waveW;
  let bars: number[] | null = null;
  let progress = -1;

  let start = performance.now();
  let formAt = -1;
  let raf = 0;
  let stopped = false;
  let settle: (() => void) | null = null;

  const lineX = (t: number): number => waveL + t * waveW;

  function drawCodes(now: number): void {
    const g = clamp01(now / T_GATHER);
    const beam = clamp01((now - T_READ0) / (T_READ1 - T_READ0));
    const beamX = x0 - size * 0.2 + beam * (gridW + size * 0.4);
    const rel = clamp01((now - T_REL0) / (T_REL1 - T_REL0));
    // finder patterns: they frame the code, then fade as the data leaves
    ctx.globalAlpha = easeOut(g) * (1 - easeInOut(clamp01(rel * 1.6)));
    ctx.fillStyle = ink;
    for (const [x, y] of finders) ctx.fillRect(x - mod * 0.45, y - mod * 0.45, mod * 0.9, mod * 0.9);
    if (beam > 0 && beam < 1) {
      const grad = ctx.createLinearGradient(beamX - size * 0.5, 0, beamX + 6, 0);
      grad.addColorStop(0, 'rgba(236,230,220,0)');
      grad.addColorStop(1, 'rgba(236,230,220,0.22)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(beamX - size * 0.5, y0 - mod * 2, size * 0.5 + 6, gridH + mod * 4);
      ctx.fillStyle = glow;
      ctx.fillRect(beamX, y0 - mod * 2, 1.2, gridH + mod * 4);
    }
    ctx.globalAlpha = 1;
  }

  function frame(): void {
    if (stopped) return;
    const now = reduced ? Math.max(performance.now() - start, T_REL1 + 10) : performance.now() - start;
    ctx.clearRect(0, 0, W, H);

    const g = clamp01(now / T_GATHER);
    const beam = clamp01((now - T_READ0) / (T_READ1 - T_READ0));
    const beamX = x0 - size * 0.2 + beam * (gridW + size * 0.4);
    const formT = formAt < 0 ? 0 : clamp01((now - formAt) / T_FORM);

    drawCodes(now);

    // the centre line the dots land on
    const lineIn = clamp01((now - T_REL0) / 500);
    if (lineIn > 0 && formT < 1) {
      ctx.globalAlpha = 0.18 * lineIn * (1 - formT);
      ctx.fillStyle = ink;
      ctx.fillRect(waveL, mid - 0.5, waveW, 1);
      ctx.globalAlpha = 1;
    }

    // dots
    const r = Math.max(0.9, mod * 0.42);
    for (const d of dots) {
      const relRaw = (now - T_REL0) / (T_REL1 - T_REL0);
      const p = easeInOut(clamp01((relRaw - d.delay * 0.55) / 0.45));
      const lit = d.hx < beamX && beam > 0 ? 1 : 0;
      // flight from home to the centre line along an arc
      const tx = lineX(d.t);
      const shimmer = Math.sin(now / 260 + d.phase + d.t * 9) * H * 0.018 * p;
      let x = d.hx + (tx - d.hx) * p;
      let y = d.hy + (mid - d.hy) * p + Math.sin(Math.PI * p) * d.arc + shimmer;
      if (formT > 0 && bars) {
        const f = easeInOut(formT);
        const amp = bars[d.bar]! * H * 0.38;
        x += (barX(d.bar) - x) * f;
        y += (mid + d.slot * amp - y) * f;
      }
      const alpha = easeOut(g) * (formT > 0 ? 1 - clamp01((formT - 0.55) / 0.45) : 1);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = lit && p < 0.05 ? glow : ink;
      const s = p < 1 ? mod * 0.9 * (1 - p) + r * 2 * p : r * 2;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    // the solid waveform fading up under the stacked dots
    if (bars && formT > 0.35) {
      drawBars(clamp01((formT - 0.35) / 0.65));
    }

    if (formT >= 1) {
      drawSettled();
      settle?.();
      settle = null;
      return; // done: further paints come from setProgress
    }
    raf = requestAnimationFrame(frame);
  }

  function drawBars(alpha: number): void {
    if (!bars) return;
    const w = Math.max(1.2, (waveW / barCount) * 0.38);
    ctx.lineCap = 'round';
    ctx.lineWidth = w;
    for (let i = 0; i < barCount; i++) {
      const amp = Math.max(w / 2, bars[i]! * H * 0.38);
      const played = progress >= 0 && (i + 0.5) / barCount <= progress;
      ctx.globalAlpha = alpha * (progress >= 0 && !played ? 0.38 : 1);
      ctx.strokeStyle = played ? glow : ink;
      ctx.beginPath();
      ctx.moveTo(barX(i), mid - amp);
      ctx.lineTo(barX(i), mid + amp);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawSettled(): void {
    ctx.clearRect(0, 0, W, H);
    drawBars(1);
  }

  raf = requestAnimationFrame(frame);

  return {
    finish(pcm, sampleRate) {
      bars = displayBars(pcm, sampleRate, barCount);
      // Stack each dot into the bar for its moment in the clip, spread evenly
      // from the bar's foot to its crest.
      const perBar = new Array<number>(barCount).fill(0);
      for (const d of dots) {
        d.bar = Math.min(barCount - 1, Math.floor(d.t * barCount));
        perBar[d.bar]!++;
      }
      const seen = new Array<number>(barCount).fill(0);
      for (const d of dots) {
        const n = perBar[d.bar]!;
        d.slot = n > 1 ? (seen[d.bar]!++ / (n - 1)) * 2 - 1 : 0;
      }
      return new Promise<void>((resolve) => {
        settle = resolve;
        // Never form before the dots have landed: a fast decode (heartbeat
        // cards decode instantly) still gets the whole story.
        const now = performance.now() - start;
        const landed = reduced ? 0 : T_REL1 + 150;
        formAt = Math.max(now, landed);
        if (reduced) {
          start = performance.now() - formAt - T_FORM;
        }
        if (stopped) resolve();
      });
    },
    setProgress(p) {
      progress = p;
      if (!stopped && settle === null && formAt >= 0) drawSettled();
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      settle?.();
    },
  };
}
