import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';

/**
 * These exist because a blank environment variable crash-looped the container
 * in Docker while every local run was fine - locally the variable was simply
 * absent, and compose writes it as an empty string.
 */
describe('blank environment variables mean unset', () => {
  it('accepts an empty optional enum instead of rejecting it', () => {
    const cfg = loadConfig({ LLM_PROVIDER: '', LLM_MODEL: '', LLM_API_KEY: '' } as NodeJS.ProcessEnv);
    expect(cfg.LLM_PROVIDER).toBeUndefined();
    expect(cfg.LLM_MODEL).toBeUndefined();
  });

  it('falls back to defaults for blanks rather than taking the blank', () => {
    const cfg = loadConfig({ STORAGE_DRIVER: '', PORT: '', AI_MODE: '' } as NodeJS.ProcessEnv);
    expect(cfg.STORAGE_DRIVER).toBe('local');
    expect(cfg.PORT).toBe(4000);
    expect(cfg.AI_MODE).toBe('auto');
  });

  it('treats a blank connection string as no connection string', () => {
    const cfg = loadConfig({ DATABASE_URL: '   ', REDIS_URL: '' } as NodeJS.ProcessEnv);
    expect(cfg.DATABASE_URL).toBeUndefined();
    expect(cfg.REDIS_URL).toBeUndefined();
  });

  it('still honours a value that is actually set', () => {
    const cfg = loadConfig({ LLM_PROVIDER: 'anthropic', PORT: '8080' } as NodeJS.ProcessEnv);
    expect(cfg.LLM_PROVIDER).toBe('anthropic');
    expect(cfg.PORT).toBe(8080);
  });

  it('still rejects a value that is set to something wrong', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'not-a-provider' } as NodeJS.ProcessEnv)).toThrow(/LLM_PROVIDER/);
  });
});
