// Service worker: offline precaching (as before, via Workbox) plus
// cross-origin-isolation headers for GitHub Pages.
//
// The Lyra codec needs SharedArrayBuffer, which browsers only expose on
// cross-origin isolated pages (COOP + COEP response headers). GitHub Pages
// cannot set headers, but a service worker may rewrite the responses it
// serves — the standard "coi-serviceworker" trick. Document responses get the
// two headers injected here; main.ts reloads the page once when the worker
// first takes control so the very first visit gets isolated too.
/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  getCacheKeyForURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function withCoiHeaders(res: Response): Response {
  if (res.status === 0 || res.type === 'opaque') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Handle navigations ourselves (network first, precached shell offline) so the
// document response always carries the isolation headers. Subresources fall
// through to the Workbox precache routes registered below.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      try {
        return withCoiHeaders(await fetch(event.request));
      } catch {
        const shellKey = getCacheKeyForURL('index.html');
        const shell = shellKey && (await caches.match(shellKey));
        if (shell) return withCoiHeaders(shell);
        return Response.error();
      }
    })(),
  );
});

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
