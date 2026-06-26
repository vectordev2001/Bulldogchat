/**
 * Bulldog SSO bridge for vector-chat.
 *
 * When the user lands here without a `vc_token` cookie but has a valid
 * `bulldog_access` JWT cookie from auth.bulldogops.com, this middleware:
 *   1. Verifies the bulldog JWT against the public key.
 *   2. Resolves the matching local user by email.
 *   3. Issues a fresh vc_token cookie so the rest of the app works
 *      unchanged.
 *
 * Mount BEFORE any requireAuth-guarded route. Cheap — exits early if a
 * vc_token cookie is already set.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { bulldogAuth } from "./bulldog-sdk";
import { storage } from "./storage";
import { AUTH_COOKIE, signJwt, setAuthCookie, verifyJwt } from "./auth";
import { mirrorUserGrants } from "./multitenant-access";

const AUTH_BASE = process.env.BULLDOG_AUTH_URL || "https://auth.bulldogops.com";

// Phase 2.0: auth is the source of truth for roles. Collapse onto chat's
// user/manager/admin enum — super_admin maps to admin, manager stays manager,
// everything else (legacy or unset) is a plain user.
function mapSsoRoleToChatRole(authRole: string | null | undefined): "admin" | "manager" | "user" {
  const r = (authRole || "").toLowerCase();
  if (r === "admin" || r === "super_admin") return "admin";
  if (r === "manager") return "manager";
  return "user";
}

const optionalVerifier: RequestHandler = bulldogAuth({
  authBaseUrl: AUTH_BASE,
  optional: true,
});

function extractBearerOrCookie(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
    if (m) return decodeURIComponent(m[1]);
  }
  if (typeof req.query.token === "string" && req.query.token) return req.query.token;
  return null;
}

function hasValidChatToken(req: Request): boolean {
  const t = extractBearerOrCookie(req);
  if (!t) return false;
  // A token is "chat" only if our HS256 verifier accepts it. Bulldog-auth
  // tokens are RS256 and will fail here — falling through to the SSO bridge.
  return verifyJwt(t) !== null;
}

export function bulldogSsoBridge(): RequestHandler {
  return async function (req: Request, res: Response, next: NextFunction) {
    // We used to short-circuit when a valid chat token was already present,
    // but that meant fields like `phone` (added in auth after first chat
    // login) never re-synced — the bridge only ran on the first SSO landing.
    // Now we always run the optional verifier: if a bulldog-auth cookie is
    // present we re-sync name/phone idempotently; if not, we fall through.
    // The chat-token check is still used at the bottom to decide whether to
    // (re)issue a vc_token cookie.
    const hasChatToken = hasValidChatToken(req);

    optionalVerifier(req, res, async (err?: unknown) => {
      if (err) return next();
      try {
        if (!req.user?.email) return next();
        const emailLower = req.user.email.toLowerCase();
        let local = storage.getUserByEmail(emailLower);
        if (!local) {
          // First-time SSO landing — provision a local shadow user so the rest
          // of chat (messages, project_members, etc.) has someone to attach to.
          try {
            // Phase 2.0: collapse auth roles onto chat's user/manager/admin.
            const chatRole = mapSsoRoleToChatRole(req.user.role);
            local = storage.createUser({
              orgId: 1, // single-org install
              email: emailLower,
              passwordHash: "", // SSO-only; local password login disabled for this row
              name: req.user.name || emailLower,
              role: chatRole,
            });
            // Auto-add new SSO users to every project in their org so they
            // can immediately see global channels. Without this, brand-new
            // users see an empty sidebar.
            //
            // SKIPPED in multi-tenant mode — mirrorUserGrants (below)
            // populates project_members for the specific projects the
            // user is granted via auth, never the rest.
            if (process.env.MULTITENANT_MODE !== "1") {
              try {
                const orgProjects = storage.listProjectsByOrg(local.orgId);
                for (const p of orgProjects) {
                  try { storage.addProjectMember(p.id, local.id, "member"); }
                  catch { /* duplicate is fine */ }
                }
              } catch (e) {
                console.warn("[chat bulldogSsoBridge] failed to seed project membership:", e);
              }
            }
          } catch (e) {
            console.error("[chat bulldogSsoBridge] provision failed:", e);
            return next();
          }
        }
        if (!local) return next();
        // Keep the chat row's display name in sync with bulldog-auth.
        // Without this, seed users keep whatever name the demo seed gave
        // them even after an admin renames them in auth. Run on every
        // bridge so renames propagate quickly; updateUser is a no-op when
        // the value hasn't changed at the DB level for our purposes.
        const authName = (req.user.name || "").trim();
        if (authName) {
          // Phase 1.9.1: dropped the "Bulldog - " prefix — we now strip it
          // on sync so any legacy auth-side name that still has it lands
          // clean here. Bulldog branding only shows on outbound phone
          // calls (SIP From display), not on in-app user labels.
          const clean = authName.startsWith("Bulldog - ") ? authName.slice("Bulldog - ".length) : authName;
          if (clean !== local.name) {
            try { storage.updateUser(local.id, { name: clean }); }
            catch (e) { console.warn("[chat bulldogSsoBridge] name sync failed:", e); }
          }
        }
        // Phone sync: bulldog-auth is the source of truth. Mirror into the
        // chat user row so the invite endpoint can dial-out without a
        // round-trip back to auth on every invite. Null/empty phones are
        // preserved so we don't accidentally clear a number that was set
        // out-of-band.
        const authPhone = ((req.user as { phone?: string | null }).phone ?? "").trim() || null;
        if (authPhone !== ((local as { phone?: string | null }).phone ?? null)) {
          try { storage.updateUser(local.id, { phone: authPhone }); }
          catch (e) { console.warn("[chat bulldogSsoBridge] phone sync failed:", e); }
        }
        // Phase 4 — mirror canonical profile photo from bulldog-auth. Auth
        // is the single source of truth; chat just stores the URL so the
        // sidebar / avatar components can render without an extra round
        // trip. Empty string from auth clears the local URL.
        const authAvatar = ((req.user as { avatarUrl?: string | null }).avatarUrl ?? "").trim();
        // Resolve to absolute URL if auth gave us a relative /avatars/... path
        // so chat clients on a different origin can load it without CORS
        // surprises. AUTH_BASE already points at https://auth.bulldogops.com
        // (or the configured base).
        const resolvedAvatar = authAvatar.startsWith("/") ? `${AUTH_BASE}${authAvatar}` : (authAvatar || null);
        if ((resolvedAvatar ?? null) !== ((local as { avatarUrl?: string | null }).avatarUrl ?? null)) {
          try { storage.updateUser(local.id, { avatarUrl: resolvedAvatar }); }
          catch (e) { console.warn("[chat bulldogSsoBridge] avatar sync failed:", e); }
        }
        // Phase 4 — mirror Job Title (auth stores it as `department`, chat
        // stores it as `title`). Trim/normalize the same way as name above.
        const authTitle = ((req.user as { department?: string | null }).department ?? "").trim() || null;
        if (authTitle !== ((local as { title?: string | null }).title ?? null)) {
          try { storage.updateUser(local.id, { title: authTitle }); }
          catch (e) { console.warn("[chat bulldogSsoBridge] title sync failed:", e); }
        }
        // Phase 2.0 role sync: auth owns role. Promote/demote the chat row on
        // every bridge so manager/admin grants made in auth take effect on the
        // user's next page load rather than waiting for an admin sync sweep.
        const syncedRole = mapSsoRoleToChatRole(req.user.role);
        if (syncedRole !== local.role) {
          try { storage.updateUser(local.id, { role: syncedRole }); }
          catch (e) { console.warn("[chat bulldogSsoBridge] role sync failed:", e); }
        }
        // Multi-tenant Option A: mirror auth grants[] into chat's
        // user_project_regions on every bridge so revocations land
        // immediately on the next page load. Gated by MULTITENANT_MODE so
        // pre-rollout deploys keep their single-tenant behavior.
        if (process.env.MULTITENANT_MODE === "1") {
          try {
            const grants = ((req.user as { grants?: Array<{ companyId: string; locationId: string | null }> }).grants) ?? [];
            mirrorUserGrants(local.id, grants);
          } catch (e) {
            console.warn("[chat bulldogSsoBridge] grants mirror failed:", e);
          }
        }
        // Backfill: if an existing local user is in zero projects, seed them
        // into every org project. Cheap idempotent guard for users created
        // before the auto-seed code above shipped.
        //
        // SKIPPED in multi-tenant mode — mirrorUserGrants above already
        // populates project_members for legitimately-granted projects, and
        // blanket-membership here would over-grant cross-tenant access.
        if (process.env.MULTITENANT_MODE !== "1") {
          try {
            const memberOf = storage.listProjectsForUser(local.id);
            if (memberOf.length === 0) {
              const orgProjects = storage.listProjectsByOrg(local.orgId);
              for (const p of orgProjects) {
                try { storage.addProjectMember(p.id, local.id, "member"); }
                catch { /* duplicate is fine */ }
              }
            }
          } catch (e) {
            console.warn("[chat bulldogSsoBridge] backfill membership failed:", e);
          }
        }
        // Only mint a new chat JWT when one isn't already present. When the
        // caller already has a valid chat token we just ran the sync above
        // and let the existing token flow through unchanged.
        if (!hasChatToken) {
          const token = signJwt(local.id);
          setAuthCookie(res, token);
          // Make the token available to the current request too.
          req.headers.authorization = `Bearer ${token}`;
          // Clear req.user set by optionalVerifier so requireAuth re-reads from
          // the chat token (which carries the local numeric id).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (req as any).user;
        } else {
          // Chat token already present — don't let optionalVerifier's req.user
          // (which has the auth-side string sub) shadow what requireAuth will
          // resolve from the chat JWT.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          delete (req as any).user;
        }
        next();
      } catch (e) {
        console.error("[chat bulldogSsoBridge] error:", e);
        next();
      }
    });
  };
}

export const BULLDOG_AUTH_URL = AUTH_BASE;
