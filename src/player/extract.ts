// The extraction: the card's codes come apart into the sound they hold.
//
// Everything on screen is real. The dots in the codes are the bits read off
// the card, in order; each one flies to its place in time along the clip
// (the codecs write the sound front to back, so byte order is time order);
// and the bars they finally stack into are the envelope of the audio that was
// actually rebuilt. It runs while decoding does:
//
//   gather  0–800 ms      the codes' modules pop into place
//   read    700–2000 ms   a glowing beam sweeps across, each module flaring as read
//   release 1900–3500 ms  the dots lift off and stream, trailing light, onto a line
//   hold    …             a pulse runs along the line until the sound is ready
//   form    +1300 ms      bars lock in left to right with a spark each, a glow
//                         blooms behind them and a glint crosses the finished wave
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
const T_GATHER = 800;
const T_READ0 = 700;
const T_READ1 = 2000;
const T_REL0 = 1900;
const T_REL1 = 3500;
/** bars lock in over this span, left to right… */
const T_CASCADE = 700;
/** …each taking this long to stack and solidify… */
const T_BAR = 520;
/** …then a glint crosses the finished wave. */
const T_GLINT = 650;
const T_FORM = T_CASCADE + T_BAR + T_GLINT;

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
  /** pop-in delay, ms */
  pop: number;
  /** stacking slot within its bar, −1…1 (set at form time) */
  slot: number;
  bar: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
}

const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number): number => 1 - (1 - x) ** 3;
/** overshoots a little, then settles: the modules' pop */
const easeBack = (x: number): number => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

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

/** Module grid for one drawn code: finder patterns in three corners like a
 * real QR, and the card's own bits everywhere else. */
