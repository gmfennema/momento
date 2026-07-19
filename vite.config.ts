import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Deployed at https://gmfennema.github.io/momento/ — override with BASE_PATH
// (e.g. "/" once a custom domain exists).
const base = process.env.BASE_PATH ?? '/momento/';

// The Lyra codec wasm uses threads → SharedArrayBuffer → the page must be
// cross-origin isolated. Dev/preview servers send the headers directly;
// on GitHub Pages (no custom headers) the service worker injects them
// (see src/sw.ts).
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base,
  build: { target: 'es2022' },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,wasm,tflite,webmanifest,png,svg,ico}'],
        // the Lyra wasm is ~3.8 MB
        maximumFileSizeToCacheInBytes: 5_000_000,
      },
      manifest: {
        name: 'Momento — Audio on a Card',
        short_name: 'Momento',
        description:
          'Turn 10 seconds of audio into laser-engravable QR codes on a business card, and play cards back by scanning them. The audio lives only on the card.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#111111',
        theme_color: '#111111',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
