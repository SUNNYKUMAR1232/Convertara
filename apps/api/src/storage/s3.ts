import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Config } from '../core/config.js';
import { notFound } from '../core/errors.js';
import type { ObjectStore, StoredObject } from './types.js';

/** S3 / MinIO / any S3-compatible endpoint. */
export class S3Store implements ObjectStore {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: Config) {
    this.bucket = cfg.S3_BUCKET;
    this.client = new S3Client({
      region: cfg.S3_REGION,
      endpoint: cfg.S3_ENDPOINT,
      forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
      credentials:
        cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<StoredObject> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw notFound(`Object not found: ${key}`);
      return { data: Buffer.from(bytes), contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') throw notFound(`Object not found: ${key}`);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    return this.client
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      .then(() => true)
      .catch(() => false);
  }

  /** Creates the bucket on first boot so a fresh MinIO needs no manual setup. */
  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      return true;
    }
  }
}
