/**
 * lobbyBypass.ts — best-effort re-PATCH of an existing Teams online meeting
 * so guests joining via the Bulldog-distributed link skip the "someone
 * should let you in soon" wall.
 *
 * Why this exists: PR #85 verifies the lobby-bypass scope on create and
 * re-PATCHes once if Graph didn't honor it. But two failure modes still
 * strand users in the lobby:
 *
 *   1. Meetings created BEFORE PR #85 shipped (2026-07-03) never got the
 *      verify pass. Their onlineMeeting row still has whatever scope the
 *      original create call happened to persist — often the tenant default,
 *      which is not "everyone".
 *
 *   2. Tenant Meeting Policy overrode the create-time PATCH silently.
 *      Sometimes the override is transient (a policy assignment lands a
 *      few minutes later); a retry closes the window.
 *
 * `ensureLobbyBypass` is designed to be called opportunistically from the
 * meeting join path. It's fire-and-forget, best-effort, and never throws:
 * a failure here must never block the user from joining. Structured warn
 * logs let us diagnose after the fact.
 */
import { getGraphClient } from "./graphClient";

/**
 * Resolve which organizer path to use when reading/patching the meeting.
 * Prefer the object-id GUID (bypasses UPN flapping); fall back to the
 * default organizer email if only that's configured.
 *
 * We can't derive the organizer from the meeting id alone via a single
 * Graph endpoint (the /communications/onlineMeetings/{id} lookup requires
 * app-level scope we don't have). So we rely on the same env-var chain
 * createMeeting.ts uses, which is the mailbox the meeting was created
 * under. If Josh ever hosts under a different org mailbox we'd need to
 * store organizer_id on the meetings row — deferred until we see it.
 */
function resolveOrganizerPath(): string | null {
  const id = process.env.MS_GRAPH_DEFAULT_ORGANIZER_ID?.trim();
  if (id) return id;
  const email = process.env.MS_GRAPH_DEFAULT_ORGANIZER?.trim() || "admin@bulldogops.com";
  return email;
}

export interface LobbyBypassResult {
  /** True when we finished with scope === "everyone" (either it was already
   *  right, or our PATCH landed). False when the tenant policy is blocking. */
  ok: boolean;
  /** The scope observed after the final GET. "everyone" | "organization" |
   *  "organizationAndFederated" | "invited" | null when Graph didn't return it. */
  observedScope: string | null;
  /** True when we actually issued a PATCH (helps distinguish healthy calls
   *  from ones that self-healed). */
  patched: boolean;
  /** Optional error message when the call short-circuited. */
  reason?: string;
}

/**
 * Best-effort ensure the Teams onlineMeeting `teamsMeetingId` has
 * lobbyBypassSettings.scope === "everyone". Never throws.
 *
 * Timeline of a call:
 *   1. GET the meeting to read current scope. If already "everyone", exit.
 *   2. PATCH lobbyBypassSettings = { scope: "everyone", isDialInBypassEnabled: true }.
 *   3. GET again to confirm. If still not "everyone", log a TENANT-POLICY-OVERRIDE
 *      warning with the fix hint so the next reader (or observability
 *      pipeline) can spot it immediately.
 */
export async function ensureLobbyBypass(teamsMeetingId: string): Promise<LobbyBypassResult> {
  const client = await getGraphClient();
  if (!client) {
    return { ok: false, observedScope: null, patched: false, reason: "graph-unavailable" };
  }
  const organizer = resolveOrganizerPath();
  if (!organizer) {
    return { ok: false, observedScope: null, patched: false, reason: "no-organizer" };
  }

  const base = `/users/${encodeURIComponent(organizer)}/onlineMeetings/${teamsMeetingId}`;

  // Step 1 — read current scope.
  let currentScope: string | null = null;
  try {
    const cur = await client.api(base).select("id,lobbyBypassSettings").get();
    currentScope = typeof cur?.lobbyBypassSettings?.scope === "string"
      ? String(cur.lobbyBypassSettings.scope)
      : null;
  } catch (err) {
    // 404 here is important: it means the organizer path doesn't match.
    // Log with the resolved organizer so the fix is one-glance visible.
    console.warn(JSON.stringify({
      msg: "teams_lobby_bypass_read_failed",
      teamsMeetingId,
      organizer,
      error: (err as Error)?.message ?? String(err),
    }));
    return { ok: false, observedScope: null, patched: false, reason: "read-failed" };
  }

  if (currentScope === "everyone") {
    return { ok: true, observedScope: "everyone", patched: false };
  }

  // Step 2 — try to PATCH.
  try {
    await client.api(base).patch({
      lobbyBypassSettings: { scope: "everyone", isDialInBypassEnabled: true },
    });
  } catch (err) {
    console.warn(JSON.stringify({
      msg: "teams_lobby_bypass_patch_failed",
      teamsMeetingId,
      organizer,
      previousScope: currentScope,
      error: (err as Error)?.message ?? String(err),
    }));
    return { ok: false, observedScope: currentScope, patched: false, reason: "patch-failed" };
  }

  // Step 3 — verify.
  let verified: string | null = null;
  try {
    const v = await client.api(base).select("id,lobbyBypassSettings").get();
    verified = typeof v?.lobbyBypassSettings?.scope === "string"
      ? String(v.lobbyBypassSettings.scope)
      : null;
  } catch (err) {
    console.warn(JSON.stringify({
      msg: "teams_lobby_bypass_verify_failed",
      teamsMeetingId,
      organizer,
      error: (err as Error)?.message ?? String(err),
    }));
    return { ok: false, observedScope: null, patched: true, reason: "verify-failed" };
  }

  if (verified === "everyone") {
    console.log(JSON.stringify({
      msg: "teams_lobby_bypass_healed",
      teamsMeetingId,
      previousScope: currentScope,
    }));
    return { ok: true, observedScope: "everyone", patched: true };
  }

  // Tenant policy is actively overriding the per-meeting setting.
  console.warn(JSON.stringify({
    msg: "teams_lobby_bypass_tenant_override",
    teamsMeetingId,
    observedScope: verified,
    fix: "Teams Admin Center → Meetings → Meeting policies → 'Who can bypass the lobby' = Everyone for the organizer's assigned policy.",
  }));
  return { ok: false, observedScope: verified, patched: true, reason: "tenant-override" };
}

/**
 * Fire-and-forget wrapper used from hot paths (e.g. the /join handler)
 * where we don't want to block the request on a Graph round-trip. Callers
 * should NOT await the returned promise.
 */
export function ensureLobbyBypassAsync(teamsMeetingId: string): void {
  // A recent Graph read of the same meeting id is cached in-memory below
  // so a burst of joins doesn't hammer Graph. TTL is short (60s) — long
  // enough to coalesce a wave of attendees clicking Join within a minute,
  // short enough that a tenant-policy fix mid-meeting still self-heals.
  const now = Date.now();
  const cached = healCache.get(teamsMeetingId);
  if (cached && now - cached < HEAL_CACHE_TTL_MS) return;
  healCache.set(teamsMeetingId, now);
  // Void-swallow: never crash the caller. All error surfaces log via the
  // structured JSON warnings above.
  ensureLobbyBypass(teamsMeetingId).catch(() => {
    /* logged inside */
  });
}

const HEAL_CACHE_TTL_MS = 60_000;
const healCache = new Map<string, number>();
