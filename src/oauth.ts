/**
 * Instagram API with Instagram Login ("Business Login for Instagram") helpers.
 * Pure functions over an injectable `fetch`; no storage, no framework.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { toApiError, withRetry, type FetchLike, type RetryOptions } from './http.js';
import { InstagramApiError } from './errors.js';

export const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
export const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
export const GRAPH_URL = 'https://graph.instagram.com';
export const DEFAULT_GRAPH_VERSION = 'v23.0';
export const DEFAULT_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];

/** Tokens live ~60 days; Meta only lets you refresh one that is at least 24h old and not yet expired. */
export const MIN_REFRESH_AGE_MS = 24 * 60 * 60_000;

export interface OAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  scopes?: string[];
  fetch?: FetchLike;
  graphUrl?: string;
  tokenUrl?: string;
  graphVersion?: string;
  retry?: RetryOptions;
}

export interface LongLivedToken {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

// --- CSRF state -------------------------------------------------------------

/** Signed, expiring `state` value: base64url(payload|expiry|hmac). `payload` must not contain "|". */
export function signState(payload: string, secret: string, opts: { ttlMs?: number; now?: number } = {}): string {
  if (payload.includes('|')) throw new Error('state payload must not contain "|"');
  const exp = (opts.now ?? Date.now()) + (opts.ttlMs ?? 15 * 60_000);
  const mac = createHmac('sha256', secret).update(`${payload}|${exp}`).digest('base64url');
  return Buffer.from(`${payload}|${exp}|${mac}`).toString('base64url');
}

/** Returns the original payload, or null if the state is forged, malformed or expired. */
export function verifyState(state: string, secret: string, now = Date.now()): string | null {
  const parts = Buffer.from(state, 'base64url').toString('utf8').split('|');
  if (parts.length !== 3) return null;
  const [payload, expStr, mac] = parts as [string, string, string];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now) return null;
  const expected = createHmac('sha256', secret).update(`${payload}|${exp}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? payload : null;
}

// --- Flow -------------------------------------------------------------------

export function buildAuthorizeUrl(cfg: OAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', cfg.appId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (cfg.scopes ?? DEFAULT_SCOPES).join(','));
  url.searchParams.set('state', state);
  return url.toString();
}

export interface ShortLivedToken {
  accessToken: string;
  userId: string;
}

/** code -> short-lived token (about 1 hour). Meta may append `#_` to the code in the redirect; it is stripped. */
export async function exchangeCode(cfg: OAuthConfig, code: string): Promise<ShortLivedToken> {
  const f = cfg.fetch ?? fetch;
  const params = new URLSearchParams({
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: cfg.redirectUri,
    code: code.replace(/#_$/, ''),
  });
  const res = await f(cfg.tokenUrl ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw await toApiError(res, 'Instagram code exchange');
  const body = (await res.json()) as { access_token?: string; user_id?: string | number };
  if (typeof body.access_token !== 'string') throw new Error('Code exchange returned no access_token');
  return { accessToken: body.access_token, userId: String(body.user_id ?? '') };
}

async function tokenGet(cfg: OAuthConfig, path: string, params: Record<string, string>, what: string, now: number): Promise<LongLivedToken> {
  const f = cfg.fetch ?? fetch;
  const url = new URL(`${cfg.graphUrl ?? GRAPH_URL}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const body = await withRetry(async () => {
    const res = await f(url);
    if (!res.ok) throw await toApiError(res, what);
    return (await res.json()) as { access_token?: string; expires_in?: number };
  }, cfg.retry);
  if (typeof body.access_token !== 'string') throw new Error(`${what} returned no access_token`);
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 60 * 24 * 3600;
  return { accessToken: body.access_token, expiresAt: now + expiresIn * 1000 };
}

/** short-lived -> long-lived token (about 60 days). */
export function exchangeLongLived(cfg: OAuthConfig, shortToken: string, now = Date.now()): Promise<LongLivedToken> {
  return tokenGet(
    cfg,
    'access_token',
    { grant_type: 'ig_exchange_token', client_secret: cfg.appSecret, access_token: shortToken },
    'Instagram long-lived exchange',
    now,
  );
}

/** Refresh a long-lived token for another ~60 days. Needs a token >=24h old that has not expired. */
export function refreshLongLived(cfg: OAuthConfig, token: string, now = Date.now()): Promise<LongLivedToken> {
  return tokenGet(
    cfg,
    'refresh_access_token',
    { grant_type: 'ig_refresh_token', access_token: token },
    'Instagram token refresh',
    now,
  );
}

/**
 * Decide whether to refresh now. Refresh when fewer than `refreshWithinMs`
 * remain (default 14 days), but only if the token is old enough and not expired.
 * `issuedAt` defaults to `expiresAt - 60 days`.
 */
export function shouldRefresh(
  token: { expiresAt: number; issuedAt?: number },
  opts: { now?: number; refreshWithinMs?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  const issuedAt = token.issuedAt ?? token.expiresAt - 60 * 24 * 3600_000;
  if (token.expiresAt <= now) return false; // expired: user must re-authorize
  if (now - issuedAt < MIN_REFRESH_AGE_MS) return false;
  return token.expiresAt - now <= (opts.refreshWithinMs ?? 14 * 24 * 3600_000);
}

/**
 * With Instagram Login the app-level webhook URL is not enough: each
 * connected account must also be subscribed. Idempotent.
 */
export async function subscribeToWebhooks(
  cfg: OAuthConfig,
  token: string,
  fields: string[] = ['messages'],
): Promise<void> {
  const f = cfg.fetch ?? fetch;
  const url = new URL(`${cfg.graphUrl ?? GRAPH_URL}/${cfg.graphVersion ?? DEFAULT_GRAPH_VERSION}/me/subscribed_apps`);
  url.searchParams.set('subscribed_fields', fields.join(','));
  url.searchParams.set('access_token', token);
  const body = await withRetry(async () => {
    const res = await f(url, { method: 'POST' });
    if (!res.ok) throw await toApiError(res, 'Instagram webhook subscription');
    return (await res.json()) as { success?: boolean };
  }, cfg.retry);
  if (body.success !== true) throw new InstagramApiError('Webhook subscription not confirmed', { status: 200 });
}

/** The connected professional account's id and username. */
export async function fetchProfile(cfg: OAuthConfig, token: string): Promise<{ igUserId: string; username: string }> {
  const f = cfg.fetch ?? fetch;
  const url = new URL(`${cfg.graphUrl ?? GRAPH_URL}/${cfg.graphVersion ?? DEFAULT_GRAPH_VERSION}/me`);
  url.searchParams.set('fields', 'user_id,username');
  url.searchParams.set('access_token', token);
  const body = await withRetry(async () => {
    const res = await f(url);
    if (!res.ok) throw await toApiError(res, 'Instagram profile fetch');
    return (await res.json()) as { user_id?: string | number; id?: string | number; username?: string };
  }, cfg.retry);
  const id = body.user_id ?? body.id;
  if (id === undefined) throw new Error('Profile fetch returned no user id');
  return { igUserId: String(id), username: body.username ?? '' };
}
