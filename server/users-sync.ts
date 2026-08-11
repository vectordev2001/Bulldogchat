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
  provisioned: number;
  // Number of existing chat users whose role was changed to match auth.
  // This fires when auth promoted/demoted someone (e.g. user → admin) but
  // their existing bulldog_access JWT still carries the old role, so the
  // per-request SSO bridge alone can't catch it.
  rolesUpdated: number;
  // Number of existing chat users whose display name was refreshed from
  // auth (renames in auth propagate on the next sync).
  namesUpdated: number;
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
): Promise<{
  activeEmails: Set<string>;
  phoneByEmail: Map<string, string>;
  rowByEmail: Map<string, AuthRosterRow>;
  source: "cookie" | "secret";
} | null> {
  const base = authBase();
  const secret = process.env.SUITE_INTERNAL_SECRET;

  // Prefer the secret path against /api/internal/users?app=chat — it filters
  // server-side by appAccess (only users the admin granted chat access to)
  // and works from cookieless contexts (background job + on-demand admin
  // triggers without forwarding cookies).
  if (secret) {
    const parsed = await tryFetch(`${base}/api/internal/users?app=chat`, { "x-suite-secret": secret });
    if (parsed) return { ...parsed, source: "secret" };
  }

  // Fall back to the admin cookie path (works for an admin user driving the
  // UI). Returns the full roster — no app-access filtering on this path,
  // but provisioning is a no-op for users we already know about so the cost
  // is acceptable.
  if (opts.cookieHeader && /(?:^|;\s*)bulldog_access=/.test(opts.cookieHeader)) {
    const parsed = await tryFetch(`${base}/api/admin/users`, { Cookie: opts.cookieHeader });
    if (parsed) return { ...parsed, source: "cookie" };
  }

  // Last-resort secret call to the admin route (older auth versions before
  // /api/internal/users shipped).
  if (secret) {
    const parsed = await tryFetch(`${base}/api/admin/users`, { "x-suite-secret": secret });
    if (parsed) return { ...parsed, source: "secret" };
  }

  return null;
}

// One row of the auth roster we keep around for provisioning. We carry
// displayName/role/appAccess so newly-created chat rows match what the
// admin configured in auth.
interface AuthRosterRow {
  email: string;
  displayName?: string | null;
  role?: string | null;
  phone?: string | null;
  appAccess?: string[] | null;
}

