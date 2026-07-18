# Codec 2 WebAssembly — Notice

The files in this directory (`c2enc.js`, `c2enc.wasm`, `c2dec.js`, `c2dec.wasm`)
are **unmodified prebuilt artifacts** of the Codec 2 speech codec compiled to
WebAssembly, and are licensed under the **GNU Lesser General Public License
v2.1** (see `LICENSE` in this directory).

## Provenance / corresponding source

- Built by [rameshvarun/codec2-emscripten](https://github.com/rameshvarun/codec2-emscripten)
  at commit `68e323e8659a24efe600422861c3b50b3944e1eb`, which compiles
- [drowe67/codec2](https://github.com/drowe67/codec2) at commit
  `67f31bce663caef85abb5dd2df62fb996b246c05` (with the `codec2.patch` from the
  build repo) using Emscripten 3.1.26.

The build instructions (`build.sh`) needed to reproduce these artifacts are in
the codec2-emscripten repository linked above.

## LGPL compliance note

These library files are distributed as separate, runtime-loaded files (they are
not statically linked into the application bundle). You may replace them with
your own build of Codec 2: rebuild via the repositories above and drop the four
resulting files into this directory.

The rest of the Momento application is MIT-licensed (see the repository root
`LICENSE`) and merely uses this library through its command-line interface.
