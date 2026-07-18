// Simple PWA icons: dark rounded square, green dot + sound arcs (SVG → PNG via resvg)
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 96}" fill="#111214"/>
  <circle cx="216" cy="256" r="64" fill="#5eeaa5"/>
  <path d="M312 192a90 90 0 0 1 0 128" stroke="#5eeaa5" stroke-width="28" fill="none" stroke-linecap="round"/>
  <path d="M356 148a152 152 0 0 1 0 216" stroke="#5eeaa5" stroke-width="28" fill="none" stroke-linecap="round" opacity="0.6"/>
</svg>`;

for (const [file, size, maskable] of [
  ['public/icons/icon-192.png', 192, false],
  ['public/icons/icon-512.png', 512, false],
  ['public/icons/maskable-512.png', 512, true],
]) {
  const png = new Resvg(svg(maskable), { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(file, png);
  console.log(file, size);
}
