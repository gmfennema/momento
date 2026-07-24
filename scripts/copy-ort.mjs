// Copy the onnxruntime-web wasm binary into public/ort/ so it is served
// same-origin (no CDN at runtime, works offline once cached). Only the
// threaded SIMD binary is needed: the emscripten glue is inlined in the JS
// bundle (see lib/bwe.ts), and the same binary falls back to single-threaded
// execution when SharedArrayBuffer is unavailable.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

mkdirSync('public/ort', { recursive: true });
rmSync('public/ort/ort-wasm-simd-threaded.mjs', { force: true });
copyFileSync(
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'public/ort/ort-wasm-simd-threaded.wasm',
);
console.log('copied onnxruntime wasm → public/ort/');
