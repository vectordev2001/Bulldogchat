// Recent-channels store for the top-left logo dropdown.
//
// Design goals:
//  - Zero server round-trip. Just localStorage, so it's instant on click
//    and survives reloads / PWA restarts.
//  - Per-user keyed so multi-tenant machines (or "sign out, sign in as
//    someone else") don't leak one user's recents to another.
//  - Preserves both regular channels and DMs (DMs are channels with
//    scope='dm', but the parent Home.tsx switches views differently, so
//    we round-trip the kind so the click handler knows which selector
//    to call).
//  - Broadcasts a `bulldog:recent-channels-changed` window event so the
//    header re-reads without us having to lift state into Home.
//
// Storage shape:
//   key: bulldog_recent_channels_v1:<userId>
//   value: JSON.stringify(RecentEntry[])   // most-recent-first, capped
//
// We cache the display label at push time so the dropdown renders
// instantly on open, before any query round-trip. Names can drift
// (channel rename, added DM participant) but the row is a hop shortcut
// keyed by channelId, and the destination view re-renders with the
// current live name; a slightly stale label on the dropdown row is
// acceptable. Callers may pass a fresh label on every push so the
// cache gets rehydrated as the user hops around.

const STORAGE_KEY_PREFIX = "bulldog_recent_channels_v1";
const MAX_ENTRIES = 8; // store a few extra so the header can still show
                       // 5 after some get filtered as deleted/hidden.

export const RECENT_CHANNELS_EVENT = "bulldog:recent-channels-changed";

export type RecentChannelKind = "channel" | "dm";

export interface RecentEntry {
  channelId: number;
  // For a DM this is unused (DMs are cross-project); we still round-trip
  // it as null so the shape is uniform.
  projectId: number | null;
  kind: RecentChannelKind;
  // Display label captured at push time. See file header for staleness
  // notes. Optional so older entries from a prior version keep loading.
  label?: string;
  // Optional secondary line — usually the project name for regular
  // channels. Null / omitted for DMs.
  subLabel?: string | null;
  // Unix ms of the last selection — used only for sort/tie-break, never
  // shown in the UI.
  ts: number;
}

function storageKey(userId: number | null | undefined): string | null {
  if (!userId || !Number.isFinite(userId)) return null;
  return `${STORAGE_KEY_PREFIX}:${userId}`;
}

function readRaw(userId: number | null | undefined): RecentEntry[] {
  if (typeof window === "undefined") return [];
  const key = storageKey(userId);
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check: drop any entry missing required fields so
    // an older/broken payload can't crash the header.
    return parsed
      .filter((e): e is RecentEntry =>
        e && typeof e.channelId === "number" &&
        (e.kind === "channel" || e.kind === "dm") &&
        typeof e.ts === "number",
      )
      .map((e) => ({
        // Normalize optional fields so the render side doesn't have to
        // guard against undefined vs empty string on every row.
        channelId: e.channelId,
        projectId: typeof e.projectId === "number" ? e.projectId : null,
        kind: e.kind,
        label: typeof e.label === "string" ? e.label : undefined,
        subLabel: typeof e.subLabel === "string" ? e.subLabel : null,
        ts: e.ts,
      }))
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeRaw(userId: number | null | undefined, entries: RecentEntry[]) {
  if (typeof window === "undefined") return;
  const key = storageKey(userId);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(entries));
    window.dispatchEvent(new CustomEvent(RECENT_CHANNELS_EVENT));
  } catch {
    // Full storage / private mode — swallow. Recents are a nice-to-have,
    // not a correctness feature.
  }
}

/**
 * Record a channel or DM open. Called from Home.tsx `selectChannel` /
 * `selectDm`. Deduplicates by channelId so re-opening the same channel
 * just refreshes its timestamp (and moves it back to the top) instead
 * of pushing a second stale copy.
 */
export function pushRecentChannel(
  userId: number | null | undefined,
  entry: Omit<RecentEntry, "ts">,
): void {
  if (!userId) return;
  const now = Date.now();
  const existing = readRaw(userId).filter((e) => e.channelId !== entry.channelId);
  const next: RecentEntry[] = [{ ...entry, ts: now }, ...existing].slice(0, MAX_ENTRIES);
  writeRaw(userId, next);
}

/**
 * Read the recent list, most-recent-first. Consumers apply their own
 * upper bound (header shows 5).
 */
export function getRecentChannels(userId: number | null | undefined): RecentEntry[] {
  return readRaw(userId);
}

/**
 * Drop a specific entry. Called when we discover the channel no longer
 * exists (e.g. it was deleted) so a broken row doesn't stick around
 * across sessions.
 */
export function forgetRecentChannel(
  userId: number | null | undefined,
  channelId: number,
): void {
  if (!userId) return;
  const filtered = readRaw(userId).filter((e) => e.channelId !== channelId);
  writeRaw(userId, filtered);
}
