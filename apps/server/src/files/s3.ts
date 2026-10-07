import { createReadStream } from 'node:fs';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { ByteRange, FileStorage } from './storage';

export interface S3Options {
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const notFound = (error: unknown) => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
};

/** Files in an S3 bucket: MinIO in the Compose stack, or any S3-compatible service. */
export class S3Storage implements FileStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketReady = false;

  constructor(options: S3Options) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (notFound(error)) return false;
      throw error;
    }
  }

  async put(key: string, bytes: Uint8Array, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mime }),
    );
  }

  async putFile(key: string, path: string, size: number, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: mime,
      }),
    );
  }

  async get(key: string, range?: ByteRange) {
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      // With a range, the whole size is after the slash of Content-Range.
      const total = out.ContentRange ? Number(out.ContentRange.split('/')[1]) : NaN;
      return {
        body: out.Body as Readable,
        size: Number.isFinite(total) ? total : Number(out.ContentLength ?? 0),
      };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Fails if S3 can't be reached; creates the bucket the first time. */
  async check(): Promise<void> {
    if (this.bucketReady) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!notFound(error)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    this.bucketReady = true;
  }
}