async function tryFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{
  activeEmails: Set<string>;
  phoneByEmail: Map<string, string>;
  rowByEmail: Map<string, AuthRosterRow>;
} | null> {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.warn(`[user-sync] auth ${url} returned ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as
      | { users?: Array<AuthRosterRow & { active?: boolean }> }
      | Array<AuthRosterRow & { active?: boolean }>;
    const authUsers = Array.isArray(body) ? body : body.users ?? [];
    const activeEmails = new Set<string>();
    const phoneByEmail = new Map<string, string>();
    const rowByEmail = new Map<string, AuthRosterRow>();
    for (const au of authUsers) {
      if (!au.email) continue;
      const e = au.email.toLowerCase();
      if (au.active !== false) activeEmails.add(e);
      if (au.phone) phoneByEmail.set(e, au.phone);
      rowByEmail.set(e, {
        email: e,
        displayName: au.displayName ?? null,
        role: au.role ?? null,
        phone: au.phone ?? null,
        appAccess: au.appAccess ?? null,
      });
    }
    return { activeEmails, phoneByEmail, rowByEmail };
  } catch (e: any) {
    console.warn(`[user-sync] fetch ${url} failed:`, e?.message);
    return null;
  }
}

// Map an auth role string onto chat's role enum. Phase 2.0 collapses chat to
// user/manager/admin. Auth's super_admin maps to admin locally; manager stays
// manager; every other (legacy) value becomes a plain user.
function mapAuthRoleToChatRole(authRole: string | null | undefined):
  "admin" | "manager" | "user" {
  const r = (authRole || "").toLowerCase();
  if (r === "admin" || r === "super_admin") return "admin";
  if (r === "manager") return "manager";
  return "user";
}

export async function syncDeactivatedFromAuth(opts: SyncOpts = {}): Promise<SyncResult> {
  const orgId = opts.orgId ?? DEFAULT_ORG_ID;
  const roster = await fetchAuthRoster(opts);
  if (!roster) {
    return { checked: 0, deactivated: 0, reactivated: 0, provisioned: 0, source: "none" };
  }
  const { activeEmails, phoneByEmail, rowByEmail, source } = roster;

  const chatUsers = storage.listUsersByOrg(orgId);
  let deactivated = 0;
  let reactivated = 0;
  let provisioned = 0;
  let rolesUpdated = 0;
  let namesUpdated = 0;

  // 1. Reconcile state on existing chat users.
  const chatEmails = new Set<string>();
  for (const cu of chatUsers) {
    if (!cu.email) continue;
    if (cu.id === opts.callerUserId) continue; // never lock out the caller
    const e = cu.email.toLowerCase();
    chatEmails.add(e);
    if (e.endsWith("@deleted.local")) continue; // already system-deleted

    // Backfill phone from auth if we don't have one locally.
    if (!cu.phone) {
      const fresh = phoneByEmail.get(e);
      if (fresh) {
        try { storage.updateUser(cu.id, { phone: fresh }); }
        catch (err) { console.warn("[user-sync] phone backfill failed:", err); }
      }
    }

    // Reconcile role and display name from auth on every sync. Auth is
    // Phase-2.0 source of truth for role; the per-request SSO bridge only
    // catches changes on the *next* request that carries a JWT reissued
    // after the role change, and JWT cookies don't rotate on demand. So a
    // promotion in auth's Admin Panel could sit invisible in chat until
    // the user re-logged in. Doing it here closes that gap — within one
    // sync tick of the auth change, chat picks up the new role.
    const authRow = rowByEmail.get(e);
    if (authRow) {
      const desiredRole = mapAuthRoleToChatRole(authRow.role);
      if (desiredRole !== cu.role) {
        try {
          storage.updateUser(cu.id, { role: desiredRole });
          rolesUpdated++;
          console.log(`[user-sync] role change id=${cu.id} email=${cu.email} ${cu.role} → ${desiredRole}`);
        } catch (err) {
          console.warn("[user-sync] role reconcile failed:", err);
        }
      }
      const desiredName = (authRow.displayName || "").trim();
      if (desiredName && desiredName !== (cu.name || "").trim()) {
        try {
          storage.updateUser(cu.id, { name: desiredName });
          namesUpdated++;
        } catch (err) {
          console.warn("[user-sync] name reconcile failed:", err);
        }
      }
    }

    // appAccess revocation: if auth's row explicitly excludes 'chat',
    // treat the user as deactivated in chat even if they're still active
    // in auth overall. `activeEmails` already tracks the auth-level active
    // flag; here we tighten it to app-scoped access. Legacy rows with a
    // null/undefined appAccess are still treated as "all apps" (backcompat).
    let shouldBeActive = activeEmails.has(e);
    if (authRow && Array.isArray(authRow.appAccess) && !authRow.appAccess.includes("chat")) {
      shouldBeActive = false;
    }
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

  // 2. Provision new users from auth that don't exist in chat yet.
  // This is the fix for: 'I added TestJosh in auth but can't see them in chat'.
  // Without this step new auth users were invisible to chat until they
  // personally logged in (which triggered the per-request SSO bridge).
  //
  // We only provision users that are (a) active in auth and (b) either have
  // chat in their appAccess (when filtered roster came from /api/internal/users)
  // OR have a null/legacy appAccess. The /api/internal/users?app=chat endpoint
  // already pre-filters, so on the secret path we trust the roster verbatim.
  rowByEmail.forEach((row, email) => {
    if (chatEmails.has(email)) return;        // already provisioned
    if (!activeEmails.has(email)) return;     // skip deactivated
    if (email.endsWith("@deleted.local")) return;

    // When the roster came from the legacy /api/admin/users path we did not
    // pre-filter by appAccess. Respect explicit revocations: if appAccess is
    // an array and chat is not in it, skip provisioning. null/undefined =
    // legacy 'all apps' — provision.
    const access = row.appAccess;
    if (Array.isArray(access) && !access.includes("chat")) return;

    try {
      const created = storage.createUser({
        orgId,
        email,
        passwordHash: "", // SSO-only login
        name: (row.displayName || "").trim() || email,
        role: mapAuthRoleToChatRole(row.role),
        phone: row.phone ?? null,
      } as Parameters<typeof storage.createUser>[0]);

      // Seed project membership so the new user shows up in every job's
      // member list and in @-mention / Add-User pickers immediately. This
      // mirrors what bulldogSsoBridge does on first login.
      try {
        const orgProjects = storage.listProjectsByOrg(orgId);
        for (const p of orgProjects) {
          try { storage.addProjectMember(p.id, created.id, "member"); }
          catch { /* duplicate is fine */ }
        }
      } catch (err) {
        console.warn("[user-sync] seed project membership failed:", err);
      }

      provisioned++;
      console.log(`[user-sync] provisioned user id=${created.id} email=${email} (created from auth)`);
    } catch (err) {
      console.warn(`[user-sync] provision failed for ${email}:`, err);
    }
  });

  console.log(
    `[user-sync] done source=${source} checked=${chatUsers.length} ` +
    `deactivated=${deactivated} reactivated=${reactivated} provisioned=${provisioned} ` +
    `rolesUpdated=${rolesUpdated} namesUpdated=${namesUpdated}`,
  );
  return {
    checked: chatUsers.length,
    deactivated,
    reactivated,
    provisioned,
    rolesUpdated,
    namesUpdated,
    source,
  };
}
