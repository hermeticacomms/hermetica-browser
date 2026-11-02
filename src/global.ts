// The script-tag build (`dist/hermetica.js`, global `Hermetica`): the core tracker only, so its gzip budget stays small. Review
// widgets, hybrid-app helpers and the other opt-in modules ship as their own files; bundlers tree-shake them from the ESM barrel.
export { createClient } from './client.ts';
