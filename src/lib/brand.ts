// Kept brand chrome: the letterspaced wordmark, the hairline soundwave, the
// wax-seal mark and the "Precious sounds, kept in metal." band. They echo the
// box the card ships in: black board, a sand belly band, a black seal.

export const BRAND = 'Kept';
export const TAGLINE = 'Precious sounds, kept in metal.';

// Half of the wave, outside in (% of its height). Mirrored about the tallest
// bar: tiny dots at the tips, a fine alternating rise to one tall stroke.
const HALF = [5, 5, 9, 6, 14, 9, 20, 12, 28, 17, 38, 24, 50, 32, 64, 44, 78, 58];
const WAVE_BARS = [...HALF, 100, ...HALF.slice().reverse()];

/** The hairline soundwave. `bars` thins it out for small marks (the seal). */
export function waveMotif(className = 'wave', bars: readonly number[] = WAVE_BARS): string {
  const pitch = 6;
  const h = 48;
  const w = (bars.length - 1) * pitch + 2;
  const lines = bars
    .map((p, i) => {
      const len = Math.max(1.6, (p / 100) * (h - 2));
      const x = 1 + i * pitch;
      return `<line x1="${x}" y1="${((h - len) / 2).toFixed(1)}" x2="${x}" y2="${((h + len) / 2).toFixed(1)}"/>`;
    })
    .join('');
  return (
    `<svg class="${className}" viewBox="0 0 ${w} ${h}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.4" stroke-linecap="round" aria-hidden="true">${lines}</svg>`
  );
}

const SEAL_BARS = [16, 34, 22, 58, 100, 58, 22, 34, 16];

/** The seal: a small wave inside a ring — the wax seal on the box band and
 * the app icon. Coloured by `currentColor`. */
export function sealMark(className = 'seal'): string {
  const pitch = 4.2;
  const lines = SEAL_BARS.map((p, i) => {
    const len = Math.max(1.5, (p / 100) * 22);
    const x = 32 + (i - (SEAL_BARS.length - 1) / 2) * pitch;
    return `<line x1="${x.toFixed(1)}" y1="${(32 - len / 2).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(32 + len / 2).toFixed(1)}"/>`;
  }).join('');
  return (
    `<svg class="${className}" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">` +
    `<circle cx="32" cy="32" r="24.5" stroke-width="0.9" opacity="0.7"/>` +
    `<g stroke-width="1.5">${lines}</g></svg>`
  );
}

/** The scanner's masthead: wordmark, wave, and the sand band carrying the
 * tagline and the seal. No navigation: the scanner (home page) and the card
 * maker (create/) deliberately don't link to each other. */
export function brandHeader(): string {
  return `
    <header class="masthead">
      <h1 class="wordmark">${BRAND}</h1>
      ${waveMotif()}
    </header>
    <div class="band">
      <div class="band-inner">
        <p class="band-line">Precious sounds,<br />kept in metal.</p>
        <span class="wax">${sealMark()}</span>
      </div>
    </div>
  `;
}
