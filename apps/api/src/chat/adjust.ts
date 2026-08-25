import { z } from 'zod';
import { AppError } from '../core/errors.js';

/**
 * The operations worth exposing as controls rather than as a sentence.
 *
 * Crop, resize and rotate are spatial: what you want is a rectangle or an
 * angle, and describing either in words ("crop a bit off the left") is a worse
 * interface than dragging it. Everything else - compress to a size, convert a
 * format - is genuinely better typed, so it stays in the chat box.
 */
export const adjustSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('image.crop'),
    left: z.number().int().min(0),
    top: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({
    op: z.literal('image.resize'),
    width: z.number().int().positive().max(30000).optional(),
    height: z.number().int().positive().max(30000).optional(),
    fit: z.enum(['inside', 'cover', 'fill']).default('inside'),
  }),
  z.object({
    op: z.literal('image.rotate'),
    angle: z.number().default(0),
    flip: z.boolean().default(false),
    flop: z.boolean().default(false),
  }),
]);

export type Adjustment = z.infer<typeof adjustSchema>;

export interface BuiltAdjustment {
  plan: Record<string, unknown>;
  /** What the thread shows as the user's turn, so the history reads normally. */
  label: string;
}

export function buildAdjustment(adjustment: Adjustment): BuiltAdjustment {
  switch (adjustment.op) {
    case 'image.crop':
      return {
        label: `Crop to ${adjustment.width}x${adjustment.height} from (${adjustment.left}, ${adjustment.top})`,
        plan: plan('image.crop', {
          left: adjustment.left,
          top: adjustment.top,
          width: adjustment.width,
          height: adjustment.height,
        }),
      };

    case 'image.resize': {
      if (adjustment.width === undefined && adjustment.height === undefined) {
        throw new AppError('BAD_REQUEST', 'A resize needs a width or a height');
      }
      const size = [adjustment.width, adjustment.height].filter((n) => n !== undefined).join('x');
      return {
        label: `Resize to ${size}`,
        plan: plan('image.resize', {
          ...(adjustment.width !== undefined ? { width: adjustment.width } : {}),
          ...(adjustment.height !== undefined ? { height: adjustment.height } : {}),
          fit: adjustment.fit,
          // The point of dragging a number is to get that number, so an
          // explicit adjustment is allowed to scale up.
          withoutEnlargement: false,
        }),
      };
    }

    case 'image.rotate': {
      const bits = [
        adjustment.angle !== 0 ? `${adjustment.angle} degrees` : '',
        adjustment.flip ? 'flip vertical' : '',
        adjustment.flop ? 'flip horizontal' : '',
      ].filter((b) => b !== '');
      if (bits.length === 0) throw new AppError('BAD_REQUEST', 'Nothing to rotate or flip');
      return {
        label: `Rotate: ${bits.join(', ')}`,
        plan: plan('image.rotate', {
          angle: adjustment.angle,
          flip: adjustment.flip,
          flop: adjustment.flop,
        }),
      };
    }
  }
}

function plan(op: string, params: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    intent: op,
    operations: [{ op, params }],
    // No constraints: the user gave exact numbers, so there is nothing to
    // optimise towards and nothing to second-guess.
    constraints: {},
    output: { bundle: 'single' },
  };
}
