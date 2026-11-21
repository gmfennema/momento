# Momento — audio that lives on a business card

Momento turns up to **10 seconds of audio** into a grid of QR codes sized for a
business card, ready for laser engraving: a **metal card (85.6 × 54 mm,
credit-card size)** by default, or a **3.5″ × 2″ paper card**. Scanning the
card's entry code opens this site, which then reads every code on the card with
the phone camera and plays the sound back.

**The audio is stored nowhere but the card.** No servers, no accounts, no
uploads — encoding and decoding happen entirely in the browser.

The site is two pages that don't link to each other:

- **`/` — the scanner.** The public home page, and the URL every card's entry
  code points to. It is the site root with no hash or path, so the engraved
  address never has to change. Cards engraved before the split point at
  `/#p`, which lands on the same page.
- **`/create/` — the card station.** Where cards are made. Nothing on the
  scanner links to it, and it is marked `noindex`.

The site is hosted on Vercel at **https://k.gabefen.com/** (`vercel.json`
sends the cross-origin-isolation headers), and every card's entry code
carries exactly that address, wherever the station runs (a card made from a
local dev server still points at the live scanner). Set `VITE_PLAYER_URL` at
build time to change it, but never after cards have been engraved with it.
Cards engraved earlier point at `gmfennema.github.io/momento/#p`; GitHub Pages
now serves only a redirect from there to the new domain (see
`.github/workflows/deploy.yml`), so they still play.

## How it works

