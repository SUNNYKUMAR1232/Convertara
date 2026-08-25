import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { notFound } from '../core/errors.js';
import type { ObjectStore, StoredObject } from './types.js';

/** Filesystem-backed store. Default in development so the app runs with no infra. */
export class LocalStore implements ObjectStore {
  readonly driver = 'local' as const;
  private readonly root: string;
  private readonly types = new Map<string, string>();

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    const full = resolve(join(this.root, key));
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || rel.startsWith(`${sep}..`)) {
      throw new Error(`Refusing to write outside the storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
    await writeFile(`${file}.type`, contentType, 'utf8');
    this.types.set(key, contentType);
  }

  async get(key: string): Promise<StoredObject> {
    const file = this.path(key);
    try {
      const data = await readFile(file);
      const contentType =
        this.types.get(key) ?? (await readFile(`${file}.type`, 'utf8').catch(() => 'application/octet-stream'));
      return { data, contentType };
    } catch {
      throw notFound(`Object not found: ${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.path(key);
    await rm(file, { force: true });
    await rm(`${file}.type`, { force: true });
    this.types.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return stat(this.path(key))
      .then(() => true)
      .catch(() => false);
  }

  async ping(): Promise<boolean> {
    await mkdir(this.root, { recursive: true });
    return true;
  }
}
