import { nanoid } from "nanoid";

// In-memory lobby store for Bulldog Meet's server-side waiting room. Knocks are
// ephemeral (a knock only matters while a guest is actively waiting), so unlike
// meetings.ts this is a plain Map with no DB backing — matches the v1 spec.

export type KnockStatus =
  | "pending"
  | "admitted"
  | "denied"
  | "expired"
  | "cancelled";

export interface LobbyKnock {
  id: string; // nanoid, used as the "ticket"
  meetingCode: string;
  displayName: string;
  guestIdentity: string; // g_<nanoid> minted at knock time
  status: KnockStatus;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string; // host identity
  tokenIssued?: boolean; // flips true after the first /poll consumes the admit
}

// Knock TTL before an unanswered pending knock auto-expires.
export const KNOCK_TTL_MS = Number(process.env.LOBBY_KNOCK_TTL_MS ?? 300_000);

const knocks = new Map<string, LobbyKnock>();

export function createKnock(meetingCode: string, displayName: string): LobbyKnock {
  const knock: LobbyKnock = {
    id: nanoid(),
    meetingCode,
    displayName,
    guestIdentity: `g_${nanoid(10)}`,
    status: "pending",
    createdAt: Date.now(),
  };
  knocks.set(knock.id, knock);
  return knock;
}

export function getKnock(id: string): LobbyKnock | undefined {
  return knocks.get(id);
}

/** Pending knocks for one meeting, oldest first. */
export function listPending(meetingCode: string): LobbyKnock[] {
  return Array.from(knocks.values())
    .filter((k) => k.meetingCode === meetingCode && k.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Host decision. Returns the updated knock, or null if it wasn't pending. */
export function decideKnock(
  id: string,
  decision: "admitted" | "denied",
  hostIdentity: string,
): LobbyKnock | null {
  const knock = knocks.get(id);
  if (!knock || knock.status !== "pending") return null;
  knock.status = decision;
  knock.decidedAt = Date.now();
  knock.decidedBy = hostIdentity;
  return knock;
}

/** Guest self-cancel. No-op unless currently pending. */
export function cancelKnock(id: string): LobbyKnock | null {
  const knock = knocks.get(id);
  if (!knock || knock.status !== "pending") return null;
  knock.status = "cancelled";
  knock.decidedAt = Date.now();
  return knock;
}

export function markTokenIssued(id: string): void {
  const knock = knocks.get(id);
  if (knock) knock.tokenIssued = true;
}

/** Flip overdue pending knocks to expired. Returns how many were swept. */
export function sweepExpired(now = Date.now()): number {
  let swept = 0;
  Array.from(knocks.values()).forEach((knock) => {
    if (knock.status === "pending" && now - knock.createdAt >= KNOCK_TTL_MS) {
      knock.status = "expired";
      knock.decidedAt = now;
      swept++;
    }
  });
  return swept;
}

// ── Rate limiting ──────────────────────────────────────────────────────────
// Simple in-memory fixed-window bucket: max 5 knocks per meeting per IP per
// minute. Buckets self-expire; we lazily prune on each check.

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  windowStart: number;
}
const buckets = new Map<string, Bucket>();

/** Returns true if this knock is allowed; false if the bucket is exhausted. */
export function allowKnock(meetingCode: string, ip: string, now = Date.now()): boolean {
  const key = `${meetingCode}:${ip}`;
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

let sweeperStarted = false;

/** Start the single boot-time sweeper (30s tick). Idempotent. */
export function startLobbySweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(() => {
    try {
      sweepExpired();
    } catch {
      /* sweeper must never throw */
    }
  }, 30_000).unref?.();
}
