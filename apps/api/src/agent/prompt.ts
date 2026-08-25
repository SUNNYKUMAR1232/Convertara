import { formatBytes } from '../core/units.js';
import { registry } from '../router/registry.js';
import type { WorkFile } from '../router/types.js';

export const SYSTEM_PROMPT = `You turn a file-processing request into a plan.

You do not process files and you do not check the result. A deterministic engine
runs your plan, and a separate optimizer hits any size target by binary search.
So: pick the operations, state the constraints, and stop.

Rules:
- Use only the capabilities listed. Never invent one.
- Order matters. Resize before compressing; merge before splitting.
- Put a requested file size in constraints.size, NOT in an operation's quality
  parameter. Guessing "quality: 62" is exactly the job the optimizer does better.
- Leave a parameter out when the user did not ask for it. Defaults are sensible.
- "Under X" or "no more than X" is mode "max". "About X", "X give or take", or a
  plain "make it X" is mode "target" with tolerance 0.05 unless a tolerance is stated.
- When the user cares about quality, raise constraints.minQuality (e.g. 70) so
  the optimizer stops before the image turns to mush, and let the size miss.
- Keep the plan as short as it can be. One operation is a good plan.`;

export async function buildUserPrompt(prompt: string, files: WorkFile[]): Promise<string> {
  const capabilities = await describeCapabilities();
  const inventory = files
    .map((f) => {
      const dims = typeof f.meta.width === 'number' ? `, ${f.meta.width}x${f.meta.height}px` : '';
      const pages = typeof f.meta.pages === 'number' ? `, ${f.meta.pages} pages` : '';
      return `- ${f.name} (${f.mime}, ${formatBytes(f.data.length)}${dims}${pages})`;
    })
    .join('\n');

  return `Capabilities available right now:
${capabilities}

Input files (${files.length}):
${inventory}

Request:
"""
${prompt}
"""

Return the plan.`;
}

async function describeCapabilities(): Promise<string> {
  const lines = await Promise.all(
    registry.list().map(async (capability) => {
      if (!(await capability.available())) return null;
      return `- ${capability.name} — ${capability.description}\n    accepts: ${capability.accepts.join(', ')}; params: ${capability.paramsHint}`;
    }),
  );
  return lines.filter((line): line is string => line !== null).join('\n');
}
