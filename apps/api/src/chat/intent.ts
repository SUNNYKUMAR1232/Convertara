import { registry } from '../router/registry.js';

export type TurnKind = 'operation' | 'capabilities' | 'greeting' | 'thanks' | 'question';

/**
 * Decides what kind of turn this is before any planning happens.
 *
 * Same principle as the fast path: a greeting and "what can you do" are two of
 * the most common things anyone types at a chat box, and neither needs a model
 * to answer. Only a genuine question does.
 */
export function classifyTurn(text: string, hasFiles: boolean): TurnKind {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return hasFiles ? 'operation' : 'greeting';

  if (/^(hi|hey|hello|yo|good (morning|afternoon|evening))\b[!. ]*$/.test(trimmed)) return 'greeting';
  if (/^(thanks|thank you|ta|cheers|nice|perfect|great|awesome|lovely)\b[!. ]*$/.test(trimmed)) return 'thanks';

  if (
    /\b(what can you do|what do you do|what are you|capabilities|what formats|which formats|what can i|help me|^help$|how does this work|what is this)\b/.test(
      trimmed,
    )
  ) {
    return 'capabilities';
  }

  // A question mark with no file attached is a question, not an instruction.
  if (!hasFiles && /\?\s*$/.test(trimmed)) return 'question';

  return hasFiles ? 'operation' : 'question';
}

export function greetingReply(hasFiles: boolean): string {
  if (hasFiles) return 'Got the file. What would you like me to do with it?';
  return 'Hello. Drop in an image, PDF or zip and tell me what you need doing to it.';
}

export function thanksReply(hasFiles: boolean): string {
  return hasFiles
    ? 'Any time. Say the word if you want anything else done to it.'
    : 'Any time.';
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
  const caveat =
    unavailable.length > 0
      ? `\n\nNot available on this deployment: ${unavailable.join(', ')}.`
      : '';

  return [
    'Here is what I can do right now:',
    '',
    ...lines,
    '',
    'The useful part is that I take exact constraints. "Compress to 300 KB give or take 5%" is a target I hit and then verify, rather than a hint. Attach a file and say what you need.',
  ].join('\n') + caveat;
}
