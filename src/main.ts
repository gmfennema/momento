import './style.css';

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
