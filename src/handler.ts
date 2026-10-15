/**
 * Framework-agnostic webhook handler. Feed it the method, query, headers and
 * RAW body from Fastify / Express / a Next route; get back a status and body.
 * `handler.fetch` adapts it to the Web `Request` / `Response` API directly.
 *
 * There is no LLM or business logic in here: your app plugs in a
 * `ConversationHandler`.
 */
import { verifyChallenge, verifySignature, InMemoryDedupe, type DedupeStore } from './signature.js';
import { parseWebhook, type MessageEvent, type MessagingEvent } from './events.js';
import { evaluateWindow, type WindowStatus } from './window.js';
import type { InstagramClient, SendResult } from './client.js';

export interface MessageContext {
  event: MessageEvent;
  /** Window state at the time the message arrived (always open for a fresh inbound). */
  window: WindowStatus;
  /** Send a text DM back to this user. Throws if there is no client for the account. */
  reply(text: string): Promise<SendResult[]>;
  /** Mark the user's message as seen. */
  markSeen(): Promise<void>;
}

export interface ConversationHandler {
  /**
   * Called once per inbound customer message (deduped by message id). Return a
   * string (or strings) to have it sent as the reply, or call `ctx.reply`
   * yourself and return nothing.
   */
  onMessage(ctx: MessageContext): Promise<string | string[] | void> | string | string[] | void;
  /** Optional: echoes, reads, reactions, postbacks, deliveries. */
  onEvent?(event: Exclude<MessagingEvent, MessageEvent>): Promise<void> | void;
}

export interface WebhookHandlerOptions {
  appSecret: string;
  verifyToken: string;
  conversation: ConversationHandler;
  /** Look up the Send API client (token) for the IG account that received the event. */
  resolveClient?: (accountId: string) => InstagramClient | undefined | Promise<InstagramClient | undefined>;
  /** Defaults to an in-memory store. Use a shared store when running several instances. */
  dedupe?: DedupeStore;
  /** Errors thrown by your conversation handler or by sends. Default: console.error. */
  onError?: (err: unknown, event: MessagingEvent) => void;
  /**
   * Serverless hook (e.g. Vercel `waitUntil`). When set, events are processed
   * in the background and the webhook returns 200 immediately.
   */
  waitUntil?: (p: Promise<unknown>) => void;
}

export interface WebhookRequest {
  method: string;
  query?: Record<string, string | string[] | undefined> | URLSearchParams;
  headers: Record<string, string | string[] | undefined> | Headers;
  /** The exact bytes of the POST body. Do not pass re-serialised JSON. */
  rawBody?: string | Uint8Array;
}

export interface WebhookResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function header(h: WebhookRequest['headers'], name: string): string | undefined {
  if (h instanceof Headers) return h.get(name) ?? undefined;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

const text = (status: number, body: string): WebhookResponse => ({
  status,
  body,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});

export interface InstagramWebhook {
  handle(req: WebhookRequest): Promise<WebhookResponse>;
  /** Web-standard adapter for Next.js route handlers, Hono, Workers, etc. */
  fetch(request: Request): Promise<Response>;
}

export function createWebhookHandler(opts: WebhookHandlerOptions): InstagramWebhook {
  const dedupe = opts.dedupe ?? new InMemoryDedupe();
  const onError = opts.onError ?? ((err) => console.error('[instagram-dm] handler error', err));

  async function processEvent(ev: MessagingEvent): Promise<void> {
    if (ev.kind !== 'message') {
      await opts.conversation.onEvent?.(ev);
      return;
    }
    if (await dedupe.seen(`mid:${ev.mid}`)) return;
    const client = await opts.resolveClient?.(ev.accountId);
    const send = async (t: string): Promise<SendResult[]> => {
      if (!client) throw new Error(`No Instagram client for account ${ev.accountId}`);
      return client.sendText(ev.userId, t, { lastInboundAt: ev.timestampMs });
    };
    const out = await opts.conversation.onMessage({
      event: ev,
      window: evaluateWindow(ev.timestampMs, { now: ev.timestampMs }),
      reply: send,
      markSeen: async () => {
        await client?.sendAction(ev.userId, 'mark_seen');
      },
    });
    if (out === undefined) return;
    for (const part of Array.isArray(out) ? out : [out]) if (part.trim()) await send(part);
  }

  async function processAll(events: MessagingEvent[]): Promise<void> {
    for (const ev of events) {
      try {
        await processEvent(ev);
      } catch (err) {
        onError(err, ev);
      }
    }
  }

  async function handle(req: WebhookRequest): Promise<WebhookResponse> {
    const method = req.method.toUpperCase();

    if (method === 'GET') {
      const r = verifyChallenge(req.query ?? {}, opts.verifyToken);
      return r.ok ? text(200, r.challenge) : text(403, 'forbidden');
    }
    if (method !== 'POST') return text(405, 'method not allowed');

    const raw = req.rawBody ?? '';
    if (!verifySignature(opts.appSecret, raw, header(req.headers, 'x-hub-signature-256'))) {
      return text(401, 'bad signature');
    }

    let json: unknown;
    try {
      json = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return text(400, 'invalid json');
    }

    const work = processAll(parseWebhook(json));
    if (opts.waitUntil) opts.waitUntil(work);
    else await work;
    return text(200, 'ok');
  }

  return {
    handle,
    async fetch(request) {
      const url = new URL(request.url);
      const rawBody = request.method === 'POST' ? await request.text() : undefined;
      const r = await handle({ method: request.method, query: url.searchParams, headers: request.headers, rawBody });
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
  };
}
