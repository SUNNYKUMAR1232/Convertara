/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Everything under /api is proxied to the Fastify service, so the browser
  // only ever talks to one origin - no CORS, no separate URL to configure.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${apiUrl}/:path*` },
    ];
  },
};

export default nextConfig;
