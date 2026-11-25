/**
 * A small rotating log in the data folder (HANDOFF.md 2): what the app did and what failed,
 * never tokens or event contents. `calendar.log` up to 1 MB, then two older files.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const KEEP = 2;

export type LogLevel = 'info' | 'warn' | 'error';
export type Log = (level: LogLevel, message: string) => void;

export function createLog(dir: string): Log {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'calendar.log');
  return (level, message) => {
    try {
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // no file yet
      }
      if (size > MAX_BYTES) {
        rmSync(`${file}.${KEEP}`, { force: true });
        for (let i = KEEP - 1; i >= 1; i--) {
          try {
            renameSync(`${file}.${i}`, `${file}.${i + 1}`);
          } catch {
            // not there
          }
        }
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
    } catch {
      // A log that can't be written mustn't stop the app.
    }
  };
}
