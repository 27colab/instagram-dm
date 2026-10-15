import { describe, expect, it } from 'vitest';
import { InMemoryDedupe, signBody, verifyChallenge, verifySignature } from '../src/index.js';

const secret = 'test-secret';
const body = '{"object":"instagram","entry":[]}';

describe('verifySignature', () => {
  it('accepts a correct signature (string and bytes)', () => {
    const h = signBody(secret, body);
    expect(verifySignature(secret, body, h)).toBe(true);
    expect(verifySignature(secret, new TextEncoder().encode(body), h)).toBe(true);
  });

  it('rejects tampered body, wrong secret, and malformed headers', () => {
    const h = signBody(secret, body);
    expect(verifySignature(secret, body + ' ', h)).toBe(false);
    expect(verifySignature('other', body, h)).toBe(false);
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, 'sha1=' + h.slice(7))).toBe(false);
    expect(verifySignature(secret, body, 'sha256=zz')).toBe(false);
    expect(verifySignature(secret, body, h.slice(0, -2))).toBe(false);
    expect(verifySignature('', body, signBody('', body))).toBe(false);
  });
});

describe('replay protection', () => {
  it('a valid signature does not prove freshness; dedupe drops the repeat', () => {
    const h = signBody(secret, body);
    expect(verifySignature(secret, body, h)).toBe(true);
    expect(verifySignature(secret, body, h)).toBe(true); // replay still verifies
    let t = 0;
    const d = new InMemoryDedupe(1000, 100, () => t);
    expect(d.seen('mid:1')).toBe(false);
    expect(d.seen('mid:1')).toBe(true);
    t = 1001;
    expect(d.seen('mid:1')).toBe(false); // TTL elapsed
  });

  it('evicts oldest entries beyond maxEntries', () => {
    const d = new InMemoryDedupe(10_000, 2);
    d.seen('a');
    d.seen('b');
    d.seen('c');
    expect(d.seen('a')).toBe(false);
  });
});

describe('verifyChallenge', () => {
  it('echoes the challenge for a matching token', () => {
    const q = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '12345' });
    expect(verifyChallenge(q, 'vt')).toEqual({ ok: true, challenge: '12345' });
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '9' }, 'vt')).toEqual({ ok: true, challenge: '9' });
  });

  it('rejects wrong token, wrong mode, missing fields, empty configured token', () => {
    const base = { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '1' };
    expect(verifyChallenge({ ...base, 'hub.verify_token': 'nope' }, 'vt').ok).toBe(false);
    expect(verifyChallenge({ ...base, 'hub.mode': 'unsubscribe' }, 'vt').ok).toBe(false);
    expect(verifyChallenge({ 'hub.mode': 'subscribe' }, 'vt').ok).toBe(false);
    expect(verifyChallenge({ ...base, 'hub.verify_token': '' }, '').ok).toBe(false);
  });
});
