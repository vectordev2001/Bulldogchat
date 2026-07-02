/**
 * MSAL (Microsoft Authentication Library) configuration for Bulldog Chat.
 *
 * Used by LobbyControlPanel to obtain an Entra token that can be exchanged
 * for an ACS access token via POST /api/teams/lobby/acs-token.
 *
 * The client ID and tenant come from Vite env vars — both are build-time
 * values injected by the Render CI environment:
 *   VITE_MSAL_CLIENT_ID   — Entra App Registration client ID
 *   VITE_MSAL_TENANT_ID   — bulldogops.com tenant ID (or "common" for multi-tenant)
 *
 * Phase 1.9.5 (Teams Host View Sprint 1): ACS calling scopes appended below.
 * The host will see a one-time consent prompt when they first open the lobby
 * control panel. After Josh grants admin consent in the Entra portal, the
 * prompt disappears for all users in the tenant.
 *
 * See TEAMS_HOST_VIEW_SETUP.md for the full Azure prerequisites.
 */

export const msalConfig = {
  auth: {
    clientId: (import.meta.env.VITE_MSAL_CLIENT_ID as string | undefined) ?? "",
    authority: `https://login.microsoftonline.com/${
      (import.meta.env.VITE_MSAL_TENANT_ID as string | undefined) ?? "common"
    }`,
    redirectUri: typeof window !== "undefined" ? window.location.origin : "/",
  },
  cache: {
    cacheLocation: "sessionStorage" as const,
    storeAuthStateInCookie: false,
  },
};

/**
 * Scopes requested during interactive login.
 *
 * Base scopes come first (openid / profile / offline_access are implied by
 * the MSAL PublicClientApplication defaults but we list them explicitly for
 * clarity). The two ACS calling scopes are appended here as part of the
 * Phase 1.9.5 (Teams Host View Sprint 1) feature.
 *
 * DO NOT remove or reorder existing scopes — this is an append-only list.
 */
export const loginRequest = {
  scopes: [
    "openid",
    "profile",
    "offline_access",
    // ── Phase 1.9.5 append: ACS Teams calling scopes ──────────────────────
    // Required so the resulting Entra token can be exchanged by the Bulldog
    // backend (CommunicationIdentityClient.getTokenForTeamsUser) for an ACS
    // access token that grants lobby admit/reject rights.
    "https://auth.msft.communication.azure.com/Teams.ManageCalls",
    "https://auth.msft.communication.azure.com/Teams.ManageChats",
  ],
};
