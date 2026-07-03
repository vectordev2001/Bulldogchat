/**
 * Teams Host View — Lobby Control Routes (Phase 1.9.5)
 *
 * Exposes two endpoints used by LobbyControlPanel.tsx:
 *
 *   POST /api/teams/lobby/acs-token
 *     Exchanges the host's Entra Teams AAD token for an ACS access token.
 *     Auth: requireAuth (existing session cookie).
 *     Body: { teamsAadToken: string }
 *     Returns: { token: string, expiresOn: string }
 *
 *   GET /api/teams/lobby/known-emails?meetingId=<id>
 *     Returns the auto-admit allow-list for a given scheduled call:
 *       - All @bulldogops.com addresses
 *       - linkedContract.customerContactEmails[] from the meeting metadata
 *     Auth: requireAuth
 *     Returns: { emails: string[] }
 *
 * If ACS_CONNECTION_STRING or ACS_ENTRA_CLIENT_ID are not configured the
 * POST endpoint returns 501 with a descriptive message so the code can be
 * deployed before Josh completes the Azure setup (see TEAMS_HOST_VIEW_SETUP.md).
 *
 * Design doc: teams-host-view-design.md
 */

import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "./auth";
import { rawDb } from "./db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull a scheduled_call row by id, returning raw or null. */
function getRawScheduledCall(id: number): Record<string, unknown> | null {
  const row = rawDb
    .prepare("SELECT * FROM scheduled_calls WHERE id = ?")
    .get(id);
  return (row as Record<string, unknown> | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTeamsLobbyRoutes(app: Express): void {
  // ─── GET /api/teams/lobby/status ─────────────────────────────────────────
  //
  // Cheap probe the client uses to decide whether the ACS-backed lobby control
  // panel is available at all. When ACS_CONNECTION_STRING / ACS_ENTRA_CLIENT_ID
  // are unset the /acs-token endpoint returns 501 — the panel would 501 on
  // click. We surface this ahead of time so the UI can render an alternative
  // "admit in Teams" affordance instead of a broken button.
  //
  // The user must be authed (same posture as the rest of the lobby endpoints)
  // to avoid leaking configuration state to anonymous callers.
  app.get(
    "/api/teams/lobby/status",
    requireAuth,
    (_req, res) => {
      const acsConfigured =
        !!process.env.ACS_CONNECTION_STRING && !!process.env.ACS_ENTRA_CLIENT_ID;
      return res.json({ acsConfigured });
    },
  );

  // ─── POST /api/teams/lobby/acs-token ─────────────────────────────────────
  //
  // Exchange the host's Entra AAD token for an ACS token. The browser
  // calls this right before calling new CallClient() so it can use the
  // returned token to join the Teams meeting via the ACS Calling SDK.
  //
  // Returns 501 when ACS env vars aren't configured yet so the rest of
  // the codebase can be deployed independently of the Azure provisioning.
  app.post(
    "/api/teams/lobby/acs-token",
    requireAuth,
    async (req, res) => {
      const user = (req as unknown as AuthedRequest).user;

      // Guard: env vars must be present.
      const connectionString = process.env.ACS_CONNECTION_STRING;
      const entraClientId = process.env.ACS_ENTRA_CLIENT_ID;

      if (!connectionString || !entraClientId) {
        return res.status(501).json({
          message:
            "Teams Host View not configured on this server. " +
            "Please complete the Azure setup described in TEAMS_HOST_VIEW_SETUP.md " +
            "and add ACS_CONNECTION_STRING and ACS_ENTRA_CLIENT_ID to the environment.",
        });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const teamsAadToken =
        typeof body.teamsAadToken === "string" ? body.teamsAadToken.trim() : "";

      if (!teamsAadToken) {
        return res.status(400).json({ message: "teamsAadToken required" });
      }

      // The user's aadObjectId must be present for the ACS identity exchange.
      // It's stored on the user row by the bulldog-sso bridge when Teams/Entra
      // auth is active. If it's missing (local-only account) we reject early.
      const aadObjectId = (user as any).aadObjectId as string | null | undefined;
      if (!aadObjectId) {
        return res.status(400).json({
          message:
            "This account does not have an associated Azure AD identity. " +
            "Sign in via Microsoft (SSO) and try again.",
        });
      }

      try {
        // Dynamic import so the module is only loaded when actually needed
        // (keeps startup time unchanged when ACS is not configured).
        // Load via a variable so tsc skips module resolution for packages
        // that are declared in package.json but not yet installed in node_modules.
        const identityPkg = "@azure/communication-identity" as string;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const { CommunicationIdentityClient } = await import(identityPkg) as any;

        const identityClient = new CommunicationIdentityClient(connectionString);

        const { token, expiresOn } =
          await identityClient.getTokenForTeamsUser({
            teamsUserAadToken: teamsAadToken,
            clientId: entraClientId,
            userObjectId: aadObjectId,
          });

        return res.json({ token, expiresOn: expiresOn.toISOString() });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown ACS error";
        console.error("[teams-lobby] acs-token error:", message);
        return res.status(500).json({
          message: `ACS token exchange failed: ${message}`,
        });
      }
    },
  );

  // ─── GET /api/teams/lobby/known-emails ───────────────────────────────────
  //
  // Returns the set of email addresses that should be auto-admitted to the
  // lobby without the host needing to click Admit. Sprint 1 rules:
  //
  //   1. Any address in the @bulldogops.com tenant.
  //   2. Any address listed in the meeting's linkedContract.customerContactEmails[].
  //
  // The client calls this once when the panel opens, caches the list, and
  // uses it to match incoming lobbyParticipantsUpdated events.
  app.get(
    "/api/teams/lobby/known-emails",
    requireAuth,
    (req, res) => {
      const meetingIdRaw = req.query.meetingId;
      const meetingId =
        typeof meetingIdRaw === "string"
          ? parseInt(meetingIdRaw, 10)
          : NaN;

      if (isNaN(meetingId) || meetingId <= 0) {
        return res.status(400).json({ message: "meetingId required" });
      }

      const emails = new Set<string>();

      // Rule 1 — bulldogops.com tenant: fetch all user rows with that domain.
      try {
        const rows = rawDb
          .prepare(
            "SELECT email FROM users WHERE email LIKE ? AND deactivated IS NOT 1",
          )
          .all("%@bulldogops.com") as Array<{ email: string }>;
        for (const row of rows) {
          if (row.email) emails.add(row.email.toLowerCase());
        }
      } catch (err) {
        // Non-fatal — we still return contract emails.
        console.warn("[teams-lobby] known-emails tenant query failed:", err);
      }

      // Rule 2 — linkedContract.customerContactEmails on the scheduled call.
      try {
        const callRow = getRawScheduledCall(meetingId);
        if (callRow) {
          // The linked_contract column may contain customerContactEmails as
          // a Sprint-1 extension. It's typed as unknown JSON, so we parse
          // defensively without modifying the existing LinkedContractMeta type.
          let lc: unknown = null;
          try {
            const raw = callRow.linked_contract as string | null | undefined;
            if (raw) lc = JSON.parse(raw);
          } catch {
            /* malformed JSON — skip */
          }
          if (
            lc !== null &&
            typeof lc === "object" &&
            "customerContactEmails" in (lc as object)
          ) {
            const ccEmails = (lc as Record<string, unknown>)
              .customerContactEmails;
            if (Array.isArray(ccEmails)) {
              for (const e of ccEmails) {
                if (typeof e === "string" && e.includes("@")) {
                  emails.add(e.trim().toLowerCase());
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn("[teams-lobby] known-emails contract query failed:", err);
      }

      return res.json({ emails: Array.from(emails) });
    },
  );
}
