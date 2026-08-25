import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server with only the modules the app imports.
  output: 'standalone',
  // The workspace root, so tracing follows the hoisted node_modules. Must go
  // through fileURLToPath: `new URL().pathname` yields "/D:/..." on Windows and
  // tracing then silently emits nothing.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  // `@/*` is declared in tsconfig.json, but Next only reads those paths when the
  // `typescript` package is resolvable. A host that installs with NODE_ENV set
  // to exactly "production" drops devDependencies, typescript goes with them,
  // and every `@/components/...` import fails to resolve while the error blames
  // the import rather than the missing compiler. Declaring the alias here keeps
  // resolution working whether or not devDependencies made it into the image.
  webpack: (config) => {
    config.resolve.alias['@'] = here;
    return config;
  },
  turbopack: { resolveAlias: { '@/*': './*' } },
};

export default nextConfig;

// Requests to /api/* are forwarded by app/api/[...path]/route.ts rather than by
// a rewrite, because rewrites are baked into the build and API_URL has to stay
// a runtime setting - the same image ships to every environment.
