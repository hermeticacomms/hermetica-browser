import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { embedManifest } from './src/embed-manifest.ts';

const common = { bundle: true, minify: true, target: 'es2020', sourcemap: false };
await build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/hermetica.esm.js' });
// The script tag gets the core only (src/global.ts); ESM users get the whole barrel and their bundler drops what they do not use.
await build({ ...common, entryPoints: ['src/global.ts'], format: 'iife', globalName: 'Hermetica', outfile: 'dist/hermetica.js' });
// Opt-in modules are separate files so the core bundle (and its size budget) stays as it was.
for (const [name, global] of [['push', 'HermeticaPush'], ['inapp', 'HermeticaInApp'], ['ads', 'HermeticaAds'], ['reviews', 'HermeticaReviews'], ['app-push', 'HermeticaAppPush'], ['hybrid', 'HermeticaHybrid'], ['extension', 'HermeticaExtension']]) {
  await build({ ...common, entryPoints: [`src/${name}.ts`], format: 'esm', outfile: `dist/${name}.esm.js` });
  await build({ ...common, entryPoints: [`src/${name}.ts`], format: 'iife', globalName: global, outfile: `dist/${name}.js` });
}
// Served at /.well-known/hermetica-embed.json (deploy/nginx.conf), so the declared storage ships with the SDK it describes.
writeFileSync('dist/hermetica-embed.json', JSON.stringify(embedManifest(), null, 2));
