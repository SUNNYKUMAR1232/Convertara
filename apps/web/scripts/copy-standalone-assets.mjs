/**
 * `output: 'standalone'` emits server.js and the traced node_modules, but not
 * .next/static or public - Next leaves those for the deployer to place. The
 * Dockerfile does it with two COPY lines, so the image is fine; anything that
 * runs the standalone server straight out of the build directory is not, and
 * the failure is quiet: HTML renders and every stylesheet and script 404s.
 *
 * Copying them here means the standalone tree is complete wherever it is built.
 */
import { access, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(webRoot, '.next', 'standalone', 'apps', 'web');

const assets = [
  { from: path.join(webRoot, '.next', 'static'), to: path.join(standalone, '.next', 'static') },
  { from: path.join(webRoot, 'public'), to: path.join(standalone, 'public') },
];

for (const { from, to } of assets) {
  try {
    await access(from);
  } catch {
    // A project without a public/ directory is legitimate; static always exists.
    continue;
  }
  await cp(from, to, { recursive: true });
  console.log(`copied ${path.relative(webRoot, from)} -> ${path.relative(webRoot, to)}`);
}
