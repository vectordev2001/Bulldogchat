// Sync deactivated/active state from bulldog-auth into the chat user table.
//
// bulldog-auth is the source of truth for who exists. When a user is deleted
// or disabled there, they must stop showing up in chat. The chat `users` rows
// are never hard-deleted (FKs reference them), so we soft-deactivate instead
// and the roster endpoint filters `deactivated = 0`.
//
// Auth roster endpoint: GET /api/admin/users → { users: [{ email, phone?,
// active? }] }. `active !== false` means the user is active. That endpoint is
// cookie-protected (admin's bulldog_access JWT), so the only callers that can
// reach it are:
//   1. an admin loading /api/org/members (cookie forwarded), and
//   2. an admin hitting POST /api/admin/sync-users (cookie forwarded).
// A cookieless background job (see index.ts) can only run if a service secret
// is configured AND auth exposes a secret-authed roster route; otherwise it
// no-ops cleanly. The reliable, always-on fix is the roster filter — this
// sync just keeps the `deactivated` flag converged.

import { storage } from "./storage";

const DEFAULT_ORG_ID = 1; // single-org install (see bulldog-sso.ts)

export interface SyncResult {
  checked: number;
  deactivated: number;
  reactivated: number;
  source: "cookie" | "secret" | "none";
}

interface SyncOpts {
  // Forward an admin's bulldog_access cookie verbatim to auth's admin API.
  cookieHeader?: string;
  // The user triggering the sync — never deactivate them (no self-lockout).
  callerUserId?: number;
  orgId?: number;
}

function authBase(): string {
  return process.env.BULLDOG_AUTH_URL || "https://auth.bulldogops.com";
}

// Fetch the canonical roster from auth. Returns null if we have no usable
// credential or the call fails — caller treats null as "skip, don't mutate".
async function fetchAuthRoster(
  opts: SyncOpts,
): Promise<{ activeEmails: Set<string>; phoneByEmail: Map<string, string>; source: "cookie" | "secret" } | null> {
  const base = authBase();

  // Prefer the admin cookie path (the proven, existing integration).
  if (opts.cookieHeader && /(?:^|;\s*)bulldog_access=/.test(opts.cookieHeader)) {
    const parsed = await tryFetch(`${base}/api/admin/users`, { Cookie: opts.cookieHeader });
    if (parsed) return { ...parsed, source: "cookie" };
  }

  // Optional cookieless path for the background job: only if a shared secret
  // is configured. We try the same admin route with the suite secret header;
  // if auth doesn't accept it, this fails closed (null) and we no-op.
  const secret = process.env.SUITE_INTERNAL_SECRET;
  if (secret) {
    const parsed = await tryFetch(`${base}/api/admin/users`, { "x-suite-secret": secret });
    if (parsed) return { ...parsed, source: "secret" };
  }

  return null;
}

async function tryFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{ activeEmails: Set<string>; phoneByEmail: Map<string, string> } | null> {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.warn(`[user-sync] auth ${url} returned ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as
      | { users?: Array<{ email?: string; phone?: string | null; active?: boolean }> }
      | Array<{ email?: string; phone?: string | null; active?: boolean }>;
    const authUsers = Array.isArray(body) ? body : body.users ?? [];
    const activeEmails = new Set<string>();
    const phoneByEmail = new Map<string, string>();
    for (const au of authUsers) {
      if (!au.email) continue;
      const e = au.email.toLowerCase();
      if (au.active !== false) activeEmails.add(e);
      if (au.phone) phoneByEmail.set(e, au.phone);
    }
    return { activeEmails, phoneByEmail };
  } catch (e: any) {
    console.warn(`[user-sync] fetch ${url} failed:`, e?.message);
    return null;
  }
}

export async function syncDeactivatedFromAuth(opts: SyncOpts = {}): Promise<SyncResult> {
  const orgId = opts.orgId ?? DEFAULT_ORG_ID;
  const roster = await fetchAuthRoster(opts);
  if (!roster) {
    return { checked: 0, deactivated: 0, reactivated: 0, source: "none" };
  }
  const { activeEmails, phoneByEmail, source } = roster;

  const chatUsers = storage.listUsersByOrg(orgId);
  let deactivated = 0;
  let reactivated = 0;

  for (const cu of chatUsers) {
    if (!cu.email) continue;
    if (cu.id === opts.callerUserId) continue; // never lock out the caller
    const e = cu.email.toLowerCase();
    if (e.endsWith("@deleted.local")) continue; // already system-deleted

    // Backfill phone from auth if we don't have one locally.
    if (!cu.phone) {
      const fresh = phoneByEmail.get(e);
      if (fresh) {
        try { storage.updateUser(cu.id, { phone: fresh }); }
        catch (err) { console.warn("[user-sync] phone backfill failed:", err); }
      }
    }

    const shouldBeActive = activeEmails.has(e);
    if (!shouldBeActive && !cu.deactivated) {
      try {
        storage.setUserDeactivated(cu.id, true);
        deactivated++;
        console.log(`[user-sync] deactivated user id=${cu.id} email=${cu.email} (not in auth active set)`);
      } catch (err) {
        console.warn("[user-sync] deactivate failed:", err);
      }
    } else if (shouldBeActive && cu.deactivated) {
      try {
        storage.setUserDeactivated(cu.id, false);
        reactivated++;
        console.log(`[user-sync] reactivated user id=${cu.id} email=${cu.email}`);
      } catch (err) {
        console.warn("[user-sync] reactivate failed:", err);
      }
    }
  }

  console.log(`[user-sync] done source=${source} checked=${chatUsers.length} deactivated=${deactivated} reactivated=${reactivated}`);
  return { checked: chatUsers.length, deactivated, reactivated, source };
}
