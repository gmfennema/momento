// Service worker: offline precaching (via Workbox) plus cross-origin-isolation
// headers for GitHub Pages.
//
// Threaded wasm (Lyra, and onnxruntime for Mimi and the neural restorer) needs
// SharedArrayBuffer, which browsers only expose on cross-origin isolated pages
// (COOP + COEP response headers). GitHub Pages cannot set headers, but a
// service worker may rewrite the responses it serves — the standard
// "coi-serviceworker" trick. main.ts reloads the page once when the worker
// first takes control so the very first visit gets isolated too.
//
// Every same-origin response gets the headers, not just the page: an isolated
// page may only start a worker whose own script is served with COEP, so a
// document-only rewrite isolates the page and then breaks every worker it
// starts — onnxruntime's included ("no available backend found"), which took
// out Mimi playback on every visit after the first.
/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  getCacheKeyForURL,
  matchPrecache,
  precache,
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

// The neural assets (~27 MB of enhancer models in bwe/, ~130 MB of Mimi codec
// models in mimi/, ~13 MB of onnxruntime wasm in ort/) are far beyond the
// precache size limit, so they are cached on first use instead: cache-first
// keeps replays instant and offline-capable without making every visitor
// download them up front.
const HEAVY_CACHE = 'momento-heavy-v1';
const HEAVY_PATH = /\/(bwe|mimi|ort)\/[^/]+\.(onnx|wasm)$/;

async function heavy(request: Request): Promise<Response> {
  const cache = await caches.open(HEAVY_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) void cache.put(request, res.clone());
  return res;
}

// Navigations get the precached shell directly (instant load offline and on
// flaky networks); shell updates arrive through new service worker versions.
async function shell(request: Request): Promise<Response> {
  const shellKey = getCacheKeyForURL('index.html');
  const cached = shellKey ? await caches.match(shellKey) : undefined;
  return cached ?? fetch(request);
}

async function serve(request: Request, url: URL): Promise<Response> {
  if (request.mode === 'navigate') return shell(request);
  if (HEAVY_PATH.test(url.pathname)) return heavy(request);
  return (await matchPrecache(request)) ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(serve(request, url).then(withCoiHeaders, () => Response.error()));
});

cleanupOutdatedCaches();
precache(self.__WB_MANIFEST);
