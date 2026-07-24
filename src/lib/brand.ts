// Shared brand chrome: the letterspaced wordmark and engraved-soundwave motif
// that echo the physical card the site produces.

// Bar heights (% of the motif height) tracing a two-lobed voice envelope,
// like the engraving on the card front.
const WAVE_BARS = [
  4, 6, 10, 8, 16, 24, 18, 34, 46, 38, 58, 72, 64, 88, 78, 96, 84, 100, 90, 72, 60,
  60, 72, 90, 100, 84, 96, 78, 88, 64, 72, 58, 38, 46, 34, 18, 24, 16, 8, 10, 6, 4,
];

const BAR_W = 2;
const BAR_GAP = 4;
const WAVE_H = 44;

export function waveMotif(className = 'wave'): string {
  const width = WAVE_BARS.length * (BAR_W + BAR_GAP) - BAR_GAP;
  const rects = WAVE_BARS.map((p, i) => {
    const h = Math.max(2, (p / 100) * WAVE_H);
    const y = (WAVE_H - h) / 2;
    return `<rect x="${i * (BAR_W + BAR_GAP)}" y="${y.toFixed(1)}" width="${BAR_W}" height="${h.toFixed(1)}" rx="1"/>`;
  }).join('');
  return (
    `<svg class="${className}" viewBox="0 0 ${width} ${WAVE_H}" ` +
    `fill="currentColor" aria-hidden="true">${rects}</svg>`
  );
}

export function brandHeader(tagline: string): string {
  return `
    <header class="masthead">
      <h1 class="wordmark">Momento</h1>
      ${waveMotif()}
      <p class="tagline">${tagline}</p>
    </header>
  `;
}
