import './style.css';

// Cross-origin isolation bootstrap for GitHub Pages: the first-ever visit is
// served without COOP/COEP headers (Pages can't set them), so once the service
// worker takes control — it injects the headers into document responses — the
// page reloads a single time to pick them up. Later visits are already
// controlled and isolated, and dev/preview get real headers, so this no-ops.
if (!crossOriginIsolated && 'serviceWorker' in navigator && !sessionStorage.getItem('coi-reloaded')) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    sessionStorage.setItem('coi-reloaded', '1');
    location.reload();
  });
}

const app = document.getElementById('app')!;

function route(): void {
  // '#p' → player (the URL engraved on cards — keep it short & stable forever).
  if (location.hash.startsWith('#p')) {
    void import('./player/player').then((m) => m.mountPlayer(app));
  } else {
    void import('./generator/generator').then((m) => m.mountGenerator(app));
  }
}

window.addEventListener('hashchange', () => {
  app.replaceChildren();
  route();
});

route();
