import { describe, expect, it } from 'vitest';
import { FakeGraphApi } from '../src/testing/index.js';
import {
  buildAuthorizeUrl, exchangeCode, exchangeLongLived, fetchProfile, refreshLongLived,
  shouldRefresh, signState, subscribeToWebhooks, verifyState, InstagramApiError, type OAuthConfig,
} from '../src/index.js';

const DAY = 24 * 3600_000;
function setup() {
  let now = 1_700_000_000_000;
  const fake = new FakeGraphApi({ now: () => now });
  const cfg: OAuthConfig = {
    appId: 'app-123', appSecret: 'secret', redirectUri: 'https://example.invalid/cb',
    fetch: fake.fetch, retry: { sleep: async () => {} },
  };
  return { fake, cfg, advance: (ms: number) => (now += ms), now: () => now };
}

describe('authorize URL and state', () => {
  it('builds the URL with scopes and state', () => {
    const { cfg } = setup();
    const u = new URL(buildAuthorizeUrl(cfg, 'st'));
    expect(u.origin + u.pathname).toBe('https://www.instagram.com/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('app-123');
    expect(u.searchParams.get('scope')).toBe('instagram_business_basic,instagram_business_manage_messages');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('round-trips state and rejects forged / expired / malformed', () => {
    const s = signState('workspace-1', 'k', { now: 1000, ttlMs: 500 });
    expect(verifyState(s, 'k', 1200)).toBe('workspace-1');
    expect(verifyState(s, 'k', 1501)).toBeNull();
    expect(verifyState(s, 'wrong', 1200)).toBeNull();
    expect(verifyState('garbage', 'k', 1200)).toBeNull();
    expect(() => signState('a|b', 'k')).toThrow();
  });
});

describe('token flow', () => {
  it('code -> short -> long-lived -> profile -> subscribe', async () => {
    const { fake, cfg, now } = setup();
    const code = fake.issueAuthCode('1000000000001', 'demo_shop');
    const short = await exchangeCode(cfg, code + '#_');
    expect(short.userId).toBe('1000000000001');
    const long = await exchangeLongLived(cfg, short.accessToken, now());
    expect(long.expiresAt).toBe(now() + 60 * DAY);
    expect(await fetchProfile(cfg, long.accessToken)).toEqual({ igUserId: '1000000000001', username: 'demo_shop' });
    await expect(subscribeToWebhooks(cfg, long.accessToken)).resolves.toBeUndefined();
  });

  it('rejects a reused or bogus code', async () => {
    const { fake, cfg } = setup();
    const code = fake.issueAuthCode('1');
    await exchangeCode(cfg, code);
    await expect(exchangeCode(cfg, code)).rejects.toBeInstanceOf(InstagramApiError);
  });
});

describe('token refresh', () => {
  it('refreshes a token older than 24h and returns a new expiry', async () => {
    const { fake, cfg, now } = setup();
    const tok = fake.issueToken('1', { ageMs: 40 * DAY, ttlMs: 60 * DAY });
    const fresh = await refreshLongLived(cfg, tok, now());
    expect(fresh.accessToken).not.toBe(tok);
    expect(fresh.expiresAt).toBe(now() + 60 * DAY);
  });

  it('Meta refuses tokens younger than 24h', async () => {
    const { fake, cfg } = setup();
    const tok = fake.issueToken('1', { ageMs: 3600_000 });
    await expect(refreshLongLived(cfg, tok)).rejects.toMatchObject({ code: 10 });
  });

  it('cannot refresh an expired token (must re-authorize)', async () => {
    const { fake, cfg } = setup();
    const tok = fake.issueToken('1', { ageMs: 70 * DAY, ttlMs: 60 * DAY });
    await expect(refreshLongLived(cfg, tok)).rejects.toMatchObject({ isTokenError: true });
  });

  it('shouldRefresh covers young, due, far-from-expiry and expired tokens', () => {
    const now = 100 * DAY;
    expect(shouldRefresh({ issuedAt: now - 2 * 3600_000, expiresAt: now + 5 * DAY }, { now })).toBe(false); // too young
    expect(shouldRefresh({ expiresAt: now + 10 * DAY }, { now })).toBe(true); // due
    expect(shouldRefresh({ expiresAt: now + 50 * DAY }, { now })).toBe(false); // plenty left
    expect(shouldRefresh({ expiresAt: now - 1 }, { now })).toBe(false); // expired
  });
});
