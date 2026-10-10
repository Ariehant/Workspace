/**
 * The editor's sources (its schema, which the API uses for page content) call Vite's
 * `import.meta.glob`; the server's build swaps that call out (see build.mjs).
 */
interface ImportMeta {
  glob<T>(
    patterns: string | string[],
    options?: { import?: string },
  ): Record<string, () => Promise<T>>;
}
