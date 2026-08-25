import { evaluate, normaliseFormat } from '../constraints/engine.js';
import type { Evaluation, ResolvedConstraints } from '../constraints/engine.js';
import type { WorkFile } from '../router/types.js';
import { sniffMime } from '../security/sniff.js';

/**
 * The last gate before a result is handed back.
 *
 * Two separate questions get answered here. Integrity: is this actually the
 * file type the engine claims it produced, checked by magic bytes rather than
 * by trusting the pipeline. Constraints: does it satisfy what the user asked
 * for. The model is not consulted about either.
 */
export async function validateOutputs(files: WorkFile[], rc: ResolvedConstraints): Promise<Evaluation> {
  const perFile = await Promise.all(
    files.map(async (file) => {
      const checks = [];

      if (file.data.length === 0) {
        checks.push({ name: 'integrity', pass: false, detail: 'output is empty' });
      } else {
        const actual = await sniffMime(file.data, file.name);
        const matches = normaliseFormat(actual) === normaliseFormat(file.mime);
        checks.push({
          name: 'integrity',
          pass: matches || actual === 'application/octet-stream',
          detail: matches ? `verified ${actual}` : `declared ${file.mime} but bytes look like ${actual}`,
        });
      }

      const constraint = evaluate(rc, {
        bytes: file.data.length,
        format: normaliseFormat(file.mime),
        width: typeof file.meta.width === 'number' ? file.meta.width : undefined,
        height: typeof file.meta.height === 'number' ? file.meta.height : undefined,
      });

      return { file, checks: [...checks, ...constraint.checks], sizeDelta: constraint.sizeDelta };
    }),
  );

  const checks = perFile.flatMap((entry) =>
    entry.checks.map((check) => ({
      ...check,
      name: files.length > 1 ? `${entry.file.name}: ${check.name}` : check.name,
    })),
  );

  const result: Evaluation = { pass: checks.every((c) => c.pass), checks };
  const only = perFile[0];
  if (files.length === 1 && only?.sizeDelta !== undefined) result.sizeDelta = only.sizeDelta;
  return result;
}
