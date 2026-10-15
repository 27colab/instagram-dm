/**
 * Typed parsing of Instagram messaging webhooks (`object: "instagram"`,
 * `entry[].messaging[]`). Unknown or malformed events are skipped, never thrown.
 */

export interface Attachment {
  /** e.g. "image", "video", "audio", "file", "share", "story_mention", "reel", "ig_reel" */
  type: string;
  url?: string;
}

interface EventBase {
  /** IG account id of the business that owns the conversation (entry id). */
  accountId: string;
  /** IG-scoped id of the person on the other side. */
  userId: string;
  timestampMs: number;
}

export interface MessageEvent extends EventBase {
  kind: 'message';
  mid: string;
  /** Empty string when the message has only attachments. */
  text: string;
  attachments: Attachment[];
  /** Set when the message is a reply to one of the business's stories. */
  storyReply?: { storyId?: string; url?: string };
  /** Set when the message replies to an earlier message. */
  replyToMid?: string;
  quickReplyPayload?: string;
}

/** A message the business account itself sent (via API or the Instagram app). */
export interface EchoEvent extends EventBase {
  kind: 'echo';
  mid: string;
  text: string;
  attachments: Attachment[];
}

export interface ReadEvent extends EventBase {
  kind: 'read';
  mid?: string;
}

export interface DeliveryEvent extends EventBase {
  kind: 'delivery';
  mids: string[];
  watermark?: number;
}

export interface ReactionEvent extends EventBase {
  kind: 'reaction';
  mid: string;
  action: 'react' | 'unreact';
  reaction?: string;
  emoji?: string;
}

export interface PostbackEvent extends EventBase {
  kind: 'postback';
  mid?: string;
  title?: string;
  payload: string;
}

export type MessagingEvent =
  | MessageEvent
  | EchoEvent
  | ReadEvent
  | DeliveryEvent
  | ReactionEvent
  | PostbackEvent;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const a of raw) {
    if (!isObj(a)) continue;
    const type = str(a.type);
    if (!type) continue;
    const payload = isObj(a.payload) ? a.payload : {};
    out.push({ type, url: str(payload.url) });
  }
  return out;
}

/** Parse a webhook POST body (already JSON-decoded) into flat events. */
export function parseWebhook(body: unknown): MessagingEvent[] {
  if (!isObj(body) || body.object !== 'instagram' || !Array.isArray(body.entry)) return [];
  const out: MessagingEvent[] = [];

  for (const entry of body.entry) {
    if (!isObj(entry) || !Array.isArray(entry.messaging)) continue;
    const entryId = str(entry.id);
    for (const ev of entry.messaging) {
      if (!isObj(ev)) continue;
      const senderId = isObj(ev.sender) ? str(ev.sender.id) : undefined;
      const recipientId = isObj(ev.recipient) ? str(ev.recipient.id) : undefined;
      const timestampMs = num(ev.timestamp) ?? Date.now();
      if (!senderId || !recipientId) continue;

      const msg = isObj(ev.message) ? ev.message : undefined;
      const echo = msg?.is_echo === true;
      // For echoes the business is the sender and the customer the recipient.
      const accountId = echo ? senderId : recipientId;
      const userId = echo ? recipientId : senderId;
      const base = { accountId: accountId || entryId || '', userId, timestampMs };
      if (!base.accountId) continue;

      if (msg) {
        const mid = str(msg.mid);
        if (!mid) continue;
        const text = typeof msg.text === 'string' ? msg.text : '';
        const attachments = parseAttachments(msg.attachments);
        if (echo) {
          out.push({ kind: 'echo', ...base, mid, text, attachments });
          continue;
        }
        const reply = isObj(msg.reply_to) ? msg.reply_to : undefined;
        const story = reply && isObj(reply.story) ? reply.story : undefined;
        out.push({
          kind: 'message',
          ...base,
          mid,
          text,
          attachments,
          storyReply: story ? { storyId: str(story.id), url: str(story.url) } : undefined,
          replyToMid: reply ? str(reply.mid) : undefined,
          quickReplyPayload: isObj(msg.quick_reply) ? str(msg.quick_reply.payload) : undefined,
        });
      } else if (isObj(ev.read)) {
        out.push({ kind: 'read', ...base, mid: str(ev.read.mid) });
      } else if (isObj(ev.delivery)) {
        const mids = Array.isArray(ev.delivery.mids) ? ev.delivery.mids.filter((m): m is string => typeof m === 'string') : [];
        out.push({ kind: 'delivery', ...base, mids, watermark: num(ev.delivery.watermark) });
      } else if (isObj(ev.reaction)) {
        const mid = str(ev.reaction.mid);
        if (!mid) continue;
        out.push({
          kind: 'reaction',
          ...base,
          mid,
          action: ev.reaction.action === 'unreact' ? 'unreact' : 'react',
          reaction: str(ev.reaction.reaction),
          emoji: str(ev.reaction.emoji),
        });
      } else if (isObj(ev.postback)) {
        const payload = str(ev.postback.payload);
        if (!payload) continue;
        out.push({ kind: 'postback', ...base, mid: str(ev.postback.mid), title: str(ev.postback.title), payload });
      }
    }
  }
  return out;
}

/** Convenience: only inbound customer messages (no echoes, receipts, reactions). */
export function inboundMessages(events: MessagingEvent[]): MessageEvent[] {
  return events.filter((e): e is MessageEvent => e.kind === 'message');
}
