import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';

const exec = promisify(execFile);

const probed = new Map<string, string | null>();

/**
 * Finds the first of `candidates` that exists on PATH. Results are cached for
 * the process lifetime, so a capability's `available()` stays cheap. Engines
 * use this to advertise optional capabilities only when their binary is there,
 * rather than failing halfway through a job.
 */
export async function findBinary(candidates: string[]): Promise<string | null> {
  const key = candidates.join('|');
  const cached = probed.get(key);
  if (cached !== undefined) return cached;

  for (const candidate of candidates) {
    try {
      await exec(candidate, ['--version'], { timeout: 5000, windowsHide: true });
      probed.set(key, candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  probed.set(key, null);
  return null;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
  /** Kill the child if it writes more than this to stdout/stderr. */
  maxBuffer?: number;
}

export async function run(bin: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const child = await exec(bin, args, {
      timeout: options.timeoutMs ?? 60_000,
      cwd: options.cwd,
      signal: options.signal,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.killed) throw new AppError('EXECUTION_TIMEOUT', `${bin} timed out`);
    throw new AppError('EXECUTION_FAILED', `${bin} failed: ${(err.stderr ?? err.message).slice(0, 400)}`);
  }
}

/** Test seam: lets a test pretend a binary is or is not installed. */
export function __setProbe(candidates: string[], value: string | null): void {
  probed.set(candidates.join('|'), value);
}
