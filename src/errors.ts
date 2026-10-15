/** Shape of the `error` object Graph API returns on failures. */
export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

/** Graph error codes that mean "slow down and retry". */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
/** Graph error codes that mean the access token is invalid or expired. */
const TOKEN_CODES = new Set([102, 190]);

export class InstagramApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { status: number; body?: GraphErrorBody; retryAfterMs?: number }) {
    super(message);
    this.name = 'InstagramApiError';
    this.status = opts.status;
    this.code = opts.body?.code;
    this.subcode = opts.body?.error_subcode;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get isRateLimit(): boolean {
    return this.status === 429 || (this.code !== undefined && RATE_LIMIT_CODES.has(this.code));
  }

  get isTokenError(): boolean {
    return this.status === 401 || (this.code !== undefined && TOKEN_CODES.has(this.code));
  }

  /** True when a retry might succeed (rate limit, 5xx). Never true for 4xx client errors. */
  get isRetryable(): boolean {
    return this.isRateLimit || this.status >= 500;
  }
}

/** Thrown before any network call when the messaging window is closed. */
export class WindowClosedError extends Error {
  constructor(readonly expiredAt: number) {
    super(`Messaging window closed at ${new Date(expiredAt).toISOString()}`);
    this.name = 'WindowClosedError';
  }
}
