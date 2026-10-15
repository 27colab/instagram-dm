import { describe, expect, it } from 'vitest';
import { evaluateWindow, WindowTracker, HUMAN_AGENT_WINDOW_MS, STANDARD_WINDOW_MS } from '../src/index.js';

const H = 3600_000;

describe('evaluateWindow', () => {
  it('is open inside 24h and closed after', () => {
    expect(evaluateWindow(0, { now: 23 * H }).open).toBe(true);
    expect(evaluateWindow(0, { now: 24 * H }).open).toBe(false);
    expect(evaluateWindow(0, { now: 25 * H })).toMatchObject({ open: false, remainingMs: 0, expiresAt: STANDARD_WINDOW_MS });
  });

  it('reports remaining time', () => {
    expect(evaluateWindow(0, { now: 20 * H }).remainingMs).toBe(4 * H);
  });

  it('human agent extends to 7 days', () => {
    expect(evaluateWindow(0, { now: 48 * H, humanAgent: true })).toMatchObject({ open: true, mode: 'human_agent' });
    expect(evaluateWindow(0, { now: HUMAN_AGENT_WINDOW_MS, humanAgent: true }).open).toBe(false);
  });

  it('accepts Date input', () => {
    expect(evaluateWindow(new Date(0), { now: H }).open).toBe(true);
  });
});

describe('WindowTracker', () => {
  it('tracks per account/user and keeps the latest inbound', () => {
    let now = 0;
    const t = new WindowTracker(() => now);
    expect(t.status('a', 'u')).toBeUndefined();
    t.recordInbound('a', 'u', 10 * H);
    t.recordInbound('a', 'u', 5 * H); // older, ignored
    now = 30 * H;
    expect(t.status('a', 'u')?.open).toBe(true); // 10h + 24h = 34h
    now = 35 * H;
    expect(t.status('a', 'u')?.open).toBe(false);
    expect(t.status('a', 'other')).toBeUndefined();
  });
});
