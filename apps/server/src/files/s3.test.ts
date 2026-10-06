import { describe, expect, it } from 'vitest';
import { fileKey } from './storage';
import { S3Storage } from './s3';

/**
 * Against a real S3 API (the Compose stack's SeaweedFS, MinIO...): set S3_TEST_ENDPOINT,
 * S3_TEST_ACCESS_KEY_ID and S3_TEST_SECRET_ACCESS_KEY to run it.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.skipIf(!endpoint)('file storage (S3)', () => {
  it('creates its bucket, stores, reads and deletes files', async () => {
    const storage = new S3Storage({
      endpoint: endpoint!,
      region: 'us-east-1',
      bucket: `test-${Date.now()}`,
      accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: true,
    });
    await storage.check();
    const key = fileKey('8d5f0a39-4a43-4f6b-9a8e-2f0c1f3c5d6e', `${'b'.repeat(64)}.txt`);
    expect(await storage.has(key)).toBe(false);
    await storage.put(key, new TextEncoder().encode('torque table'), 'text/plain');
    expect(await storage.has(key)).toBe(true);
    const got = await storage.get(key);
    expect(got?.size).toBe(12);
    const chunks: Uint8Array[] = [];
    for await (const chunk of got!.body) chunks.push(chunk as Uint8Array);
    expect(Buffer.concat(chunks).toString()).toBe('torque table');
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
  });
});
