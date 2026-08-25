import { OPERATION_WORDS } from '../agent/fast-path.js';
import { registry } from '../router/registry.js';

export type TurnKind = 'operation' | 'capabilities' | 'greeting' | 'thanks' | 'unclear' | 'question';

/** Question-shaped openers. "what you do" is a question even without a "?". */
const QUESTION = /^(what|what's|whats|how|why|which|who|when|where|can you|do you|could you|are you|is it|does it|will it|should i|tell me)\b/;

/** Anything that could plausibly be an instruction rather than a question. */
const INSTRUCTION_TOKEN = new RegExp(
  `\\b(${OPERATION_WORDS.join('|')}|webp|jpe?g|png|avif|tiff?|gif|pdf|zip|kb|mb|gb|px|pixels|quality|smaller|bigger|width|height)\\b|\\d`,
  'i',
);

/**
 * Decides what kind of turn this is before any planning happens.
 *
 * The hard-won rule here is the last one: having a file attached does not make
 * a message an instruction. Treating every message as work is how "what can you
 * do" ended up planned as an image operation and answered with a type error.
 * A turn only counts as work if it actually contains something instruction
 * shaped.
 */
export function classifyTurn(text: string, hasFiles: boolean): TurnKind {
  const trimmed = text.trim().toLowerCase().replace(/[!.?]+$/, '');
  if (trimmed === '') return hasFiles ? 'unclear' : 'greeting';

  if (/^(hi|hey|hello|yo|good (morning|afternoon|evening))\b/.test(trimmed)) return 'greeting';
  if (/^(thanks|thank you|ta|cheers|nice|perfect|great|awesome|lovely|cool)\b/.test(trimmed)) return 'thanks';

  // Deliberately loose: people write "what you do", "what all can you do",
  // "what do u do". Any of them should get the capability list, not a plan.
  if (
    /\b(what|which|tell me).{0,20}\b(can|could|do|does|are|is)?\s*(you|u|this|it)?\s*(can|do|does|able)?\b.{0,10}\b(do|doing|handle|support|offer|formats?|capabilit)/.test(
      trimmed,
    ) ||
    /^(help|help me|what is this|how does this work|how do i use this|what are you)\b/.test(trimmed)
  ) {
    return 'capabilities';
  }

  const looksLikeQuestion = QUESTION.test(trimmed) || /\?$/.test(text.trim());
  if (looksLikeQuestion) return 'question';

  // No instruction token anywhere means we have no idea what was wanted. Say so
  // rather than handing a shrug to the planner and rendering whatever it emits.
  if (!INSTRUCTION_TOKEN.test(trimmed)) return hasFiles ? 'unclear' : 'question';

  return hasFiles ? 'operation' : 'question';
}

export function greetingReply(hasFiles: boolean): string {
  if (hasFiles) return 'Got the file. What would you like me to do with it?';
  return 'Hello. Drop in an image, PDF or zip and tell me what you need doing to it.';
}

export function thanksReply(hasFiles: boolean): string {
  return hasFiles ? 'Any time. Say the word if you want anything else done to it.' : 'Any time.';
}

export function unclearReply(filename?: string): string {
  const what = filename ? `to ${filename}` : 'to that';
  return `I am not sure what you want me to do ${what}. Try something like "compress to 300 KB", "convert to JPG", "resize to 1200px", or "rotate 90 degrees".`;
}

/** Answers "what can you do" from the live registry, so it can never go stale. */
export async function capabilitiesReply(): Promise<string> {
  const described = await registry.describe();
  const byDomain = new Map<string, string[]>();

  for (const capability of described.capabilities) {
    if (!capability.available) continue;
    const short = capability.name.split('.')[1] ?? capability.name;
    byDomain.set(capability.domain, [...(byDomain.get(capability.domain) ?? []), short]);
  }

  const lines = [...byDomain.entries()].map(([domain, names]) => `**${domain}** - ${names.join(', ')}`);

  const unavailable = described.capabilities.filter((c) => !c.available).map((c) => c.name);
  const caveat = unavailable.length > 0 ? `\n\nNot available on this deployment: ${unavailable.join(', ')}.` : '';

  return (
    [
      'Here is what I can do right now:',
      '',
      ...lines,
      '',
      'The useful part is that I take exact constraints. "Compress to 300 KB give or take 5%" is a target I hit and then verify, rather than a hint. Attach a file and say what you need.',
    ].join('\n') + caveat
  );
}
