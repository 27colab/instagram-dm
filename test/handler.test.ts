import { describe, expect, it } from 'vitest';
import { FakeGraphApi, textEvent } from '../src/testing/index.js';
import { createWebhookHandler, InstagramClient, type ConversationHandler } from '../src/index.js';

const A = '1000000000001';
const U = '2000000000002';

function setup(conversation: ConversationHandler, extra: Partial<Parameters<typeof createWebhookHandler>[0]> = {}) {
  const fake = new FakeGraphApi({ appSecret: 's3' });
  const client = new InstagramClient({ accessToken: fake.issueToken(A), fetch: fake.fetch, retry: { sleep: async () => {} } });
  const errors: unknown[] = [];
  const hook = createWebhookHandler({
    appSecret: 's3', verifyToken: 'vt', conversation,
    resolveClient: (id) => (id === A ? client : undefined),
    onError: (e) => void errors.push(e),
    ...extra,
  });
  const deliver = (...events: unknown[]) => {
    const { rawBody, headers } = fake.buildWebhook(events, A);
    return { rawBody, headers };
  };
  return { fake, hook, deliver, errors };
}

describe('webhook handler', () => {
  it('answers the GET handshake', async () => {
    const { hook } = setup({ onMessage: () => {} });
    const ok = await hook.handle({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': 'abc' }, headers: {} });
    expect(ok).toMatchObject({ status: 200, body: 'abc' });
    const bad = await hook.handle({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': 'abc' }, headers: {} });
    expect(bad.status).toBe(403);
  });

  it('rejects bad or missing signatures and never calls the app', async () => {
    let called = 0;
    const { hook, deliver } = setup({ onMessage: () => void called++ });
    const { rawBody } = deliver(textEvent({ accountId: A, userId: U, mid: 'm1', text: 'hi' }));
    expect((await hook.handle({ method: 'POST', headers: {}, rawBody })).status).toBe(401);
    expect((await hook.handle({ method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) }, rawBody })).status).toBe(401);
    expect(called).toBe(0);
  });

  it('replies with the returned string and ignores header case', async () => {
    const { fake, hook, deliver } = setup({ onMessage: (ctx) => `echo: ${ctx.event.text}` });
    fake.recordInbound(A, U);
    const { rawBody, headers } = deliver(textEvent({ accountId: A, userId: U, mid: 'm1', text: 'hi' }));
    const res = await hook.handle({ method: 'POST', headers: { 'X-Hub-Signature-256': headers['x-hub-signature-256']! }, rawBody });
    expect(res.status).toBe(200);
    expect(fake.sent.map((m) => m.text)).toEqual(['echo: hi']);
  });

  it('drops a replayed delivery (same mid) after the first', async () => {
    const seen: string[] = [];
    const { fake, hook, deliver } = setup({ onMessage: (c) => void seen.push(c.event.mid) });
    fake.recordInbound(A, U);
    const d = deliver(textEvent({ accountId: A, userId: U, mid: 'm1', text: 'hi' }));
    await hook.handle({ method: 'POST', ...d });
    await hook.handle({ method: 'POST', ...d });
    expect(seen).toEqual(['m1']);
  });

  it('routes echoes and receipts to onEvent, not onMessage', async () => {
    const kinds: string[] = [];
    let msgs = 0;
    const { hook, deliver } = setup({ onMessage: () => void msgs++, onEvent: (e) => void kinds.push(e.kind) });
    await hook.handle({
      method: 'POST',
      ...deliver(
        { sender: { id: A }, recipient: { id: U }, timestamp: 1, message: { mid: 'e1', text: 'ours', is_echo: true } },
        { sender: { id: U }, recipient: { id: A }, timestamp: 2, read: { mid: 'e1' } },
      ),
    });
    expect(kinds).toEqual(['echo', 'read']);
    expect(msgs).toBe(0);
  });

  it('a throwing app handler is reported but still returns 200 (no Meta retry storm)', async () => {
    const { hook, deliver, errors } = setup({ onMessage: () => { throw new Error('boom'); } });
    const res = await hook.handle({ method: 'POST', ...deliver(textEvent({ accountId: A, userId: U, mid: 'm1', text: 'hi' })) });
    expect(res.status).toBe(200);
    expect(errors).toHaveLength(1);
  });

  it('works through the Web Request/Response adapter', async () => {
    const { fake, hook, deliver } = setup({ onMessage: () => 'pong' });
    fake.recordInbound(A, U);
    const { rawBody, headers } = deliver(textEvent({ accountId: A, userId: U, mid: 'm1', text: 'ping' }));
    const res = await hook.fetch(new Request('https://example.invalid/hook', { method: 'POST', body: rawBody, headers }));
    expect(res.status).toBe(200);
    expect(fake.sent[0]?.text).toBe('pong');
    const get = await hook.fetch(new Request('https://example.invalid/hook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=77'));
    expect(await get.text()).toBe('77');
  });

  it('waitUntil defers processing', async () => {
    let pending: Promise<unknown> | undefined;
    const { fake, hook, deliver } = setup({ onMessage: () => 'later' }, { waitUntil: (p) => void (pending = p) });
    fake.recordInbound(A, U);
    const res = await hook.handle({ method: 'POST', ...deliver(textEvent({ accountId: A, userId: U, mid: 'm1', text: 'x' })) });
    expect(res.status).toBe(200);
    await pending;
    expect(fake.sent).toHaveLength(1);
  });
});
