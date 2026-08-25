import { describe, expect, it } from 'vitest';
import { OPERATION_WORDS, planFromRules } from '../src/agent/fast-path.js';
import { isPrivateAddress, assertSafeEndpoint } from '../src/security/endpoint-guard.js';
import type { WorkFile } from '../src/router/types.js';

/**
 * Each of these locks in a ruling from the architecture review. They are here
 * because the failure they prevent is silent - nothing else in the suite would
 * go red if one of these regressed.
 */

const image = (): WorkFile => ({ name: 'p.jpg', data: Buffer.alloc(16), mime: 'image/jpeg', meta: {} });

describe('T5 — a word cannot be both filler and an instruction', () => {
  it('has no overlap between FILLER and the operation vocabulary', async () => {
    // FILLER is module-private on purpose, so read it the way a reviewer would.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/agent/fast-path.ts', import.meta.url), 'utf8'),
    );
    const fillerBlock = /const FILLER = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1] ?? '';
    const filler = [...fillerBlock.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

    expect(filler.length).toBeGreaterThan(50);

    const overlap = filler.filter((word) => word !== undefined && OPERATION_WORDS.includes(word));
    expect(overlap, 'a word in both sets means a silently dropped instruction').toEqual([]);
  });

  it('still handles the phrasing that dropping "make" from filler put at risk', () => {
    const plan = planFromRules('make it 300kb', [image()])?.plan;
    expect(plan?.operations[0]?.op).toBe('image.compress');
    expect(plan?.constraints.size?.target).toBe(300);
  });

  it('defers rather than ignoring an instruction it cannot express', () => {
    // "watermark" and "archive" are both things the rules cannot do; neither
    // may be quietly absorbed.
    expect(planFromRules('convert to webp and watermark it', [image()])).toBeUndefined();
    expect(planFromRules('convert to webp and archive it', [image()])?.plan.operations.map((o) => o.op)).toContain(
      'archive.create',
    );
  });
});

describe('T1 — outbound LLM endpoints cannot reach private space', () => {
  it.each([
    ['169.254.169.254', 'cloud metadata'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'RFC1918'],
    ['192.168.0.5', 'RFC1918'],
    ['172.16.0.1', 'RFC1918'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique local'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ])('treats %s as private (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888'])('treats %s as public', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('rejects the metadata endpoint outright', async () => {
    await expect(assertSafeEndpoint('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private or link-local/);
  });

  it('rejects a non-http scheme and embedded credentials', async () => {
    await expect(assertSafeEndpoint('file:///etc/passwd')).rejects.toThrow(/http and https/);
    await expect(assertSafeEndpoint('http://user:pass@example.com')).rejects.toThrow(/Credentials/);
  });

  it('allows a public endpoint', async () => {
    const url = await assertSafeEndpoint('https://api.openai.com/v1');
    expect(url.hostname).toBe('api.openai.com');
  });
});