function codeModules(bits: (i: number) => boolean): boolean[] {
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
        return Math.min(y, x, 6 - y, 6 - x) !== 1;
      }
    }
    return null;
  };
  let used = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) grid[r * n + c] = finder(r, c) ?? bits(used++);
  }
  return grid;
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
  const glow = '#fff8ec';

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || host.clientWidth || 320;
  const H = canvas.clientHeight || 220;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
  const finders: Array<{ x: number; y: number; pop: number }> = [];
  for (let k = 0; k < count; k++) {
    const cx = x0 + (k % cols) * size * (1 + gap);
    const cy = y0 + Math.floor(k / cols) * size * (1 + gap);
    const stride = Math.max(1, Math.floor(perCode / (MODULES * MODULES)));
    const grid = codeModules((i) => bitAt(k * perCode + i * stride));
    for (let r = 0; r < MODULES; r++) {
      for (let c = 0; c < MODULES; c++) {
        if (!grid[r * MODULES + c]) continue;
        const hx = cx + (c + 0.5) * mod;
        const hy = cy + (r + 0.5) * mod;
        // Modules ripple in outward from each code's centre, codes in turn.
        const fromMid = Math.hypot(r - MODULES / 2, c - MODULES / 2) / (MODULES * 0.72);
        const pop = k * 70 + fromMid * 320 + Math.random() * 120;
        const isFinder = (r < 7 && c < 7) || (r < 7 && c >= MODULES - 7) || (r >= MODULES - 7 && c < 7);
        if (isFinder) {
          finders.push({ x: hx, y: hy, pop });
          continue;
        }
        dots.push({
          hx,
          hy,
          t: k, // placed along the clip below, once the code's dots are counted
          delay: 0.6 * (hx - x0) / Math.max(1, gridW) + Math.random() * 0.4,
          arc: (Math.random() - 0.5) * H * 0.7,
          phase: Math.random() * Math.PI * 2,
          pop,
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
  const lineX = (t: number): number => waveL + t * waveW;
  const barW = Math.max(1.2, (waveW / barCount) * 0.38);
  let bars: number[] | null = null;
  let progress = -1;
  const sparks: Spark[] = [];
  const sparked = new Set<number>();

  const start = performance.now();
  let formAt = -1;
  let raf = 0;
  let stopped = false;
  let settle: (() => void) | null = null;

  const beamAt = (now: number): { b: number; x: number } => {
    const b = easeInOut(clamp01((now - T_READ0) / (T_READ1 - T_READ0)));
    return { b, x: x0 - size * 0.25 + b * (gridW + size * 0.5) };
  };
  /** 0 → 1 as a bar stacks, by its place in the left-to-right cascade */
  const barT = (i: number, now: number): number =>
    formAt < 0 ? 0 : clamp01((now - formAt - (i / Math.max(1, barCount - 1)) * T_CASCADE) / T_BAR);

  /** Where a dot is, and how far along its flight. */
  function place(d: Dot, now: number): { x: number; y: number; p: number } {
    const relRaw = (now - T_REL0) / (T_REL1 - T_REL0);
    const p = easeInOut(clamp01((relRaw - d.delay * 0.5) / 0.5));
    const tx = lineX(d.t);
    // the pulse running along the line while it waits for the sound
    const wave = Math.sin(now / 210 - d.t * 14 + d.phase * 0.3) * H * 0.03;
    let x = d.hx + (tx - d.hx) * p;
    let y = d.hy + (mid - d.hy) * p + Math.sin(Math.PI * p) * d.arc + wave * p;
    if (bars) {
      const f = easeInOut(barT(d.bar, now));
      const amp = bars[d.bar]! * H * 0.38;
      x += (barX(d.bar) - x) * f;
      y += (mid + d.slot * amp - y) * f;
    }
    return { x, y, p };
  }

  function drawBar(i: number, alpha: number, colour: string): void {
    const amp = Math.max(barW / 2, bars![i]! * H * 0.38);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(barX(i), mid - amp);
    ctx.lineTo(barX(i), mid + amp);
    ctx.stroke();
  }

  function frame(): void {
    if (stopped) return;
    const now = performance.now() - start;
    ctx.clearRect(0, 0, W, H);
    const { b: beam, x: beamX } = beamAt(now);
    const rel = clamp01((now - T_REL0) / (T_REL1 - T_REL0));
    const formNow = formAt < 0 ? -1 : now - formAt;

    // a soft bloom behind the stage once the bars start locking in
    if (formNow > 0) {
      const bloom = Math.sin(Math.PI * clamp01(formNow / (T_CASCADE + T_BAR + 300))) * 0.55;
      const g = ctx.createRadialGradient(W / 2, mid, 0, W / 2, mid, W * 0.6);
      g.addColorStop(0, `rgba(255, 238, 210, ${0.16 * bloom})`);
      g.addColorStop(1, 'rgba(255, 238, 210, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // finder patterns: pop in, flare as the beam crosses, fade as the data leaves
    const finderFade = 1 - easeInOut(clamp01(rel * 1.8));
    if (finderFade > 0) {
      for (const f of finders) {
        const s = easeBack(clamp01((now - f.pop) / 380));
        if (s <= 0) continue;
        const hot = beam > 0 && beam < 1 ? Math.max(0, 1 - Math.abs(f.x - beamX) / (size * 0.35)) : 0;
        ctx.globalAlpha = Math.min(1, s) * finderFade;
        ctx.fillStyle = hot > 0.3 ? glow : ink;
        const w = mod * 0.9 * s;
        ctx.fillRect(f.x - w / 2, f.y - w / 2, w, w);
      }
    }

    // the reading beam: a column of light with a soft wake
    if (beam > 0 && beam < 1) {
      const wake = ctx.createLinearGradient(beamX - size * 0.7, 0, beamX + 2, 0);
      wake.addColorStop(0, 'rgba(255, 244, 225, 0)');
      wake.addColorStop(1, 'rgba(255, 244, 225, 0.2)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = wake;
      ctx.fillRect(beamX - size * 0.7, y0 - mod * 3, size * 0.7 + 2, gridH + mod * 6);
      ctx.save();
      ctx.shadowColor = 'rgba(255, 240, 215, 0.95)';
      ctx.shadowBlur = 18;
      ctx.fillStyle = glow;
      ctx.fillRect(beamX - 0.8, y0 - mod * 3, 1.6, gridH + mod * 6);
      ctx.restore();
    }

    // the centre line, faint, while the dots land on it
    const lineIn = clamp01((now - T_REL0 - 400) / 600);
    const lineOut = formNow > 0 ? clamp01(formNow / T_CASCADE) : 0;
    if (lineIn > 0 && lineOut < 1) {
      ctx.globalAlpha = 0.2 * lineIn * (1 - lineOut);
      ctx.fillStyle = ink;
      ctx.fillRect(waveL, mid - 0.5, waveW, 1);
    }

    // dots, with light trails while they fly
    ctx.lineCap = 'round';
    const r = Math.max(0.9, mod * 0.36);
    for (const d of dots) {
      const pop = easeBack(clamp01((now - d.pop) / 380));
      if (pop <= 0) continue;
      const { x, y, p } = place(d, now);
      const bt = bars ? barT(d.bar, now) : 0;
      const alpha = bt > 0.6 ? 1 - (bt - 0.6) / 0.4 : 1;
      if (alpha <= 0) continue;
      // flare as the beam passes over, cooling back to ink
      const since = beam > 0 && d.hx < beamX ? (beamX - d.hx) / (size * 0.5) : -1;
      const hot = p < 0.02 && since >= 0 ? Math.max(0, 1 - since) : 0;
      if (p > 0.02 && p < 0.98) {
        const prev = place(d, now - 45);
        ctx.globalAlpha = 0.35 * alpha;
        ctx.strokeStyle = ink;
        ctx.lineWidth = r * 1.4;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.globalAlpha = alpha * Math.min(1, pop);
      ctx.fillStyle = hot > 0.15 ? glow : ink;
      const homeSize = mod * 0.9 * pop * (1 + hot * 0.35);
      const s = homeSize * (1 - p) + r * 2 * p;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }

    // the waveform, bar by bar as each locks in, with a spark burst
    if (bars) {
      ctx.lineWidth = barW;
      ctx.lineCap = 'round';
      for (let i = 0; i < barCount; i++) {
        const bt = barT(i, now);
        if (bt <= 0.45) continue;
        drawBar(i, clamp01((bt - 0.45) / 0.55), ink);
        if (!sparked.has(i) && bt >= 0.8) {
          sparked.add(i);
          const amp = bars[i]! * H * 0.38;
          for (let n = 0; n < 3; n++) {
            const up = n % 2 === 0 ? -1 : 1;
            sparks.push({
              x: barX(i),
              y: mid + up * amp,
              vx: (Math.random() - 0.5) * 0.05,
              vy: up * (0.03 + Math.random() * 0.05),
              born: now,
            });
          }
        }
      }
      // the glint: a band of light crossing the finished wave
      const glintT = (formNow - T_CASCADE - T_BAR) / T_GLINT;
      if (glintT > 0 && glintT < 1) {
        const gx = waveL - W * 0.1 + easeInOut(glintT) * (waveW + W * 0.2);
        for (let i = 0; i < barCount; i++) {
          const near = Math.max(0, 1 - Math.abs(barX(i) - gx) / (W * 0.08));
          if (near > 0) drawBar(i, near, glow);
        }
      }
    }

    // sparks drift off and fade
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]!;
      const age = now - s.born;
      if (age > 600) {
        sparks.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = (1 - age / 600) * 0.9;
      ctx.fillStyle = glow;
      const sz = 1.6 * (1 - age / 600) + 0.6;
      ctx.fillRect(s.x + s.vx * age - sz / 2, s.y + s.vy * age - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    if (formNow >= T_FORM && sparks.length === 0) {
      drawSettled();
      settle?.();
      settle = null;
      return; // done: further paints come from setProgress
    }
    raf = requestAnimationFrame(frame);
  }

  function drawSettled(): void {
    ctx.clearRect(0, 0, W, H);
    if (!bars) return;
    ctx.lineWidth = barW;
    ctx.lineCap = 'round';
    for (let i = 0; i < barCount; i++) {
      const played = progress >= 0 && (i + 0.5) / barCount <= progress;
      drawBar(i, progress >= 0 && !played ? 0.38 : 1, played ? glow : ink);
    }
    ctx.globalAlpha = 1;
  }

  if (!reduced) raf = requestAnimationFrame(frame);

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
        if (stopped) return resolve();
        if (reduced) {
          // No motion: just show the finished waveform.
          formAt = 0;
          drawSettled();
          return resolve();
        }
        settle = resolve;
        // Never form before the dots have landed: a fast decode (heartbeat
        // cards decode instantly) still gets the whole story, and a beat of
        // the pulse along the line.
        formAt = Math.max(performance.now() - start, T_REL1 + 450);
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
