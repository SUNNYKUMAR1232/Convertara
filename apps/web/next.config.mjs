import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server with only the modules the app imports.
  output: 'standalone',
  // The workspace root, so tracing follows the hoisted node_modules. Must go
  // through fileURLToPath: `new URL().pathname` yields "/D:/..." on Windows and
  // tracing then silently emits nothing.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
};

export default nextConfig;

// Requests to /api/* are forwarded by app/api/[...path]/route.ts rather than by
// a rewrite, because rewrites are baked into the build and API_URL has to stay
// a runtime setting - the same image ships to every environment.