1. **Generator** (`/create/`): upload or record audio → conditioned for the codec
   (high-pass, leading/trailing silence dropped, loudness normalized) →
   trimmed to ≤10s → compressed in-browser with either
   [Mimi](https://huggingface.co/kyutai/mimi) (Kyutai's neural speech codec,
   24 kHz, run by onnxruntime-web) or the
   [Codec 2](https://github.com/drowe67/codec2) vocoder (8 kHz) → split
   into self-describing chunks → each chunk becomes a byte-mode QR code → laid out on a card image with one **entry QR** that carries the
   player URL. By default the back is **textured**: a field of dark/light cells
   at the same module pitch as the codes fills the card edge to edge, so the
   data codes read as buried in static while the entry code sits in a clean
   window top-left (see [Card back texture](#card-back-texture)). Download as
   high-DPI PNG or vector SVG, with an invert option
   for black cards. The generator also renders a matching
   **card front** — a monochrome, letterpress-style face with the MOMENTO
   wordmark, the clip's waveform as fine mirrored bars, the name line, and a
   clip-metadata line (voice · recorded date · duration) — downloadable as its
   own PNG/SVG pair.
   One ink on one stock, so the front prints, foils, or engraves with the
   same setup as the back.
2. **Player** (`/`): tap scan → the camera reads codes in any order (multiple
   per frame) with live progress → chunks are reassembled → the codec named in
   the chunk headers decodes → Web Audio plays the sound. A Mimi card decodes
   straight to 24 kHz wideband voice (the ~60 MB decoder model is fetched on
   first use and cached; the scanner starts that download as soon as the first
   code names the codec). Codec 2's 8 kHz
   decode also gets a playback-side restoration before playback, at zero card
   cost: the [LavaSR](https://github.com/ysharma3501/LavaSR) neural
   speech-restoration model (fp16 ONNX, ~27 MB fetched on first use and
   cached, run in-browser by onnxruntime-web) resynthesizes the frequencies
   the narrowband format cannot carry, with a Linkwitz-Riley crossover
   keeping the authentic decode below 3.6 kHz. Inference runs in a worker, so
   the page keeps painting (and shows an elapsed-time counter) instead of
   looking frozen, and it runs under a watchdog. When the model can't load or
   doesn't finish — offline first scan, wasm failure, a dead worker —
   playback falls back to a lightweight Web Audio polish: presence/high-shelf
   EQ plus a harmonic exciter that regenerates the 4–7 kHz band from the
   speech itself, and says so on the play screen. No camera handy (or
   permission denied)? Upload photo(s) of the card instead — add shots until
   every square is captured.

### Quality tiers

Two rungs. The card holds about 1.85 KB at the 0.32 mm floor; what changes
between them is how well that budget is spent.

| Tier | Codec | 10 s clip | Short clip (≤ 4.4 s) |
|---|---|---|---|
| Basic | Codec 2 1400 + neural restoration | 1.4 kbps | 1.4 kbps, bigger dots |
| Best (default) | Mimi, depth chosen per clip | 10 codes/frame, 1.38 kbps | 20 codes/frame, 2.75 kbps |

**Best fills the card.** Mimi describes each 80 ms frame with a stack of up to
32 eleven-bit codes, coarse to fine, and any prefix of the stack decodes. The
generator gives every clip the deepest stack (8–20 codes) whose card still
clears the floor: 20 codes up to ~4.4 s, 17 at 6 s, 13 at 8 s, 10 at 10 s. Past
20 codes the gain is negligible, so short clips spend spare room on bigger dots
instead.

Measured on 8 LibriSpeech speakers plus a harder set (expressive speech —
whisper, laughter — accents, and simulated phone recordings in a noisy room),
9.5 s clips:

| Pipeline | UTMOS ↑ | Speaker similarity ↑ | Word error ↓ | Hard set: UTMOS / word error |
|---|---|---|---|---|
| Original | 4.14 | 1.000 | — | 2.97 / — |
| Mimi, 20 codes (≤ 4.4 s cards) | 4.03 | 0.991 | 2.8% | 2.84 / 10.6% |
| Mimi, 10 codes (10 s cards) | 3.80 | 0.979 | 2.8% | 2.75 / 10.1% |
| Lyra 3.2 kbps (former Best, ≤ 4.4 s) | 2.96 | 0.966 | 4.7% | 2.25 / 10.6% |
| Codec 2 1400 + restoration (Basic) | 1.35 | 0.857 | 8.7% | 1.34 / 37.6% |

UTMOS is a learned naturalness score (1–5; the hard set's originals score low
because they are whispered, noisy, or reverberant); speaker similarity is
WavLM-SV cosine; word error is Whisper small.en against its own transcript of
the original. Mimi rows are the int8 models the site ships.

Lyra 3.2 kbps and Codec 2 2400 were the middle rungs until Mimi beat both at
every clip length; the generator no longer makes them, but the player still
plays every card ever engraved — chunk headers carry a wire-format version
(0 = Codec 2, 1 = Lyra, 2 = Mimi with its depth in the mode bits), and older
cards' Base45 codes still read.

**No card is ever laid out below 0.32 mm modules.** That is a hard floor, not a
warning: the generator reports the physical module (dot) size live, and a tier
whose card would fall under the floor is simply *unavailable*. On a 3.5″ × 2″
card the floor also holds the data codes at QR version 10 or lower (≤ 57
modules a side), which matters as much as the millimetres: every extra version
is 4 more modules the camera must resolve across the same symbol. The taller
metal card fits a 3 × 2 grid of larger codes at the same dot size (up to
version 13), which holds more: a full 10 s clip gets 12 Mimi codes a frame
instead of 10. In the simulated-engraving tests (`tests/burn.test.ts`) both
layouts read every code across 0–0.16 mm of over-burn.

Each tile also has a **▶ Preview** button (and the card panel a **▶ Hear this
card**). Preview runs the *player's* pipeline — encode, decode, restoration and
all — so you hear exactly what a scanned card will play, not an approximation
of it.

### Card back texture

The textured back is cosmetic, and it is never allowed to cost a scan:

- Every code keeps its full **3-module light quiet zone**; the field only fades
  in beyond it. A dark cell touching a symbol would lengthen the first run of
  ZXing's 1:1:3:1:1 finder-pattern match and lose that code entirely.
- For the field to reach full density *between* codes, the planner needs wider
  gutters, which it buys out of surplus module size — it stops growing modules
  at 0.35 mm and never drops below the 0.32 mm scannability floor to make room.
  A clip that already fills the card keeps the plain spacing and gets the field
  only in the margins and any unused cell; the generator says so.
- The entry code gets a clean window top-left, and **"SCAN TO LISTEN" is the
  only writing on this face** — the name and clip metadata live on the front, so
  nothing competes with the field.
- Coverage is reported live (typically **+8–12%** engraved area) since it is
  real extra laser time.
- Turn it off with the texture toggle for the original bare-stock look.

`tests/e2e-card.test.ts` scans textured cards in both polarities, including a
blurred ~340 dpi render, and asserts every chunk still comes back.

### Cross-origin isolation

The Lyra wasm (playback of older cards) uses threads, so it needs
`SharedArrayBuffer`, which browsers only enable on cross-origin isolated pages;
onnxruntime also uses threads there when it can. The dev/preview servers send
the COOP/COEP headers directly; on GitHub Pages (which can't set headers) the
service worker injects them into document responses, and `main.ts` reloads
once on the very first visit so isolation kicks in. Mimi and Codec 2 run
without it, single-threaded.

## Engraving notes

- Pick the **card size** that matches your blank. Metal cards are almost always
  85.6 × 54 mm (credit-card size), not 3.5″ × 2″; the two are different
  shapes, so artwork for one can't be scaled onto the other.
- Engrave the output at **exactly card size, 100%** — do not rescale. The SVG
  is sized in millimetres and the PNG records its 1200 dpi, so both import at
  the right size.
- Prefer the **SVG** for laser software; the PNG is 1200 dpi if you need raster.
  With the textured back, the field is thousands of small cells — if your laser
  software struggles with the shape count, engrave the 1200 dpi PNG in raster
  mode instead. Budget for the extra pass time: the generator reports the added
  engraved area.
- For **black cards**, enable the invert toggle. The background stays white —
  only the QR codes flip: each becomes a dark plate (code + quiet zone) with
  the modules knocked out, so the laser engraves just the code tiles and the
  unburned modules stay dark. The scanner reads inverted codes natively.
- **Laser over-burn.** A laser burns a little wider than the artwork, so the
  engraved colour comes out fat and the other one thin. At 0.33 mm a dot,
  ~0.1 mm of that is enough that a phone finds every code and fails each one's
  checksum (a real black card did exactly this: 1 code of 7). The generator
  draws the codes to cancel it — 0.08 mm per edge by default, readable in
  simulation from a perfect engraver up to 0.16 mm of over-burn. If the dots
  your engraver leaves still look thinner than the gaps between them, raise
  the setting; if fatter, lower it. The player also re-reads each frame with
  the thin colour thickened, which is what rescues cards made before this.
- High contrast and crisp edges matter more than depth. Test-scan a printout
  before burning a card — and scan metal cards in soft, even light: a
  reflection across a code hides it.

## Development

```bash
npm install        # also copies the zxing + lyra wasm into public/
npm run dev        # scanner at /, card station at /create/
npm test           # unit + full-pipeline tests (node)
npm run build      # typecheck + production build (base path /momento/; deploy uses /)
npm run e2e        # Playwright, against vite preview and a GitHub-Pages-like server (build first)
```

The keystone test (`tests/e2e-card.test.ts`) proves the whole physical
contract in CI: synth audio → encode → render the card SVG → rasterize → scan
the image with zxing → reassemble → decode → audio again, for every tier and
the inverted variant, plus a degraded 900 px "phone photo" of a full 10 s card
for both rungs. `tests/mimi.test.ts` runs the shipped Mimi models through
onnxruntime-web in node, and the Playwright suite runs the full
encode→card→photo→decode loop in a browser. `e2e/pages.spec.ts` runs that
loop the way GitHub Pages serves the site, with no isolation headers from the
server, so the service worker has to supply them (`vite preview` sends them
itself and would hide a gap). `scripts/mimi/` rebuilds the models.

## Deploying

Pushes to `main` build and deploy to GitHub Pages via
`.github/workflows/deploy.yml`. One-time setup: repo **Settings → Pages →
Source: GitHub Actions**. To serve from a custom domain later, set the
`BASE_PATH=/` env var at build time — cards always encode the URL of whatever
origin generated them, so existing cards keep working as long as the old URL
keeps resolving.

## Manual device checklist

- [ ] iPhone Safari: record, generate, download PNG/SVG
- [ ] iPhone Safari: scan an engraved/printed card end-to-end (`/`)
- [ ] Android Chrome: same two flows; torch button appears when supported
- [ ] Upload a photo of the card (`/`) — including a HEIC straight from the iPhone camera roll
- [ ] Inverted (black) card scans
- [ ] Best (Mimi) card on an older iPhone and a mid-range Android: first scan downloads the ~56 MB model with progress, decodes a 10 s clip without the tab reloading (≈330 MB peak in desktop Chrome)
- [ ] Airplane mode after first visit: generator still loads (PWA offline)

## Licenses

App code is MIT. The Codec 2 WebAssembly artifacts in `public/codec2/` are
LGPL 2.1 — see `public/codec2/NOTICE.md` for provenance and how to swap in
your own build. The Lyra runtime copied to `public/lyra/` at install time is
[lyra-codec](https://github.com/neuvideo/lyra-js) (ISC) wrapping
[google/lyra](https://github.com/google/lyra) models (Apache 2.0) — see
`public/lyra/NOTICE.md`. The Mimi models in `public/mimi/` are int8
conversions of [kyutai/mimi](https://huggingface.co/kyutai/mimi) (CC-BY-4.0)
— see `public/mimi/NOTICE.md`. The neural enhancer models in `public/bwe/` are
fp16 conversions of [LavaSR](https://github.com/ysharma3501/LavaSR) via
[LavaSR-ONNX](https://github.com/Topping1/LavaSR-ONNX) (both Apache 2.0),
run by [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT)
copied to `public/ort/` at install time — see `public/bwe/NOTICE.md`.
