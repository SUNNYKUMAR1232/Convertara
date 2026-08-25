import { config } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { planSchema } from '../core/plan.js';
import type { Plan } from '../core/plan.js';
import { llm } from '../llm/manager.js';
import type { WorkFile } from '../router/types.js';
import { planFromRules } from './fast-path.js';
import { planWithLlm } from './planner.js';

export interface PlanDecision {
  plan: Plan;
  route: 'fast-path' | 'llm' | 'explicit';
  reason: string;
  latencyMs: number;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface DecideOptions {
  ownerId: string;
  files: WorkFile[];
  prompt?: string | undefined;
  /** A caller that already knows what it wants can skip planning entirely. */
  plan?: unknown;
}

/**
 * The fork in the road.
 *
 * An explicit plan skips planning. A prompt the rule engine fully understands
 * skips the model - that is the difference between a 40ms response and a
 * 900ms one, and it covers most real traffic. Everything else goes to whichever
 * model the deployment or the user configured.
 */
export async function decidePlan(options: DecideOptions): Promise<PlanDecision> {
  const started = Date.now();
  const cfg = config();

  if (options.plan !== undefined) {
    const parsed = planSchema.safeParse({ ...(options.plan as object), source: 'explicit' });
    if (!parsed.success) {
      throw new AppError('PLAN_INVALID', 'The supplied plan is not valid', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      });
    }
    return { plan: parsed.data, route: 'explicit', reason: 'caller supplied a plan', latencyMs: Date.now() - started };
  }

  const prompt = options.prompt?.trim() ?? '';
  if (prompt === '') {
    throw new AppError('BAD_REQUEST', 'Tell me what to do with these files, or send an explicit plan');
  }

  if (cfg.AI_MODE !== 'always') {
    const fast = planFromRules(prompt, options.files);
    if (fast) {
      return { plan: fast.plan, route: 'fast-path', reason: fast.reason, latencyMs: Date.now() - started };
    }
  }

  if (cfg.AI_MODE === 'never') {
    throw new AppError(
      'BAD_REQUEST',
      'That request needs the AI planner, which is disabled on this deployment. Try a direct instruction such as "convert to webp" or "compress to 300KB".',
    );
  }

  const settings = await llm.settingsFor(options.ownerId);
  if (!settings) {
    throw new AppError(
      'LLM_UNAVAILABLE',
      'No language model is configured. Add one under Settings, or phrase the request as a direct instruction such as "resize to 1200px".',
    );
  }

  const result = await planWithLlm(prompt, options.files, settings);
  return {
    plan: result.plan,
    route: 'llm',
    reason: `planned by ${settings.provider}/${result.model}`,
    latencyMs: Date.now() - started,
    model: result.model,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
