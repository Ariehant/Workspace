import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createLog } from './log';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

it('writes lines, and keeps 1 MB plus two older files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-log-'));
  dirs.push(dir);
  const log = createLog(dir);
  log('info', 'start');
  expect(readFileSync(join(dir, 'calendar.log'), 'utf8')).toMatch(/^\S+Z INFO start\n$/);
  const line = 'x'.repeat(10_000);
  for (let i = 0; i < 400; i++) log('warn', line);
  expect(existsSync(join(dir, 'calendar.log.1'))).toBe(true);
  expect(existsSync(join(dir, 'calendar.log.2'))).toBe(true);
  expect(existsSync(join(dir, 'calendar.log.3'))).toBe(false);
  expect(statSync(join(dir, 'calendar.log')).size).toBeLessThan(1024 * 1024 + 20_000);
});
