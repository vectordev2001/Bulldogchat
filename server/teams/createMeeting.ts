/**
 * createMeeting.ts — create a Microsoft Teams online meeting via MS Graph
 * (Phase 2.1).
 *
 * Called at schedule time so attendees can receive a Teams join link
 * alongside the Bulldog link. Best-effort: any failure (no credentials, Graph
 * error, network) returns null and the caller continues with the Bulldog-only
 * flow — scheduling must never fail because Teams is unavailable.
 */
import { getGraphClient } from "./graphClient";

export interface CreateTeamsMeetingInput {
  subject: string;
  startUtc: Date;
  endUtc: Date;
  /** Organizer mailbox the meeting is created under. Defaults to the
   *  MS_GRAPH_DEFAULT_ORGANIZER env var, falling back to admin@bulldogops.com.
   *  Ignored when MS_GRAPH_DEFAULT_ORGANIZER_ID (a Graph object-id GUID) is set. */
  organizerEmail?: string;
  /** Organizer Graph object-id (GUID). When set, used in the /users/{id}
   *  path instead of the email. The GUID path bypasses UPN resolution, which
   *  can flap on freshly-licensed mailboxes. Defaults to
   *  MS_GRAPH_DEFAULT_ORGANIZER_ID env var. */
  organizerId?: string;
}

export interface TeamsMeeting {
  joinUrl: string;
  meetingId: string;
  /**
   * The lobby bypass scope Graph reported back after creation (post-verify).
   * We always request "everyone", but tenant meeting policy can override it —
   * in which case guests will land in the Teams lobby waiting to be admitted.
   * When this differs from "everyone" a warning is logged; the field is
   * surfaced so the caller (and eventually the UI) can render an in-app hint
   * that the tenant policy is overriding the meeting setting.
   */
  lobbyBypassScope: string | null;
}

/**
 * Resolves the organizer path segment for `/users/{id}/onlineMeetings`.
 * Prefers a Graph object-id (GUID) when available — either passed explicitly
 * on the input, or via MS_GRAPH_DEFAULT_ORGANIZER_ID. Falls back to the
 * email (UPN) path, which is what the codebase has historically used.
 *
 * Returns the resolved value plus a label for logging.
 */
function resolveOrganizer(input: CreateTeamsMeetingInput): { value: string; kind: "id" | "email" } {
  const idOverride = input.organizerId?.trim();
  const idEnv = process.env.MS_GRAPH_DEFAULT_ORGANIZER_ID?.trim();
  const id = idOverride || idEnv;
  if (id) return { value: id, kind: "id" };

  const emailOverride = input.organizerEmail?.trim();
  const emailEnv = process.env.MS_GRAPH_DEFAULT_ORGANIZER?.trim();
  const email = emailOverride || emailEnv || "admin@bulldogops.com";
  return { value: email, kind: "email" };
}

/**
 * Creates a Teams online meeting and returns its join URL + Graph meeting id,
 * or null if the Graph client is unavailable or the call fails. Never throws.
 */
