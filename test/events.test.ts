import { describe, expect, it } from 'vitest';
import { inboundMessages, parseWebhook } from '../src/index.js';

const A = '1000000000001'; // invented business account id
const U = '2000000000002'; // invented user id

const wrap = (...messaging: unknown[]) => ({ object: 'instagram', entry: [{ id: A, time: 1, messaging }] });

describe('parseWebhook', () => {
  it('parses a text message', () => {
    const [e] = parseWebhook(wrap({ sender: { id: U }, recipient: { id: A }, timestamp: 1700000000000, message: { mid: 'm1', text: 'hello' } }));
    expect(e).toMatchObject({ kind: 'message', accountId: A, userId: U, mid: 'm1', text: 'hello', attachments: [], timestampMs: 1700000000000 });
  });

  it('parses attachment-only messages', () => {
    const [e] = parseWebhook(
      wrap({ sender: { id: U }, recipient: { id: A }, timestamp: 1, message: { mid: 'm2', attachments: [{ type: 'image', payload: { url: 'https://example.invalid/a.jpg' } }, { type: 'share' }] } }),
    );
    expect(e).toMatchObject({ kind: 'message', text: '', attachments: [{ type: 'image', url: 'https://example.invalid/a.jpg' }, { type: 'share' }] });
  });

  it('flags story replies and reply-to', () => {
    const [e] = parseWebhook(
      wrap({ sender: { id: U }, recipient: { id: A }, timestamp: 1, message: { mid: 'm3', text: 'love it', reply_to: { story: { id: 'st1', url: 'https://example.invalid/s' }, mid: 'm0' } } }),
    );
    expect(e).toMatchObject({ kind: 'message', storyReply: { storyId: 'st1', url: 'https://example.invalid/s' }, replyToMid: 'm0' });
  });

  it('parses echoes with the business as sender', () => {
    const [e] = parseWebhook(wrap({ sender: { id: A }, recipient: { id: U }, timestamp: 1, message: { mid: 'm4', text: 'ours', is_echo: true } }));
    expect(e).toMatchObject({ kind: 'echo', accountId: A, userId: U, text: 'ours' });
    expect(inboundMessages([e!])).toEqual([]);
  });

  it('parses read, delivery, reaction and postback events', () => {
    const evs = parseWebhook(
      wrap(
        { sender: { id: U }, recipient: { id: A }, timestamp: 1, read: { mid: 'm1' } },
        { sender: { id: U }, recipient: { id: A }, timestamp: 2, delivery: { mids: ['m1', 'm2'], watermark: 5 } },
        { sender: { id: U }, recipient: { id: A }, timestamp: 3, reaction: { mid: 'm1', action: 'react', reaction: 'love', emoji: '❤' } },
        { sender: { id: U }, recipient: { id: A }, timestamp: 4, postback: { mid: 'm9', title: 'Go', payload: 'GO' } },
      ),
    );
    expect(evs.map((e) => e.kind)).toEqual(['read', 'delivery', 'reaction', 'postback']);
    expect(evs[1]).toMatchObject({ mids: ['m1', 'm2'], watermark: 5 });
    expect(evs[3]).toMatchObject({ payload: 'GO' });
  });

  it('skips malformed input without throwing', () => {
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual([]);
    expect(parseWebhook({ object: 'instagram', entry: 'x' })).toEqual([]);
    expect(parseWebhook(wrap({ sender: { id: U } }, { sender: { id: U }, recipient: { id: A }, message: {} }, 'junk'))).toEqual([]);
  });
});
