import type { Config } from '../config';
import { FsStorage } from './fs';
import { S3Storage } from './s3';
import type { FileStorage } from './storage';

export * from './storage';
export { FsStorage } from './fs';
export { S3Storage } from './s3';

export function createFileStorage(files: Config['files']): FileStorage {
  return files.driver === 's3' ? new S3Storage(files) : new FsStorage(files.dir);
}
