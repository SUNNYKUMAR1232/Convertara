import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../core/config.js';
import { AppError } from '../core/errors.js';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Provider API keys are encrypted at rest with AES-256-GCM. They are decrypted
 * only in the process that is about to call the provider, and never returned
 * to a client - the API only ever echoes a masked hint.
 */
function key(): Buffer {
  const raw = config().SECRET_KEY;
  if (!raw) {
    throw new AppError(
      'INTERNAL',
      'SECRET_KEY is not set, so provider API keys cannot be stored. Generate one with: openssl rand -hex 32',
    );
  }
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  // Anything that is not already 32 bytes gets hashed to 32, so a passphrase works too.
  return decoded.length === 32 ? decoded : createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !data) {
    throw new AppError('INTERNAL', 'Stored API key is malformed');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError('INTERNAL', 'Stored API key could not be decrypted - has SECRET_KEY changed?');
  }
}

/** What the API is allowed to show: enough to recognise a key, not to use it. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return '••••';
  return `${plaintext.slice(0, 3)}••••${plaintext.slice(-4)}`;
}

export function secretKeyConfigured(): boolean {
  return Boolean(config().SECRET_KEY);
}
