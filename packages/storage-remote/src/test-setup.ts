import type { TestProject } from 'vitest/node';
import { startTestPostgres } from './testing';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

/** One throwaway cluster for the whole test run. */
export default async function setup(project: TestProject) {
  const pg = await startTestPostgres();
  project.provide('pgUrl', pg.url);
  return () => pg.stop();
}
