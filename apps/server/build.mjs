// Bundle the server (and the workspace packages it uses) into one file for production,
// so the Docker image needs only Node and dist/.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts', 'src/admin.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // pg's optional native binding isn't used.
  external: ['pg-native'],
  // Bundled CommonJS dependencies still call require().
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
