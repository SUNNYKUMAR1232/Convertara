import { randomUUID, randomBytes } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Short, URL-safe, non-guessable token used for download links. */
export const newToken = (): string => randomBytes(18).toString('base64url');
