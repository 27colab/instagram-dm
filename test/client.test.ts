import { describe, expect, it } from 'vitest';
import { FakeGraphApi } from '../src/testing/index.js';
import { chunkText, InstagramClient, InstagramApiError, WindowClosedError, withRetry, MAX_DM_CHARS } from '../src/index.js';

const A = '1000000000001';
const U = '2000000000002';
const H = 3600_000;

function setup() {
  let now = 1_700_000_000_000;
  const sleeps: number[] = [];
  const fake = new FakeGraphApi({ now: () => now });
  const token = fake.issueToken(A);
  const client = new InstagramClient({ accessToken: token, fetch: fake.fetch, retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 } });
  return { fake, client, sleeps, advance: (ms: number) => (now += ms), now: () => now };
}

describe('sendText and the 24h window', () => {
  it('sends inside the window', async () => {
    const { fake, client, now } = setup();
    fake.recordInbound(A, U);
    const [r] = await client.sendText(U, 'hi', { lastInboundAt: now() - H, now: now() });
    expect(r?.messageId).toMatch(/^mid_/);
    expect(fake.sent).toHaveLength(1);
  });

  it('refuses locally once the window is closed, without a network call', async () => {
    const { fake, client, now } = setup();
    await expect(client.sendText(U, 'hi', { lastInboundAt: now() - 25 * H, now: now() })).rejects.toBeInstanceOf(WindowClosedError);
    expect(fake.requests).toHaveLength(0);
  });

  it('Meta rejects an out-of-window send when no local guard is used (subcode 2534022)', async () => {
    const { client } = setup();
    await expect(client.sendText(U, 'hi')).rejects.toMatchObject({ code: 10, subcode: 2534022, isRetryable: false });
  });

  it('human agent tag allows day 2-7 and sends the tag', async () => {
    const { fake, client, advance, now } = setup();
    fake.recordInbound(A, U);
    const last = now();
    advance(48 * H);
    await client.sendText(U, 'a human follows up', { lastInboundAt: last, humanAgent: true, now: now() });
    expect(fake.sent[0]?.tag).toBe('HUMAN_AGENT');
    await expect(client.sendText(U, 'bot', { lastInboundAt: last, now: now() })).rejects.toBeInstanceOf(WindowClosedError);
  });

  it('chunks long replies into sequential messages', async () => {
    const { fake, client } = setup();
    fake.recordInbound(A, U);
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const res = await client.sendText(U, long);
    expect(res.length).toBeGreaterThan(1);
    expect(fake.sent.map((m) => m.text).join(' ')).toBe(long);
    expect(fake.sent.every((m) => m.text!.length <= MAX_DM_CHARS)).toBe(true);
  });

  it('sends sender actions', async () => {
    const { fake, client } = setup();
    await client.sendAction(U, 'mark_seen');
    expect(fake.sent[0]).toMatchObject({ senderAction: 'mark_seen' });
  });
});

describe('retry and rate limits', () => {
  it('retries 5xx then succeeds', async () => {
    const { fake, client, sleeps } = setup();
    fake.recordInbound(A, U);
    fake.failNext({ status: 503 }, 2);
    await client.sendText(U, 'hi');
    expect(fake.sent).toHaveLength(1);
    expect(sleeps).toEqual([375, 750]); // 500*2^n*(0.5+0.25)
  });

  it('honors Retry-After on rate limits', async () => {
    const { fake, client, sleeps } = setup();
    fake.recordInbound(A, U);
    fake.failNext({ status: 400, error: { code: 80002, message: 'throttled' }, headers: { 'retry-after': '7' } });
    await client.sendText(U, 'hi');
    expect(sleeps).toEqual([7000]);
  });

  it('gives up after maxRetries and surfaces the error', async () => {
    const { fake, client, sleeps } = setup();
    fake.recordInbound(A, U);
    fake.failNext({ status: 500 }, 10);
    await expect(client.sendText(U, 'hi')).rejects.toBeInstanceOf(InstagramApiError);
    expect(sleeps).toHaveLength(3);
    expect(fake.sent).toHaveLength(0);
  });

  it('does not retry client errors or bad tokens', async () => {
    const { fake, sleeps } = setup();
    const bad = new InstagramClient({ accessToken: 'nope', fetch: fake.fetch, retry: { sleep: async (ms) => void sleeps.push(ms) } });
    await expect(bad.sendText(U, 'hi')).rejects.toMatchObject({ isTokenError: true });
    expect(sleeps).toEqual([]);
  });

  it('retries network failures (TypeError) but not arbitrary errors', async () => {
    let n = 0;
    const out = await withRetry(async () => { if (n++ < 2) throw new TypeError('fetch failed'); return 'ok'; }, { sleep: async () => {} });
    expect(out).toBe('ok');
    await expect(withRetry(async () => { throw new Error('bug'); }, { sleep: async () => {} })).rejects.toThrow('bug');
  });

  it('caps waits at maxDelayMs', async () => {
    const waits: number[] = [];
    let n = 0;
    await withRetry(
      async () => { if (n++ < 1) throw new InstagramApiError('x', { status: 429, retryAfterMs: 600_000 }); },
      { sleep: async (ms) => void waits.push(ms), maxDelayMs: 5000 },
    );
    expect(waits).toEqual([5000]);
  });
});

describe('chunkText', () => {
  it('returns [] for blank and one chunk for short text', () => {
    expect(chunkText('   ')).toEqual([]);
    expect(chunkText('hi')).toEqual(['hi']);
  });
  it('hard-splits text with no spaces', () => {
    expect(chunkText('x'.repeat(25), 10).map((c) => c.length)).toEqual([10, 10, 5]);
  });
});
