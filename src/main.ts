import '@fontsource/cormorant-garamond/latin-400.css';
import '@fontsource/cormorant-garamond/latin-400-italic.css';
import '@fontsource/cormorant-garamond/latin-500.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import './style.css';

import { bootstrapIsolation } from './lib/coi';

// The scanner is the site's home page: the URL engraved on every card lands
// here. Cards engraved before the split point at '<root>/#p'; that also lands
// here, since the hash no longer routes anything. The card maker lives on its
// own page (create/index.html → src/create.ts), and neither page links to the
// other.
bootstrapIsolation();
const app = document.getElementById('app')!;
void import('./player/player').then((m) => m.mountPlayer(app));
