import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { llmPlanSchema, planSchema } from '../core/plan.js';
import type { Plan } from '../core/plan.js';
import { llm } from '../llm/manager.js';
import type { LlmSettings } from '../llm/types.js';
import type { WorkFile } from '../router/types.js';
import { buildPlanJsonSchema } from './plan-schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

export interface LlmPlanResult {
  plan: Plan;
  model: string;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * One call, one plan. If the model returns something the schema rejects we
 * retry exactly once with the validation errors appended - beyond that the
 * request fails loudly rather than burning latency on a model that is not
 * going to comply.
 */
export async function planWithLlm(
  prompt: string,
  files: WorkFile[],
  settings: LlmSettings,
): Promise<LlmPlanResult> {
  const jsonSchema = await buildPlanJsonSchema();
  const user = await buildUserPrompt(prompt, files);

  let lastIssues: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await llm.generate(
      {
        system: SYSTEM_PROMPT,
        user: attempt === 0 ? user : `${user}\n\nYour previous plan was rejected:\n${lastIssues.join('\n')}\nReturn a corrected plan.`,
        schemaName: 'file_processing_plan',
        jsonSchema,
        maxOutputTokens: 1500,
      },
      settings,
    );

    const parsed = llmPlanSchema.safeParse(response.json);
    if (parsed.success) {
      const plan = planSchema.parse({ ...parsed.data, version: 1, source: 'llm' });
      return {
        plan,
        model: response.model,
        latencyMs: response.latencyMs,
        ...(response.usage ? { usage: response.usage } : {}),
      };
    }

    lastIssues = parsed.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`);
    logger.warn({ attempt, issues: lastIssues }, 'model returned an invalid plan');
  }

  throw new AppError('PLAN_INVALID', 'The model could not produce a valid plan', { issues: lastIssues });
}
