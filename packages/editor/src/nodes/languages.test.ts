import { describe, expect, it } from 'vitest';
import { COMMON_LANGUAGES, MORE_LANGUAGES, ensureLanguage, lowlight } from './languages';

describe('code languages', () => {
  it('offers the common set and Mermaid up front, the rest on demand', () => {
    expect(COMMON_LANGUAGES.map((l) => l.id)).toEqual(
      expect.arrayContaining(['plaintext', 'python', 'cpp', 'mermaid']),
    );
    expect(MORE_LANGUAGES.length).toBeGreaterThan(100);
    expect(MORE_LANGUAGES.map((l) => l.id)).toContain('cmake');
    expect(MORE_LANGUAGES.find((l) => l.id === 'cmake')!.label).toBe('CMake');
  });

  it('loads a grammar when first used', async () => {
    expect(lowlight.registered('cmake')).toBe(false);
    expect(await ensureLanguage('cmake')).toBe(true);
    expect(lowlight.registered('cmake')).toBe(true);
    const tree = lowlight.highlight('cmake', 'add_executable(robot main.cpp)');
    expect(JSON.stringify(tree)).toContain('hljs-');
    expect(await ensureLanguage('no-such-language')).toBe(false);
  });

  it('highlights Mermaid', () => {
    const tree = lowlight.highlight('mermaid', 'graph TD\n  A["Start"] --> B %% note');
    const json = JSON.stringify(tree);
    expect(json).toContain('hljs-keyword');
    expect(json).toContain('hljs-comment');
  });
});
