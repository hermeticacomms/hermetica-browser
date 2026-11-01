import { build } from 'esbuild';

const common = { bundle: true, minify: true, target: 'es2020', sourcemap: false };
await build({ ...common, entryPoints: ['src/index.ts'], format: 'esm', outfile: 'dist/hermetica.esm.js' });
await build({ ...common, entryPoints: ['src/index.ts'], format: 'iife', globalName: 'Hermetica', outfile: 'dist/hermetica.js' });
// Opt-in modules are separate files so the core bundle (and its size budget) stays as it was.
for (const [name, global] of [['push', 'HermeticaPush'], ['inapp', 'HermeticaInApp'], ['ads', 'HermeticaAds']]) {
  await build({ ...common, entryPoints: [`src/${name}.ts`], format: 'esm', outfile: `dist/${name}.esm.js` });
  await build({ ...common, entryPoints: [`src/${name}.ts`], format: 'iife', globalName: global, outfile: `dist/${name}.js` });
}
