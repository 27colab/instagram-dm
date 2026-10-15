import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/**
 * Verify Meta's `X-Hub-Signature-256` header: `sha256=<hex hmac(appSecret, rawBody)>`.
 *
 * `rawBody` must be the exact bytes Meta sent. Re-serialising parsed JSON will
 * change whitespace/escaping and fail verification.
 */
export function verifySignature(
  appSecret: string,
  rawBody: string | Uint8Array,
  header: string | null | undefined,
): boolean {
  if (!appSecret || !header || !header.startsWith(PREFIX)) return false;
  const theirs = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(theirs)) return false;
  const ours = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(theirs, 'hex'), ours);
}

/** Produce a valid signature header (used by tests and the fake Graph API). */
export function signBody(appSecret: string, rawBody: string | Uint8Array): string {
  return PREFIX + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

export type VerifyChallengeResult =
  | { ok: true; challenge: string }
  | { ok: false };

/**
 * Handle the GET handshake when you save the webhook in the Meta dashboard.
 * Query keys are the dotted names Meta sends: `hub.mode`, `hub.verify_token`,
 * `hub.challenge`. Respond with the returned `challenge` as plain text.
 */
export function verifyChallenge(
  query: Record<string, string | string[] | undefined> | URLSearchParams,
  verifyToken: string,
): VerifyChallengeResult {
  const get = (k: string): string | undefined => {
    if (query instanceof URLSearchParams) return query.get(k) ?? undefined;
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const mode = get('hub.mode');
  const token = get('hub.verify_token');
  const challenge = get('hub.challenge');
  if (mode !== 'subscribe' || !verifyToken || !token || challenge === undefined) return { ok: false };
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, challenge };
}

/**
 * An HMAC proves who sent a body, not that it is fresh: Meta redelivers
 * events, and anyone who captures a signed body can replay it. Track message
 * ids you have already handled and drop repeats.
 */
export interface DedupeStore {
  /** Returns true if `key` was already seen; otherwise records it and returns false. */
  seen(key: string): boolean | Promise<boolean>;
}

/** Bounded in-memory dedupe with TTL. Use a shared store (Redis, DB) across processes. */
export class InMemoryDedupe implements DedupeStore {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  seen(key: string): boolean {
    const t = this.now();
    const exp = this.entries.get(key);
    if (exp !== undefined && exp > t) return true;
    this.entries.delete(key);
    this.entries.set(key, t + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      // Map iterates in insertion order: drop the oldest.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return false;
  }
}
