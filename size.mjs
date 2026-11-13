import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/** Fails if a minified+gzipped bundle exceeds its budget. The core budget is the lowest the current build fits; shrink rather than raise it. */
// measured 2026-11-09: 12269 + 33 for dropped (4xx) batches not reported as flushed = 12302.
// 2026-11-13: +32 translated quiz choices and question weights (c62b543), +263 unsent events kept in localStorage across reloads
// (d77c445), +9 the stamped SDK_VERSION = 12572 locally, 12602 on the release runner (newer esbuild 0.28.x); shrink rather than raise.
const BUDGET = 12_650;
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
