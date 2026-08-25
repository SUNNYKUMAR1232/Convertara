import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('*'),

  /** Metadata store. Empty -> in-memory (dev). */
  DATABASE_URL: z.string().optional(),
  /** Queue + cache. Empty -> in-process queue (dev). */
  REDIS_URL: z.string().optional(),

  /** Object storage. `local` or `s3`. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('convertara'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),

  /** 32-byte key (hex or base64) used to encrypt stored provider API keys. */
  SECRET_KEY: z.string().optional(),

  /** Upload + processing limits. */
  MAX_UPLOAD_BYTES: int(200 * 1024 * 1024),
  MAX_FILES_PER_REQUEST: int(64),
  /** Work above these thresholds is pushed onto the async queue. */
  SYNC_MAX_BYTES: int(24 * 1024 * 1024),
  SYNC_MAX_COST: int(60),
  /** Hard wall-clock ceiling for one pipeline. */
  EXECUTION_TIMEOUT_MS: int(120_000),
  /** Retention for uploaded + produced artifacts. */
  ARTIFACT_TTL_SECONDS: int(24 * 60 * 60),

  /** Archive safety. */
  ARCHIVE_MAX_ENTRIES: int(10_000),
  ARCHIVE_MAX_TOTAL_BYTES: int(1024 * 1024 * 1024),
  ARCHIVE_MAX_RATIO: int(120),

  /**
   * How many jobs one worker process handles at once. libvips keeps its own
   * thread pool underneath, so this is about concurrent jobs, not cores.
   */
  WORKER_CONCURRENCY: int(4),

  /** `auto` = fast path when possible, LLM otherwise. */
  AI_MODE: z.enum(['auto', 'always', 'never']).default('auto'),
  /** Optional server-wide default provider (a user config overrides it). */
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'gemini', 'ollama', 'custom']).optional(),
  LLM_MODEL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().optional(),
  LLM_TIMEOUT_MS: int(30_000),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return parsed.data;
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

export function resetConfig(): void {
  cached = undefined;
}
