export interface StoredObject {
  data: Buffer;
  contentType: string;
}

/**
 * Binary blobs live here; Postgres only ever holds the metadata that points at
 * them. Swapping local disk for S3 is a config change, not a code change.
 */
export interface ObjectStore {
  readonly driver: 'local' | 's3';
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Best-effort health probe used by /health. */
  ping(): Promise<boolean>;
}

export type Bucket = 'original' | 'working' | 'result';

export function objectKey(bucket: Bucket, id: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `${bucket}/${id.slice(0, 2)}/${id}/${safe}`;
}
