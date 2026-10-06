// The throwaway Postgres URL provided by storage-remote's test setup.
declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}
export {};
