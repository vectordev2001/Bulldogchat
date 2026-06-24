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
   *  MS_GRAPH_DEFAULT_ORGANIZER env var, falling back to admin@bulldogops.com. */
  organizerEmail?: string;
}

export interface TeamsMeeting {
  joinUrl: string;
  meetingId: string;
}

function defaultOrganizer(): string {
  return process.env.MS_GRAPH_DEFAULT_ORGANIZER?.trim() || "admin@bulldogops.com";
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

  const organizerEmail = input.organizerEmail?.trim() || defaultOrganizer();
  const body = {
    subject: input.subject,
    startDateTime: input.startUtc.toISOString(),
    endDateTime: input.endUtc.toISOString(),
  };

  try {
    const res = await client
      .api(`/users/${encodeURIComponent(organizerEmail)}/onlineMeetings`)
      .post(body);
    const joinUrl: string | undefined = res?.joinWebUrl ?? res?.joinUrl;
    const meetingId: string | undefined = res?.id;
    if (!joinUrl || !meetingId) {
      console.warn("[teams] createTeamsMeeting: Graph response missing joinWebUrl/id");
      return null;
    }
    console.log(`[teams] created online meeting id=${meetingId} for organizer=${organizerEmail}`);
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
    if (Object.keys(detail).length === 0) {
      // Fall back to a stringified dump if none of the well-known fields hit.
      try { detail.raw = String(err).slice(0, 500); } catch { /* ignore */ }
    }
    console.warn("[teams] createTeamsMeeting failed:", JSON.stringify(detail));
    return null;
  }
}
