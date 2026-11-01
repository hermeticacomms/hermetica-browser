import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** Fails if a minified+gzipped bundle exceeds its budget. The core budget is the lowest the current build fits; shrink rather than raise it. */
const BUDGET = 7950; // lowest value the current build fits with a few bytes of margin; do not raise, shrink instead
// Run after `npm run build`.
const size = gzipSync(readFileSync('dist/hermetica.js')).length;
console.log(`sdk-browser: ${size} B gzip (budget ${BUDGET})`);
if (size > BUDGET) { console.error('SDK exceeds size budget'); process.exit(1); }

// Opt-in entry points ship separately (never loaded by the core script); each has its own budget so growth there is still caught.
const OPT_IN = { 'dist/push.js': 2000, 'dist/inapp.js': 3500, 'dist/ads.js': 1200 };
for (const [file, budget] of Object.entries(OPT_IN)) {
  const n = gzipSync(readFileSync(`${file}`)).length;
  console.log(`sdk-browser ${file}: ${n} B gzip (budget ${budget})`);
  if (n > budget) { console.error(`${file} exceeds its size budget`); process.exit(1); }
}
