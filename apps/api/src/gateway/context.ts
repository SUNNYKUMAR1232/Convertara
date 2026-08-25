import type { FastifyRequest } from 'fastify';
import { config } from '../core/config.js';

/**
 * Ownership scope for every stored object.
 *
 * There is no user system here on purpose - the deployment in front of this API
 * (an SSO proxy, an API gateway, your own auth service) sets `x-owner-id` and
 * everything below it is already scoped. Swapping in real auth means replacing
 * this one function.
 *
 * The header is ignored unless TRUST_OWNER_HEADER says something upstream is
 * actually setting it. A documented seam with an undefended default is not a
 * seam: without the flag, anyone could read any tenant's files by sending a
 * header. Off, the whole deployment is explicitly single-tenant.
 */
export function ownerOf(request: FastifyRequest): string {
  if (!config().TRUST_OWNER_HEADER) return 'public';

  const header = request.headers['x-owner-id'];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim();
  if (trimmed && /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return trimmed;
  return 'public';
}
