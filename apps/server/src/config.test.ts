import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

describe('config', () => {
  it('has defaults for everything but the database', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://db/workspace' });
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 3000,
      publicUrl: 'http://localhost:3000',
      files: { driver: 'fs', dir: './data/files' },
      signup: 'invite',
      maxFileBytes: 512 * 1024 * 1024,
    });
  });

  it('reads S3 settings', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://db/w',
      FILES_DRIVER: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'files',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      PUBLIC_URL: 'https://notes.example.com/',
    });
    expect(config.files).toEqual({
      driver: 's3',
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'files',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    });
    expect(config.publicUrl).toBe('https://notes.example.com');
  });

  it('reports every problem at once', () => {
    expect(() =>
      loadConfig({ PORT: 'eighty', FILES_DRIVER: 's3', SIGNUP: 'maybe', PUBLIC_URL: 'ftp://x' }),
    ).toThrow(ConfigError);
    try {
      loadConfig({ PORT: 'eighty', FILES_DRIVER: 's3', SIGNUP: 'maybe', PUBLIC_URL: 'ftp://x' });
    } catch (error) {
      const message = (error as Error).message;
      for (const name of ['PORT', 'PUBLIC_URL', 'S3_BUCKET', 'SIGNUP', 'DATABASE_URL']) {
        expect(message).toContain(name);
      }
    }
  });
});
