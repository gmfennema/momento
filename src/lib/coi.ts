// Cross-origin isolation bootstrap for GitHub Pages: the first-ever visit is
// served without COOP/COEP headers (Pages can't set them), so once the service
// worker takes control — it injects the headers into document responses — the
// page reloads a single time to pick them up. Later visits are already
// controlled and isolated, and dev/preview get real headers, so this no-ops.
// The reload is disarmed as soon as the user starts doing anything: blowing
// away an in-progress recording or a half-scanned card is far worse than one
// session without Lyra playback for older cards (everything else works
// un-isolated, just single-threaded).
//
// The same reload also picks up a new version: the worker serves the cached
// shell first, so a returning visitor would otherwise run the previous build
// for this whole visit — and a previous player can't read a card made with a
// newer codec. When an updated worker takes over before the visitor has
// touched anything, reload into the new build. (A page that had no worker at
// load and is already isolated is running the current build — no reload.)
export function bootstrapIsolation(): void {
  if (
    'serviceWorker' in navigator &&
    (!crossOriginIsolated || navigator.serviceWorker.controller) &&
    !sessionStorage.getItem('coi-reloaded')
  ) {
    let armed = true;
    const disarm = (): void => {
      armed = false;
    };
    window.addEventListener('pointerdown', disarm, { once: true, capture: true });
    window.addEventListener('keydown', disarm, { once: true, capture: true });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!armed) return;
      sessionStorage.setItem('coi-reloaded', '1');
      location.reload();
    });
  }
}
