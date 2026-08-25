import type { FastifyRequest } from 'fastify';

/**
 * Ownership scope for every stored object.
 *
 * There is no user system here on purpose - the deployment in front of this API
 * (an SSO proxy, an API gateway, your own auth service) sets `x-owner-id` and
 * everything below it is already scoped. Swapping in real auth means replacing
 * this one function.
 */
export function ownerOf(request: FastifyRequest): string {
  const header = request.headers['x-owner-id'];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim();
  if (trimmed && /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return trimmed;
  return 'public';
}
