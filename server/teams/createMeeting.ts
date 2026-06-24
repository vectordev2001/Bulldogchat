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
  const body = {
    subject: input.subject,
    startDateTime: input.startUtc.toISOString(),
    endDateTime: input.endUtc.toISOString(),
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
    console.log(
      `[teams] created online meeting id=${meetingId} for organizer.${organizer.kind}=${organizer.value}`,
    );
    return { joinUrl, meetingId };
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
