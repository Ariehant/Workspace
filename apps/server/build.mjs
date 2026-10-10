// Bundle the server (and the workspace packages it uses) into one file for production,
// so the Docker image needs only Node and dist/.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

/**
 * The editor (its schema, for the API's page content) loads more code-highlighting
 * grammars with Vite's `import.meta.glob`; the server never highlights, so it gets none.
 */
const noViteGlob = {
  name: 'no-vite-glob',
  setup(b) {
    b.onLoad({ filter: /editor[\\/]src[\\/]nodes[\\/]languages\.ts$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      return {
        contents: source.replace(/import\.meta\.glob<[^>]+>\([\s\S]*?\n\);/, '({});'),
        loader: 'ts',
      };
    });
  },
};

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
  plugins: [noViteGlob],
  logLevel: 'warning',
});
