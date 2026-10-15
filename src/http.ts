import { InstagramApiError, type GraphErrorBody } from './errors.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff. Default 500ms. */
  baseDelayMs?: number;
  /** Upper bound for any single wait (including Retry-After). Default 30s. */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1). Default Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Turn a non-2xx Graph response into an InstagramApiError. */
export async function toApiError(res: Response, what: string): Promise<InstagramApiError> {
  const json = (await res.json().catch(() => ({}))) as { error?: GraphErrorBody };
  const body = json.error;
  const detail = body?.message ? `: ${body.message}` : '';
  return new InstagramApiError(`${what} failed (${res.status}${body?.code ? `, code ${body.code}` : ''})${detail}`, {
    status: res.status,
    body,
    retryAfterMs: parseRetryAfter(res),
  });
}

/**
 * Run `attempt` with retries on network errors, 5xx and rate limits. Honors
 * Retry-After. 4xx errors (bad token, closed window, invalid params) are
 * thrown immediately.
 *
 * Caveat: retrying a POST after a 5xx/timeout can duplicate a DM if the first
 * attempt actually reached Meta. Pass `retries: 0` for sends if you prefer
 * at-most-once.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const max = opts.maxRetries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let n = 0; ; n++) {
    try {
      return await fn();
    } catch (err) {
      const isApi = err instanceof InstagramApiError;
      const retryable = isApi ? err.isRetryable : err instanceof TypeError; // fetch network failure
      if (!retryable || n >= max) throw err;
      const backoff = base * 2 ** n * (0.5 + random() / 2);
      const wait = Math.min(cap, isApi && err.retryAfterMs !== undefined ? Math.max(err.retryAfterMs, backoff) : backoff);
      await sleep(wait);
    }
  }
}
