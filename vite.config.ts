import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Deployed on Vercel at https://k.gabefen.com/ (vercel.json sets BASE_PATH=/).
// The /momento/ default is the old github.io path, which local runs and the
// e2e tests still use.
const base = process.env.BASE_PATH ?? '/momento/';

// The Lyra codec wasm uses threads → SharedArrayBuffer → the page must be
// cross-origin isolated. Dev/preview servers and Vercel (vercel.json) send the
// headers directly; the service worker also injects them (see src/sw.ts), for
// any host that can't.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    // Two pages: the scanner is the home page (the URL engraved on cards), and
    // the card maker sits at create/. Neither links to the other.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        create: resolve(import.meta.dirname, 'create/index.html'),
      },
    },
  },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  plugins: [
    // onnxruntime-web's bundle build carries a `new URL(...)` reference to
    // its wasm binary, so Rollup emits a 13.5 MB copy under assets/ — dead
    // weight, because ort.env.wasm.wasmPaths points at public/ort/ (kept
    // fresh by scripts/copy-ort.mjs). Drop the duplicate from the bundle;
    // it would otherwise also fail the service-worker precache size check.
    {
      name: 'drop-bundled-ort-wasm',
      generateBundle(_options, bundle) {
        for (const key of Object.keys(bundle)) {
          if (/^assets\/ort-wasm.*\.wasm$/.test(key)) delete bundle[key];
        }
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,wasm,tflite,webmanifest,png,svg,ico,woff2}'],
        // The neural enhancer's runtime and models are far too big to force
        // on every visitor — the service worker caches them on first use.
        globIgnores: ['ort/**', 'bwe/**', 'mimi/**'],
        // the Lyra wasm is ~3.8 MB
        maximumFileSizeToCacheInBytes: 5_000_000,
      },
      manifest: {
        name: 'Momento — Audio on a Card',
        short_name: 'Momento',
        description: 'Scan a card to hear the sound engraved on it. The audio lives only on the card.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0b0b0c',
        theme_color: '#0b0b0c',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
