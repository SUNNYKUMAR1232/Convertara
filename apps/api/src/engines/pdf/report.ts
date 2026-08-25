import { ghostscriptAvailable } from './ghostscript.js';

/** Which optional PDF features this host can actually deliver. */
export async function pdfEngineReport(): Promise<{ ghostscript: boolean }> {
  return { ghostscript: await ghostscriptAvailable() };
}
