import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The desktop's import worker is bundled by electron-vite, which puts its CommonJS shim
 * after the last thing its regex takes for an `import` statement (electron-vite's
 * `ESMStaticImportRe`, copied here). Text like "the import's page … '" in a comment
 * matches it, and the shim then lands in the middle of the code, breaking the build.
 */
const ESM_STATIC_IMPORT =
  /(?<=\s|^|;)import\s*([\s"']*(?<imports>[\p{L}\p{M}\w\t\n\r $*,/{}@.]+)from\s*)?["']\s*(?<specifier>(?<="\s*)[^"]*[^\s"](?=\s*")|(?<='\s*)[^']*[^\s'](?=\s*'))\s*["'][\s;]*/gmu;
const REAL_IMPORT = /^import\s[^'"]*?(?:from\s*)?'[^'\n]+';?\s*$/;

describe('the importers, as the desktop bundles them', () => {
  it('have no text the bundler takes for an import statement', () => {
    const dir = __dirname;
    const found = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .flatMap((f) =>
        [...readFileSync(join(dir, f), 'utf8').matchAll(ESM_STATIC_IMPORT)]
          .map((m) => m[0])
          .filter((text) => !REAL_IMPORT.test(text))
          .map((text) => `${f}: ${text.slice(0, 60)}`),
      );
    expect(found).toEqual([]);
  });
});
