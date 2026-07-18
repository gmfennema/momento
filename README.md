# Momento — audio that lives on a business card

Momento turns up to **10 seconds of audio** into a grid of QR codes sized for a
standard **3.5″ × 2″ business card**, ready for laser engraving. Scanning the
card's entry code opens this site, which then reads every code on the card with
the phone camera and plays the sound back.

**The audio is stored nowhere but the card.** No servers, no accounts, no
uploads — encoding and decoding happen entirely in the browser.

## How it works

1. **Generator** (`/`): upload or record audio → trimmed to ≤10s → resampled to
   8 kHz mono → compressed with the [Codec 2](https://github.com/drowe67/codec2)
   speech codec (WebAssembly, in-browser) → split into self-describing chunks →
   each chunk becomes a Base45/alphanumeric QR code → laid out on a card image
   with one **entry QR** that carries the player URL. Download as high-DPI PNG
   or vector SVG, with an invert option for black cards.
2. **Player** (`/#p`): tap scan → the camera reads codes in any order (multiple
   per frame) with live progress → chunks are reassembled → Codec 2 decodes →
   Web Audio plays the sound.

### Quality tiers

| Tier | Codec 2 mode | 10s payload | Character |
|---|---|---|---|
| Compact | 700C | ~1.0 KB | Fewest/largest codes; robotic but intelligible voice |
| Balanced (default) | 1600 | ~2.0 KB | Good speech quality, comfortably scannable |
| Best | 3200 | ~4.0 KB | Clearest voice; dense card, needs precise engraving |

The generator reports the physical module (dot) size live and warns below
0.30 mm (scanning gets touchy) and 0.25 mm (many engravers can't hold it).

## Engraving notes

- Engrave the output at **exactly 3.5″ × 2″ (88.9 × 50.8 mm)** — do not rescale.
- Prefer the **SVG** for laser software; the PNG is 1200 dpi if you need raster.
- For **black cards**, enable the invert toggle (white marks on dark). The
  scanner reads inverted codes natively.
- High contrast and crisp edges matter more than depth. Test-scan a printout
  before burning a card.

## Development

```bash
npm install        # also copies the zxing wasm into public/zxing/
npm run dev        # generator at /, player at /#p
npm test           # unit + full-pipeline tests (node)
npm run build      # typecheck + production build (base path /momento/)
npm run e2e        # Playwright smoke test against vite preview
```

The keystone test (`tests/e2e-card.test.ts`) proves the whole physical
contract in CI: synth audio → encode → render the card SVG → rasterize → scan
the image with zxing → reassemble → decode → audio again, for every tier and
the inverted variant.

## Deploying

Pushes to `main` build and deploy to GitHub Pages via
`.github/workflows/deploy.yml`. One-time setup: repo **Settings → Pages →
Source: GitHub Actions**. To serve from a custom domain later, set the
`BASE_PATH=/` env var at build time — cards always encode the URL of whatever
origin generated them, so existing cards keep working as long as the old URL
keeps resolving.

## Manual device checklist

- [ ] iPhone Safari: record, generate, download PNG/SVG
- [ ] iPhone Safari: scan an engraved/printed card end-to-end (`#p`)
- [ ] Android Chrome: same two flows; torch button appears when supported
- [ ] Inverted (black) card scans
- [ ] Airplane mode after first visit: generator still loads (PWA offline)

## Licenses

App code is MIT. The Codec 2 WebAssembly artifacts in `public/codec2/` are
LGPL 2.1 — see `public/codec2/NOTICE.md` for provenance and how to swap in
your own build.
