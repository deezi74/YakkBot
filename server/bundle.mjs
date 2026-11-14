// Packs the server and its dependencies into one ESM file for the Android app, which runs it
// with Alpine's Node inside its own Linux. Usage: node server/bundle.mjs [out.mjs]
import { build } from 'esbuild';
import path from 'node:path';

const out = process.argv[2] ?? path.resolve(import.meta.dirname, 'dist-bundle/server.mjs');
await build({
  entryPoints: [path.resolve(import.meta.dirname, 'src/index.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  legalComments: 'linked',
  // Some dependencies still call require(); give ESM a require that works.
  banner: { js: "import { createRequire as __yakkRequire } from 'node:module'; const require = __yakkRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log(`bundled -> ${out}`);
