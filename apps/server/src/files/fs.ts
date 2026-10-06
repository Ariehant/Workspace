import { createReadStream } from 'node:fs';
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { FileStorage } from './storage';

/** Files in a folder (a Docker volume), for single-machine installs and tests. */
export class FsStorage implements FileStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error('Invalid file key');
    return path;
  }

  async has(key: string): Promise<boolean> {
    try {
      await access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, bytes: Uint8Array, _mime?: string): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write under a temp name first: a crash never leaves a truncated file under its id.
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(key: string) {
    const path = this.path(key);
    try {
      const { size } = await stat(path);
      return { body: createReadStream(path), size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root);
  }
}