export async function createTeamsMeeting(
  input: CreateTeamsMeetingInput,
): Promise<TeamsMeeting | null> {
  const client = await getGraphClient();
  if (!client) {
    console.warn("[teams] createTeamsMeeting: Graph client unavailable — skipping Teams meeting");
    return null;
  }

  const organizer = resolveOrganizer(input);
  // Lobby bypass + presenter policy. Everyone gets in with the join link
  // and can share. This avoids the "someone will let you in when the
  // meeting starts" wall for external attendees (e.g. bulldog users
  // signed into Teams under a different tenant) and for the bridge bot.
  // The join URL is only distributed via Bulldog's invite fan-out, which
  // is already gated by channel membership / explicit invitee lists —
  // so "everyone with the link" is scoped to "everyone we invited".
  const body = {
    subject: input.subject,
    startDateTime: input.startUtc.toISOString(),
    endDateTime: input.endUtc.toISOString(),
    lobbyBypassSettings: {
      scope: "everyone",
      isDialInBypassEnabled: true,
    },
    allowedPresenters: "everyone",
  };

  try {
    const res = await client
      .api(`/users/${encodeURIComponent(organizer.value)}/onlineMeetings`)
      .post(body);
    const joinUrl: string | undefined = res?.joinWebUrl ?? res?.joinUrl;
    const meetingId: string | undefined = res?.id;
    if (!joinUrl || !meetingId) {
      console.warn(
        `[teams] createTeamsMeeting: Graph response missing joinWebUrl/id (organizer.${organizer.kind}=${organizer.value})`,
      );
      return null;
    }

    // ─── Verify lobby bypass took effect ────────────────────────────────────
    // Older Graph versions and some tenants silently ignore lobbyBypassSettings
    // on the create call, and tenant Meeting policy can override the per-meeting
    // setting entirely. Re-read the meeting to see what actually stuck, and try
    // one explicit PATCH if the create call didn't honor it. If PATCH also can't
    // land "everyone" (tenant policy override), log loudly — but never fail the
    // meeting creation on this: guests can still be admitted manually from Teams.
    let observedScope: string | null =
      typeof res?.lobbyBypassSettings?.scope === "string"
        ? String(res.lobbyBypassSettings.scope)
        : null;

    if (observedScope !== "everyone") {
      // Attempt one PATCH to force it, then re-read.
      try {
        await client
          .api(`/users/${encodeURIComponent(organizer.value)}/onlineMeetings/${meetingId}`)
          .patch({
            lobbyBypassSettings: {
              scope: "everyone",
              isDialInBypassEnabled: true,
            },
          });
        const verify = await client
          .api(`/users/${encodeURIComponent(organizer.value)}/onlineMeetings/${meetingId}`)
          .select("id,lobbyBypassSettings")
          .get();
        observedScope =
          typeof verify?.lobbyBypassSettings?.scope === "string"
            ? String(verify.lobbyBypassSettings.scope)
            : null;
      } catch (patchErr) {
        console.warn(
          `[teams] lobbyBypass PATCH failed for meeting ${meetingId}: ${
            (patchErr as Error)?.message ?? String(patchErr)
          }`,
        );
      }
    }

    if (observedScope !== "everyone") {
      // Tenant Meeting policy is overriding the per-meeting setting. Guests
      // will land in the Teams lobby. Log the exact resolved scope so the
      // next lobby incident is one-glance debuggable, and include a fix hint.
      console.warn(
        `[teams] TENANT POLICY OVERRIDE: meeting ${meetingId} has lobbyBypassSettings.scope="${observedScope}" ` +
          `(requested "everyone"). Guests will wait in the Teams lobby. ` +
          `Fix: Teams Admin Center → Meetings → Meeting policies → "Who can bypass the lobby" = Everyone ` +
          `for the organizer's assigned policy.`,
      );
    } else {
      console.log(
        `[teams] created online meeting id=${meetingId} for organizer.${organizer.kind}=${organizer.value} lobbyBypass=everyone allowedPresenters=everyone (verified)`,
      );
    }

    return { joinUrl, meetingId, lobbyBypassScope: observedScope };
  } catch (err) {
    // The Microsoft Graph SDK wraps errors in shapes where `.message` is
    // often empty; the diagnostic detail lives in `.statusCode`, `.code`,
    // `.body`, or in a nested `.response`. Dump the most informative fields
    // we can find so the failure is debuggable from Render logs.
    const e: any = err;
    const detail: Record<string, unknown> = {};
    if (e?.message) detail.message = String(e.message);
    if (e?.code) detail.code = String(e.code);
    if (e?.statusCode != null) detail.statusCode = e.statusCode;
    if (e?.status != null) detail.status = e.status;
    if (e?.body) {
      try {
        detail.body = typeof e.body === "string" ? e.body.slice(0, 500) : JSON.stringify(e.body).slice(0, 500);
      } catch { /* ignore */ }
    }
    if (e?.response?.data) {
      try {
        detail.response = JSON.stringify(e.response.data).slice(0, 500);
      } catch { /* ignore */ }
    }
    if (e?.requestId) detail.requestId = String(e.requestId);
    // Always include the resolved organizer so the next 404/403 is one-glance
    // debuggable — we can immediately tell which mailbox/GUID Graph rejected.
    detail.organizer = { kind: organizer.kind, value: organizer.value };
    if (Object.keys(detail).length === 0) {
      // Fall back to a stringified dump if none of the well-known fields hit.
      try { detail.raw = String(err).slice(0, 500); } catch { /* ignore */ }
    }
    console.warn("[teams] createTeamsMeeting failed:", JSON.stringify(detail));
    return null;
  }
}
