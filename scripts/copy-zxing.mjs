// Copy zxing-wasm's reader binary into public/zxing/ so it is served
// same-origin and precached by the service worker (no CDN at runtime).
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/zxing', { recursive: true });
copyFileSync(
  'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm',
  'public/zxing/zxing_reader.wasm',
);
console.log('copied zxing_reader.wasm → public/zxing/');
