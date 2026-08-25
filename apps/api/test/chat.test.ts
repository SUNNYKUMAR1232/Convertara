import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { classifyTurn, greetingReply, thanksReply } from '../src/chat/intent.js';
import { describeResult } from '../src/chat/reply.js';
import type { ReplyFile } from '../src/chat/reply.js';
import { handleTurn } from '../src/chat/service.js';
import { planSchema } from '../src/core/plan.js';
import type { JobRecord } from '../src/db/types.js';
import { archiveEngine } from '../src/engines/archive/index.js';
import { imageEngine } from '../src/engines/image/index.js';
import { pdfEngine } from '../src/engines/pdf/index.js';
import { ingest } from '../src/execution/pipeline.js';
import { registry } from '../src/router/registry.js';

describe('what kind of turn is this', () => {
  it('answers greetings and thanks without a model', () => {
    expect(classifyTurn('hi', false)).toBe('greeting');
    expect(classifyTurn('Hello!', false)).toBe('greeting');
    expect(classifyTurn('thanks', true)).toBe('thanks');
    expect(classifyTurn('thank you!', false)).toBe('thanks');
    expect(greetingReply(false)).toMatch(/Drop in/);
    expect(thanksReply(true)).toMatch(/Any time/);
  });

  it('answers "what can you do" from the registry rather than the model', () => {
    expect(classifyTurn('what can you do?', false)).toBe('capabilities');
    expect(classifyTurn('help', false)).toBe('capabilities');
  });

  it('treats an instruction with a file in play as work', () => {
    expect(classifyTurn('now convert it to png', true)).toBe('operation');
    expect(classifyTurn('compress to 300kb', true)).toBe('operation');
  });

  it('treats an open question with no file as a question', () => {
    expect(classifyTurn('which is smaller, webp or avif?', false)).toBe('question');
  });
});

describe('how a finished turn is described', () => {
  const job = (plan: unknown, status: JobRecord['status'] = 'succeeded'): JobRecord =>
    ({
      id: 'j',
      ownerId: 'public',
      status,
      prompt: null,
      plan: planSchema.parse(plan),
      planSource: 'fast-path',
      inputFileIds: [],
      outputFileIds: [],
      progress: 1,
      stage: 'done',
      evaluation: null,
      error: status === 'partial' ? { code: 'CONSTRAINT_UNSATISFIABLE', message: 'x' } : null,
      timings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as JobRecord;

  const file = (bytes: number, mime = 'image/jpeg', meta: Record<string, unknown> = {}): ReplyFile => ({
    filename: 'photo.jpg',
    bytes,
    mime,
    meta,
  });

  it('names the instruction, not its side effect', () => {
    // A resize almost always shrinks the file too; the reply should still say
    // it resized, because that is what was asked for.
    const text = describeResult(
      job({ intent: 'r', operations: [{ op: 'image.resize', params: { width: 400 } }], constraints: {} }),
      [file(320_000)],
      [file(26_000, 'image/jpeg', { width: 400, height: 300 })],
    );
    expect(text).toMatch(/Resized that to 400x300/);
    expect(text).not.toMatch(/Compressed/);
  });

  it('phrases a ceiling differently from a target window', () => {
    const ceiling = describeResult(
      job({
        intent: 'c',
        operations: [{ op: 'image.compress', params: {} }],
        constraints: { size: { target: 20, unit: 'KB', tolerance: 0, mode: 'max' } },
      }),
      [file(26_000)],
      [file(15_000)],
    );
    expect(ceiling).toMatch(/under the .* ceiling you set/);
    expect(ceiling).not.toMatch(/inside your at most/);

    const window = describeResult(
      job({
        intent: 'c',
        operations: [{ op: 'image.compress', params: {} }],
        constraints: { size: { target: 300, unit: 'KB', tolerance: 0.05, mode: 'target' } },
      }),
      [file(2_600_000)],
      [file(319_000)],
    );
    expect(window).toMatch(/inside your/);
  });

  it('says plainly when it missed, and that the file is attached anyway', () => {
    const text = describeResult(
      job(
        {
          intent: 'c',
          operations: [{ op: 'image.compress', params: {} }],
          constraints: { size: { target: 5, unit: 'KB', tolerance: 0.05, mode: 'target' } },
        },
        'partial',
      ),
      [file(2_600_000)],
      [file(6_140)],
    );
    expect(text).toMatch(/misses the/);
    expect(text).toMatch(/attached/);
  });

  it('describes merges and archives in their own terms', () => {
    expect(
      describeResult(
        job({ intent: 'm', operations: [{ op: 'pdf.merge', params: {} }], constraints: {} }),
        [file(1000, 'application/pdf'), file(1000, 'application/pdf')],
        [{ filename: 'merged.pdf', bytes: 1800, mime: 'application/pdf', meta: { pages: 5 } }],
      ),
    ).toMatch(/Merged 2 PDFs .*5 pages/);

    expect(
      describeResult(
        job({ intent: 'z', operations: [{ op: 'archive.create', params: {} }], constraints: {} }),
        [file(1000), file(1000)],
        [{ filename: 'archive.zip', bytes: 1900, mime: 'application/zip', meta: {} }],
      ),
    ).toMatch(/Zipped 2 files/);
  });
});

describe('a follow-up turn inherits the last result', () => {
  beforeAll(async () => {
    registry.reset();
    await registry.register(imageEngine);
    await registry.register(pdfEngine);
    await registry.register(archiveEngine);
  });

  it('applies "now convert it to png" to what the previous turn produced', async () => {
    const source = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 140, b: 200 } },
    })
      .jpeg({ quality: 100 })
      .toBuffer();

    const [uploaded] = await ingest('public', [{ filename: 'photo.jpg', data: source }]);
    expect(uploaded).toBeDefined();

    const first = await drain(
      handleTurn({ ownerId: 'public', text: 'convert to webp', fileIds: [uploaded!.id] }),
    );
    expect(first.text).toMatch(/WebP/i);
    expect(first.attachments[0]?.mime).toBe('image/webp');

    // No fileIds at all on the second turn - it has to find them in the thread.
    const second = await drain(
      handleTurn({ ownerId: 'public', conversationId: first.conversationId, text: 'now convert it to png' }),
    );
    expect(second.attachments[0]?.mime).toBe('image/png');
  }, 60_000);
});

async function drain(stream: ReturnType<typeof handleTurn>) {
  let text = '';
  let conversationId = '';
  let attachments: Array<{ mime: string; filename: string; bytes: number }> = [];

  for await (const event of stream) {
    if (event.type === 'conversation') conversationId = event.id;
    if (event.type === 'delta') text += event.text;
    if (event.type === 'done') attachments = event.message.attachments;
  }
  return { text, conversationId, attachments };
}
