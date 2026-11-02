import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** Fails if a minified+gzipped bundle exceeds its budget. The core budget is the lowest the current build fits; shrink rather than raise it. */
// Review widgets moved to their own entry (`/reviews`), which freed room here; lower BUDGET to the new build size once measured.
const BUDGET = 7985; // lowest the build fit before that move (+$ad hook, +Idempotency-Key on batches and form upload/submit); shrink rather than raise
// Run after `npm run build`.
const size = gzipSync(readFileSync('dist/hermetica.js')).length;
console.log(`sdk-browser: ${size} B gzip (budget ${BUDGET})`);
if (size > BUDGET) { console.error('SDK exceeds size budget'); process.exit(1); }

// Opt-in entry points ship separately (never loaded by the core script); each has its own budget so growth there is still caught.
const OPT_IN = { 'dist/push.js': 2000, 'dist/inapp.js': 3500, 'dist/ads.js': 1200, 'dist/reviews.js': 1800, 'dist/app-push.js': 1500 };
for (const [file, budget] of Object.entries(OPT_IN)) {
  const n = gzipSync(readFileSync(`${file}`)).length;
  console.log(`sdk-browser ${file}: ${n} B gzip (budget ${budget})`);
  if (n > budget) { console.error(`${file} exceeds its size budget`); process.exit(1); }
}
