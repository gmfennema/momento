// Copy the lyra-codec (Lyra V2 neural codec, wasm) runtime into public/lyra/
// so it is served same-origin and precached by the service worker.
//
// The wasm binary has "https://unpkg.com/lyra-codec/dist/" baked in as the
// base URL for its model files (*.tflite). Fetching from a CDN at runtime
// would break the PWA's offline promise (and COEP), so a small shim is
// prepended to every entry script that rewrites those fetches/XHRs to the
// directory the script itself was loaded from. Model fetches happen both on
// the main thread (module bundle) and inside pthread workers (chunk 173/610),
// so both kinds of entry get the shim.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'node_modules/lyra-codec/dist';
const DST = 'public/lyra';

const CDN_PREFIX = 'https://unpkg.com/lyra-codec/dist/';

// `BASE` must be computed per-context: import.meta.url in the ESM bundle,
// self.location.href in classic workers.
const shimBody = `
(() => {
  const rw = (u) =>
    typeof u === 'string' && u.startsWith('${CDN_PREFIX}')
      ? new URL(u.slice(${CDN_PREFIX.length}), __LYRA_BASE__).href
      : u;
  const f = self.fetch && self.fetch.bind(self);
  if (f) self.fetch = (input, init) => f(typeof input === 'string' ? rw(input) : input, init);
  if (self.XMLHttpRequest) {
    const open = self.XMLHttpRequest.prototype.open;
    self.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      return open.call(this, method, rw(url), ...rest);
    };
  }
})();
`;

const moduleShim = `const __LYRA_BASE__ = import.meta.url;${shimBody}`;
const workerShim = `const __LYRA_BASE__ = self.location.href;${shimBody}`;

// Entry scripts that create/run inside contexts where model fetches happen.
const MODULE_ENTRIES = new Set(['lyra_bundle.js']);
const WORKER_ENTRIES = new Set(['173.lyra_bundle.js', '610.lyra_bundle.js']);

mkdirSync(DST, { recursive: true });
let shimmed = 0;
for (const name of readdirSync(SRC)) {
  const from = join(SRC, name);
  const to = join(DST, name);
  if (MODULE_ENTRIES.has(name) || WORKER_ENTRIES.has(name)) {
    const shim = MODULE_ENTRIES.has(name) ? moduleShim : workerShim;
    writeFileSync(to, shim + readFileSync(from, 'utf8'));
    shimmed++;
  } else {
    copyFileSync(from, to);
  }
}

writeFileSync(
  join(DST, 'NOTICE.md'),
  `# Lyra runtime notices

- \`lyra_bundle.js\` and chunks: [lyra-codec](https://github.com/neuvideo/lyra-js) (ISC license),
  a WebAssembly port of Lyra, with a small same-origin fetch shim prepended at install time
  (see \`scripts/copy-lyra.mjs\`).
- The wasm and \`*.tflite\` model files derive from [google/lyra](https://github.com/google/lyra)
  (Apache License 2.0).
`,
);
console.log(`copied lyra runtime → public/lyra/ (${shimmed} entries shimmed)`);
