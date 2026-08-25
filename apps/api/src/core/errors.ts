export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'FILE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'CAPABILITY_UNAVAILABLE'
  | 'PLAN_INVALID'
  | 'CONSTRAINT_UNSATISFIABLE'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_FAILED'
  | 'SECURITY_REJECTED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  FILE_TOO_LARGE: 413,
  NOT_FOUND: 404,
  CAPABILITY_UNAVAILABLE: 501,
  PLAN_INVALID: 422,
  CONSTRAINT_UNSATISFIABLE: 422,
  EXECUTION_FAILED: 500,
  EXECUTION_TIMEOUT: 504,
  LLM_UNAVAILABLE: 503,
  LLM_FAILED: 502,
  SECURITY_REJECTED: 400,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (m: string, d?: Record<string, unknown>) => new AppError('BAD_REQUEST', m, d);
export const notFound = (m: string, d?: Record<string, unknown>) => new AppError('NOT_FOUND', m, d);
export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
