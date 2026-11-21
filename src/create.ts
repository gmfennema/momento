import '@fontsource/cormorant-garamond/latin-400.css';
import '@fontsource/cormorant-garamond/latin-400-italic.css';
import '@fontsource/cormorant-garamond/latin-500.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import './style.css';

import { bootstrapIsolation } from './lib/coi';

// The card-making station, served at '<root>/create/'. It is deliberately
// unlinked from the scanner (the public home page) and marked noindex.
bootstrapIsolation();
const app = document.getElementById('app')!;
void import('./generator/generator').then((m) => m.mountGenerator(app));
