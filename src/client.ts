import { DEFAULT_GRAPH_VERSION, GRAPH_URL } from './oauth.js';
import { toApiError, withRetry, type FetchLike, type RetryOptions } from './http.js';
import { WindowClosedError } from './errors.js';
import { evaluateWindow } from './window.js';

/** DM text is capped at 1000 characters; stay safely under. */
export const MAX_DM_CHARS = 900;

export interface ClientOptions {
  accessToken: string;
  fetch?: FetchLike;
  graphUrl?: string;
  graphVersion?: string;
  retry?: RetryOptions;
}

export interface SendOptions {
  /**
   * Epoch ms (or Date) of the user's last inbound message. When given, the
   * client refuses to send once the window has closed instead of letting
   * Meta reject it.
   */
  lastInboundAt?: number | Date;
  /** Use the 7-day HUMAN_AGENT tag. Only for real humans replying; never for bots. */
  humanAgent?: boolean;
  /** Clock override for tests. */
  now?: number;
}

export interface SendResult {
  recipientId: string;
  messageId: string;
}

/** Split a long reply into chunks of at most `max` chars, preferring sentence then word boundaries. */
export function chunkText(text: string, max = MAX_DM_CHARS): string[] {
  const t = text.trim();
  if (t.length <= max) return t ? [t] : [];
  const chunks: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const win = rest.slice(0, max);
    const sentence = Math.max(win.lastIndexOf('. '), win.lastIndexOf('! '), win.lastIndexOf('? '));
    const space = win.lastIndexOf(' ');
    const at = sentence > max * 0.5 ? sentence + 1 : space > 0 ? space : max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class InstagramClient {
  private readonly f: FetchLike;
  private readonly base: string;

  constructor(private readonly opts: ClientOptions) {
    this.f = opts.fetch ?? fetch;
    this.base = `${opts.graphUrl ?? GRAPH_URL}/${opts.graphVersion ?? DEFAULT_GRAPH_VERSION}`;
  }

  private async post(path: string, payload: unknown, what: string): Promise<Record<string, unknown>> {
    return withRetry(async () => {
      const res = await this.f(`${this.base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw await toApiError(res, what);
      return (await res.json()) as Record<string, unknown>;
    }, this.opts.retry);
  }

  private guardWindow(o: SendOptions): void {
    if (o.lastInboundAt === undefined) return;
    const w = evaluateWindow(o.lastInboundAt, { now: o.now, humanAgent: o.humanAgent });
    if (!w.open) throw new WindowClosedError(w.expiresAt);
  }

  /** Send a text DM. Long text goes out as sequential chunks; returns one result per chunk. */
  async sendText(recipientId: string, text: string, o: SendOptions = {}): Promise<SendResult[]> {
    this.guardWindow(o);
    const results: SendResult[] = [];
    for (const chunk of chunkText(text)) {
      const payload: Record<string, unknown> = { recipient: { id: recipientId }, message: { text: chunk } };
      if (o.humanAgent) Object.assign(payload, { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
      const body = await this.post('/me/messages', payload, 'Instagram send');
      results.push({ recipientId: String(body.recipient_id ?? recipientId), messageId: String(body.message_id ?? '') });
    }
    return results;
  }

  /** Mark the user's last message as seen, or show a typing indicator. */
  async sendAction(recipientId: string, action: 'mark_seen' | 'typing_on' | 'typing_off'): Promise<void> {
    await this.post('/me/messages', { recipient: { id: recipientId }, sender_action: action }, 'Instagram sender action');
  }
}
