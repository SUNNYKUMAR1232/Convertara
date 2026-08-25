import { describe, expect, it } from 'vitest';
import { buildAdjustment } from '../src/chat/adjust.js';
import { humaniseError } from '../src/chat/errors.js';
import { classifyTurn } from '../src/chat/intent.js';
import { AppError } from '../src/core/errors.js';

/**
 * These come from watching someone actually use it. Every case below produced a
 * wrong or machine-shaped reply in the real UI.
 */

describe('a file attached does not make a message an instruction', () => {
  it.each(['do', 'ok', 'hmm', 'go'])('treats a shrug like "%s" as unclear, not work', (text) => {
    expect(classifyTurn(text, true)).toBe('unclear');
  });

  it.each(['what you do', 'what you can do', 'what can you do', 'what all can you do', 'what do you do'])(
    'answers "%s" with capabilities even with a file attached',
    (text) => {
      expect(classifyTurn(text, true)).toBe('capabilities');
    },
  );

  it('still recognises real instructions', () => {
    expect(classifyTurn('convert to JPG', true)).toBe('operation');
    expect(classifyTurn('compress to 300kb', true)).toBe('operation');
    expect(classifyTurn('rotate 90 degrees', true)).toBe('operation');
    expect(classifyTurn('make it 800 wide', true)).toBe('operation');
  });

  it('treats a question as a question even with a file attached', () => {
    expect(classifyTurn('is this a good format for the web?', true)).toBe('question');
    expect(classifyTurn('how big is it', true)).toBe('question');
  });
});

describe('errors are written for a person', () => {
  it('never leaks an operation name and a validation failure', () => {
    const text = humaniseError(new AppError('PLAN_INVALID', 'Invalid parameters for "image.compress"'));
    expect(text).not.toMatch(/image\.compress/);
    expect(text).not.toMatch(/Invalid parameters/);
    expect(text).toMatch(/put it another way/i);
  });

  it('explains a type mismatch in plain terms', () => {
    const text = humaniseError(new AppError('PLAN_INVALID', '"archive.inspect" cannot accept image/jpeg'));
    expect(text).toMatch(/Inspecting an archive/);
    expect(text).toMatch(/a JPEG/);
    expect(text).not.toMatch(/archive\.inspect/);
  });

  it('turns an engine failure into a cause and a next step', () => {
    expect(humaniseError(new AppError('EXECUTION_FAILED', 'archive.inspect failed: invalid zip data'))).toMatch(
      /needs a zip archive/,
    );
    expect(
      humaniseError(new AppError('EXECUTION_FAILED', 'pdf.merge failed: Input document is encrypted')),
    ).toMatch(/password protected/);
  });

  it('says what to install when a capability is off', () => {
    const text = humaniseError(
      new AppError('CAPABILITY_UNAVAILABLE', 'nope', { operation: 'pdf.compress' }),
    );
    expect(text).toMatch(/Compressing PDFs/);
    expect(text).toMatch(/Ghostscript/);
  });

  it('falls back to something sane for an unknown failure', () => {
    expect(humaniseError(new Error('kaboom'))).toMatch(/Something went wrong/);
    expect(humaniseError(new Error('kaboom'))).not.toMatch(/kaboom/);
  });
});

describe('editor adjustments become exact plans', () => {
  it('crops with the numbers it was given and no constraints to optimise', () => {
    const { plan, label } = buildAdjustment({ op: 'image.crop', left: 80, top: 60, width: 321, height: 281 });
    expect(label).toBe('Crop to 321x281 from (80, 60)');
    expect((plan.operations as any[])[0]).toEqual({
      op: 'image.crop',
      params: { left: 80, top: 60, width: 321, height: 281 },
    });
    expect(plan.constraints).toEqual({});
  });

  it('allows an explicit resize to enlarge', () => {
    // A typed instruction should not upscale by accident, but a number someone
    // deliberately entered in the editor should be honoured.
    const { plan } = buildAdjustment({ op: 'image.resize', width: 4000, fit: 'fill' });
    expect((plan.operations as any[])[0].params).toMatchObject({ width: 4000, withoutEnlargement: false });
  });

  it('describes a rotate the way the thread should read', () => {
    expect(buildAdjustment({ op: 'image.rotate', angle: 90, flip: false, flop: true }).label).toBe(
      'Rotate: 90 degrees, flip horizontal',
    );
  });

  it('refuses an adjustment that would do nothing', () => {
    expect(() => buildAdjustment({ op: 'image.rotate', angle: 0, flip: false, flop: false })).toThrow();
    expect(() => buildAdjustment({ op: 'image.resize', fit: 'inside' })).toThrow(/width or a height/);
  });
});
