// Codec2 encode/decode via the vendored emscripten builds in public/codec2/.
//
// The builds are command-line programs (c2enc/c2dec) compiled with emscripten:
// main() runs once per Module instantiation using Module.arguments, with file
// I/O through the in-memory FS. So every call constructs a FRESH Module; the
// factory script and .wasm bytes are fetched once and cached. Raw PCM format
// is 8 kHz, 16-bit signed little-endian, mono.

import type { Codec2Mode } from './chunk';
export type { Codec2Mode } from './chunk';

export const CODEC2_SAMPLE_RATE = 8000;

type EmscriptenModuleConfig = {
  wasmBinary?: ArrayBuffer;
  arguments: string[];
  preRun: Array<() => void>;
  postRun: Array<() => void>;
  print: (s: string) => void;
  printErr: (s: string) => void;
  FS?: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, opts: { encoding: 'binary' }): Uint8Array;
  };
};
type Factory = (config: EmscriptenModuleConfig) => unknown;

interface Loaded {
  factory: Factory;
  wasmBinary: ArrayBuffer | undefined;
}

const cache: Partial<Record<'enc' | 'dec', Promise<Loaded>>> = {};

const isBrowser = typeof document !== 'undefined';

async function loadBrowser(kind: 'enc' | 'dec'): Promise<Loaded> {
  const base = import.meta.env.BASE_URL;
  const globalName = kind === 'enc' ? 'createC2Enc' : 'createC2Dec';
  const g = globalThis as unknown as Record<string, Factory | undefined>;
  if (!g[globalName]) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${base}codec2/c2${kind}.js`;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load c2${kind}.js`));
      document.head.appendChild(s);
    });
  }
  const factory = g[globalName];
  if (!factory) throw new Error(`${globalName} missing after script load`);
  // Fetch the wasm once ourselves and hand the bytes to every instantiation —
  // avoids per-call downloads and locateFile/base-path fragility.
  const res = await fetch(`${base}codec2/c2${kind}.wasm`);
  if (!res.ok) throw new Error(`failed to fetch c2${kind}.wasm (${res.status})`);
  return { factory, wasmBinary: await res.arrayBuffer() };
}

async function loadNode(kind: 'enc' | 'dec'): Promise<Loaded> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const factory = require(`../../public/codec2/c2${kind}.js`) as Factory;
  // In Node the emscripten glue resolves the .wasm path relative to itself.
  return { factory, wasmBinary: undefined };
}

function load(kind: 'enc' | 'dec'): Promise<Loaded> {
  return (cache[kind] ??= isBrowser ? loadBrowser(kind) : loadNode(kind));
}

async function run(
  kind: 'enc' | 'dec',
  mode: Codec2Mode,
  inputName: string,
  outputName: string,
  input: Uint8Array,
): Promise<Uint8Array> {
  const { factory, wasmBinary } = await load(kind);
  return new Promise<Uint8Array>((resolve, reject) => {
    const config: EmscriptenModuleConfig = {
      arguments: [mode, inputName, outputName],
      preRun: [],
      postRun: [],
      print: () => {},
      printErr: () => {},
    };
    if (wasmBinary) config.wasmBinary = wasmBinary.slice(0);
    config.preRun.push(() => config.FS!.writeFile(inputName, input));
    config.postRun.push(() => {
      try {
        resolve(config.FS!.readFile(outputName, { encoding: 'binary' }));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    try {
      factory(config);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Encode 8 kHz mono PCM to Codec2 bits. */
export async function codec2Encode(mode: Codec2Mode, pcm: Int16Array): Promise<Uint8Array> {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength).slice();
  return run('enc', mode, 'input.raw', 'output.bit', bytes);
}

/** Decode Codec2 bits back to 8 kHz mono PCM. */
export async function codec2Decode(mode: Codec2Mode, bits: Uint8Array): Promise<Int16Array> {
  const raw = await run('dec', mode, 'input.bit', 'output.raw', bits);
  // Ensure 2-byte alignment for the Int16Array view.
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength - (raw.byteLength % 2));
  return new Int16Array(buf);
}
