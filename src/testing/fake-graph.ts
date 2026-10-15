/**
 * In-memory fake of the slice of the Instagram Graph API this package uses.
 * Pass `fake.fetch` wherever a `fetch` option is accepted. It enforces the
 * 24-hour window, validates tokens, and lets you inject failures.
 */
import { signBody } from '../signature.js';
import { STANDARD_WINDOW_MS, HUMAN_AGENT_WINDOW_MS } from '../window.js';
import type { FetchLike } from '../http.js';

export interface SentMessage {
  accessToken: string;
  recipientId: string;
  text?: string;
  senderAction?: string;
  tag?: string;
  messageId?: string;
  at: number;
}

export interface FakeFailure {
  status: number;
  error?: { message?: string; code?: number; error_subcode?: number };
  headers?: Record<string, string>;
}

export interface FakeGraphOptions {
  appId?: string;
  appSecret?: string;
  now?: () => number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const err = (status: number, code: number, message: string, subcode?: number) =>
  json(status, { error: { message, type: 'OAuthException', code, error_subcode: subcode } });

export class FakeGraphApi {
  readonly sent: SentMessage[] = [];
  readonly requests: Array<{ method: string; url: string }> = [];
  private readonly now: () => number;
  private readonly appSecret: string;
  private readonly tokens = new Map<string, { accountId: string; username: string; issuedAt: number; expiresAt: number; longLived: boolean }>();
  private readonly codes = new Map<string, string>();
  private readonly lastInbound = new Map<string, number>();
  private readonly failures: FakeFailure[] = [];
  private seq = 0;

  constructor(opts: FakeGraphOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.appSecret = opts.appSecret ?? 'fake-app-secret';
  }

  // --- setup helpers --------------------------------------------------------

  /** Register an authorization code that exchangeCode will accept. Returns the code. */
  issueAuthCode(accountId: string, username = 'test_account'): string {
    const code = `code_${++this.seq}`;
    this.codes.set(code, accountId);
    this.accounts.set(accountId, username);
    return code;
  }
  private readonly accounts = new Map<string, string>();

  /** Mint a valid long-lived token directly (skips the OAuth dance). */
  issueToken(accountId: string, opts: { username?: string; ageMs?: number; ttlMs?: number } = {}): string {
    const token = `tok_${++this.seq}`;
    const issuedAt = this.now() - (opts.ageMs ?? 0);
    this.tokens.set(token, {
      accountId,
      username: opts.username ?? this.accounts.get(accountId) ?? 'test_account',
      issuedAt,
      expiresAt: issuedAt + (opts.ttlMs ?? 60 * 24 * 3600_000),
      longLived: true,
    });
    return token;
  }

  /** Make the next request fail with this response (FIFO; repeat for several). */
  failNext(failure: FakeFailure, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(failure);
  }

  /** Record that a user messaged the account now, opening their window. */
  recordInbound(accountId: string, userId: string, at = this.now()): void {
    this.lastInbound.set(`${accountId}:${userId}`, at);
  }

  /** Build a signed webhook delivery as Meta would send it. */
  buildWebhook(events: unknown[], accountId: string): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify({ object: 'instagram', entry: [{ id: accountId, time: this.now(), messaging: events }] });
    return { rawBody, headers: { 'x-hub-signature-256': signBody(this.appSecret, rawBody), 'content-type': 'application/json' } };
  }

  // --- the fetch ------------------------------------------------------------

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push({ method, url: url.toString() });

    const fail = this.failures.shift();
    if (fail) return json(fail.status, { error: fail.error ?? { message: 'injected failure', code: 1 } }, fail.headers);

    const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, '');
    const token = auth ?? url.searchParams.get('access_token') ?? '';

    if (url.hostname === 'api.instagram.com' && path === '/oauth/access_token' && method === 'POST') {
      const p = new URLSearchParams(String(init?.body));
      const accountId = this.codes.get(p.get('code') ?? '');
      if (!accountId || p.get('client_secret') === '') return err(400, 100, 'Invalid authorization code');
      this.codes.delete(p.get('code') ?? '');
      const t = `short_${++this.seq}`;
      const now = this.now();
      this.tokens.set(t, { accountId, username: this.accounts.get(accountId) ?? 'test_account', issuedAt: now, expiresAt: now + 3600_000, longLived: false });
      return json(200, { access_token: t, user_id: accountId });
    }

    if (path === '/access_token') {
      const t = this.tokens.get(url.searchParams.get('access_token') ?? '');
      if (!t || t.longLived || t.expiresAt <= this.now()) return err(400, 190, 'Invalid or expired token');
      return json(200, this.mint(t));
    }

    if (path === '/refresh_access_token') {
      const t = this.tokens.get(url.searchParams.get('access_token') ?? '');
      if (!t || t.expiresAt <= this.now()) return err(400, 190, 'Session has expired');
      if (this.now() - t.issuedAt < 24 * 3600_000) return err(400, 10, 'Token is less than 24 hours old');
      return json(200, this.mint(t));
    }

    const acct = this.tokens.get(token);
    if (!acct || acct.expiresAt <= this.now()) return err(400, 190, 'Invalid OAuth access token');

    if (path === '/me' && method === 'GET') return json(200, { user_id: acct.accountId, username: acct.username });
    if (path === '/me/subscribed_apps' && method === 'POST') return json(200, { success: true });

    if (path === '/me/messages' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        recipient: { id: string };
        message?: { text: string };
        sender_action?: string;
        tag?: string;
      };
      const recipientId = body.recipient.id;
      if (body.message) {
        const last = this.lastInbound.get(`${acct.accountId}:${recipientId}`);
        const span = body.tag === 'HUMAN_AGENT' ? HUMAN_AGENT_WINDOW_MS : STANDARD_WINDOW_MS;
        if (last === undefined || this.now() - last > span) {
          return err(400, 10, 'This message is sent outside of allowed window.', 2534022);
        }
        if (body.message.text.length > 1000) return err(400, 100, 'Message too long');
      }
      const messageId = `mid_${++this.seq}`;
      this.sent.push({
        accessToken: token,
        recipientId,
        text: body.message?.text,
        senderAction: body.sender_action,
        tag: body.tag,
        messageId: body.message ? messageId : undefined,
        at: this.now(),
      });
      return json(200, { recipient_id: recipientId, message_id: messageId });
    }

    return err(404, 803, `Unknown path ${path}`);
  };

  private mint(old: { accountId: string; username: string }): { access_token: string; token_type: string; expires_in: number } {
    const token = `tok_${++this.seq}`;
    const now = this.now();
    const ttl = 60 * 24 * 3600_000;
    this.tokens.set(token, { accountId: old.accountId, username: old.username, issuedAt: now, expiresAt: now + ttl, longLived: true });
    return { access_token: token, token_type: 'bearer', expires_in: ttl / 1000 };
  }
}

// --- webhook event builders (invented ids only) --------------------------------

export function textEvent(o: { accountId: string; userId: string; mid: string; text: string; timestamp?: number; storyId?: string }) {
  return {
    sender: { id: o.userId },
    recipient: { id: o.accountId },
    timestamp: o.timestamp ?? Date.now(),
    message: {
      mid: o.mid,
      text: o.text,
      ...(o.storyId ? { reply_to: { story: { id: o.storyId, url: 'https://example.invalid/story' } } } : {}),
    },
  };
}
