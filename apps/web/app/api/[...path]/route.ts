import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Runtime proxy to the API.
 *
 * Two deliberate choices here:
 *
 * 1. Not a `next.config` rewrite. Rewrites are baked into the build, which
 *    would freeze whatever API_URL was set when the image was built. Reading it
 *    at request time means one image runs in dev and in compose unchanged.
 *
 * 2. Not `fetch`. Next patches global fetch for its cache, and the patched
 *    version cannot forward a streaming request body - a multipart upload fails
 *    outright. Going through node:http streams both directions, so a 200MB
 *    upload never has to fit in memory and SSE progress arrives event by event
 *    instead of at the end.
 */
const API_URL = new URL((process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, ''));

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'host',
  'content-length',
]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const target = `${API_URL.pathname.replace(/\/$/, '')}/${path.join('/')}${request.nextUrl.search}`;

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  });

  const transport = API_URL.protocol === 'https:' ? https : http;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  return new Promise<Response>((resolve) => {
    const upstream = transport.request(
      {
        protocol: API_URL.protocol,
        hostname: API_URL.hostname,
        port: API_URL.port || (API_URL.protocol === 'https:' ? 443 : 80),
        path: target,
        method: request.method,
        headers,
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
          responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }

        resolve(
          new Response(Readable.toWeb(response) as ReadableStream, {
            status: response.statusCode ?? 502,
            headers: responseHeaders,
          }),
        );
      },
    );

    upstream.on('error', (error) => {
      resolve(
        Response.json(
          {
            error: {
              code: 'UPSTREAM_UNAVAILABLE',
              message: `Could not reach the API at ${API_URL.origin}: ${error.message}`,
            },
          },
          { status: 502 },
        ),
      );
    });

    if (hasBody && request.body) {
      Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])
        .on('error', () => upstream.destroy())
        .pipe(upstream);
    } else {
      upstream.end();
    }
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
