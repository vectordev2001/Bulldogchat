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
    console.warn(
      "[teams] createTeamsMeeting failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
