// tsc only emits JS, so non-TS assets (the SQL schema) are copied by hand.
import { cp, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const assets = [['src/db/schema.sql', 'dist/db/schema.sql']];

for (const [from, to] of assets) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
  console.log(`copied ${from} -> ${to}`);
}
