/**
 * Messaging-window rules for Instagram DMs (as documented by Meta at the time
 * of writing; re-check the current platform docs before relying on them):
 *
 * - Standard window: you may message a person for 24 hours after their most
 *   recent inbound message.
 * - HUMAN_AGENT tag: extends that to 7 days, for a real human following up.
 *   Requires the Human Agent feature on your app and must not be used for
 *   automated messages.
 */
export const STANDARD_WINDOW_MS = 24 * 60 * 60_000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type WindowMode = 'standard' | 'human_agent';

export interface WindowStatus {
  open: boolean;
  mode: WindowMode;
  /** Epoch ms at which the window closes (or closed). */
  expiresAt: number;
  /** Ms left; 0 when closed. */
  remainingMs: number;
}

export function evaluateWindow(
  lastInboundAt: number | Date,
  opts: { now?: number; humanAgent?: boolean } = {},
): WindowStatus {
  const now = opts.now ?? Date.now();
  const last = lastInboundAt instanceof Date ? lastInboundAt.getTime() : lastInboundAt;
  const mode: WindowMode = opts.humanAgent ? 'human_agent' : 'standard';
  const expiresAt = last + (opts.humanAgent ? HUMAN_AGENT_WINDOW_MS : STANDARD_WINDOW_MS);
  const remainingMs = Math.max(0, expiresAt - now);
  return { open: remainingMs > 0, mode, expiresAt, remainingMs };
}

/** Tracks the last inbound time per (account, user) so callers can ask "may I send?". */
export class WindowTracker {
  private readonly last = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  recordInbound(accountId: string, userId: string, at: number = this.now()): void {
    const key = `${accountId}:${userId}`;
    this.last.set(key, Math.max(at, this.last.get(key) ?? 0));
  }

  status(accountId: string, userId: string, humanAgent = false): WindowStatus | undefined {
    const at = this.last.get(`${accountId}:${userId}`);
    return at === undefined ? undefined : evaluateWindow(at, { now: this.now(), humanAgent });
  }
}
