import { registry } from '../router/registry.js';

/**
 * JSON Schema handed to whichever model is configured. It is generated from the
 * live capability registry, so a newly registered engine becomes available to
 * the planner the moment it is plugged in - no prompt edit, no redeploy of the
 * agent layer.
 */
export async function buildPlanJsonSchema(): Promise<Record<string, unknown>> {
  const available = await availableCapabilityNames();

  return {
    type: 'object',
    description: 'A deterministic file-processing plan.',
    properties: {
      intent: {
        type: 'string',
        description: 'One short sentence describing what the user wants.',
      },
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        description: 'Operations applied in order. The output of one feeds the next.',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: available, description: 'Capability to run.' },
            params: { type: 'object', description: 'Parameters for this capability.' },
          },
          required: ['op', 'params'],
        },
      },
      constraints: {
        type: 'object',
        description: 'Requirements the finished output must satisfy. The system enforces these, not you.',
        properties: {
          size: {
            type: 'object',
            description: 'Only set this when the user asked for a specific file size.',
            properties: {
              target: { type: 'number', description: 'Numeric size in the given unit.' },
              unit: { type: 'string', enum: ['B', 'KB', 'MB', 'GB'] },
              tolerance: {
                type: 'number',
                description: 'Fraction, so 5% is 0.05. Use 0.05 when the user gives no tolerance.',
              },
              mode: {
                type: 'string',
                enum: ['target', 'max'],
                description: '"max" for "under 2MB". "target" for "about 300KB" or "300KB +/- 5%".',
              },
            },
            required: ['target', 'unit', 'tolerance', 'mode'],
          },
          dimensions: {
            type: 'object',
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
              maxWidth: { type: 'number' },
              maxHeight: { type: 'number' },
              minScale: {
                type: 'number',
                description: 'Smallest fraction of original dimensions allowed while chasing a size target.',
              },
            },
          },
          minQuality: {
            type: 'number',
            description: 'Lowest encoder quality (1-100) acceptable. Raise it when the user says quality matters.',
          },
          format: { type: 'string', description: 'Required output format, lowercase, e.g. "webp".' },
          stripMetadata: { type: 'boolean' },
        },
        required: ['minQuality', 'stripMetadata'],
      },
      output: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          bundle: {
            type: 'string',
            enum: ['auto', 'single', 'zip'],
            description: '"auto" zips only when several files come out.',
          },
        },
        required: ['bundle'],
      },
      notes: { type: 'string', description: 'One sentence for the user explaining the approach.' },
    },
    required: ['intent', 'operations', 'constraints', 'output'],
  };
}

export async function availableCapabilityNames(): Promise<string[]> {
  const capabilities = await Promise.all(
    registry.list().map(async (c) => ((await c.available()) ? c.name : null)),
  );
  return capabilities.filter((name): name is string => name !== null);
}
