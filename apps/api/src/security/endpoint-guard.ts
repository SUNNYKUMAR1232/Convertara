import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../core/config.js';
import { AppError } from '../core/errors.js';

/**
 * Guards outbound LLM endpoints.
 *
 * A user-supplied base URL is the feature - point it at your own Ollama, your
 * own gateway - and it is also a textbook SSRF primitive: the server issues a
 * request to whatever you name and reports back. On a cloud host that reaches
 * the metadata endpoint at 169.254.169.254 and every internal service besides.
 *
 * So: resolve the hostname first and check the address, not the string. A name
 * that resolves into a private range is blocked even when it looks public,
 * which is what makes DNS rebinding not work here. Deployments that legitimately
 * point at localhost set LLM_ALLOW_PRIVATE_ENDPOINTS.
 */
export async function assertSafeEndpoint(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('BAD_REQUEST', `Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('SECURITY_REJECTED', `Only http and https endpoints are allowed, got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new AppError('SECURITY_REJECTED', 'Credentials in the endpoint URL are not allowed');
  }

  if (config().LLM_ALLOW_PRIVATE_ENDPOINTS) return url;

  const addresses = await resolveAll(url.hostname);
  const blocked = addresses.find((address) => isPrivateAddress(address));
  if (blocked) {
    throw new AppError(
      'SECURITY_REJECTED',
      `${url.hostname} resolves to ${blocked}, a private or link-local address. ` +
        'Set LLM_ALLOW_PRIVATE_ENDPOINTS=true if this host is meant to reach it.',
    );
  }

  return url;
}

async function resolveAll(hostname: string): Promise<string[]> {
  if (isIP(hostname) !== 0) return [hostname];
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    throw new AppError('BAD_REQUEST', `Could not resolve ${hostname}`);
  }
}

/** Loopback, link-local, and the RFC1918 / RFC4193 private ranges. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return true; // unparseable is not provably public
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(address: string): boolean {
  const normalised = address.toLowerCase().split('%')[0] ?? '';
  if (normalised === '::1' || normalised === '::') return true;
  if (normalised.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(normalised)) return true; // unique local
  // IPv4-mapped (::ffff:169.254.169.254) inherits the v4 verdict.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  return false;
}
