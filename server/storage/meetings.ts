import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { generateMeetingCode } from "../meetings/codes";
import {
  meetings,
  meetingParticipants,
  meetingSummaryRecipients,
  directCalls,
  scheduledCalls,
  livekitRooms,
  recordings,
  meetingNotes,
  users,
} from "@shared/schema";
import type {
  Meeting,
  MeetingKind,
  MeetingStatus,
  MeetingParticipant,
  MeetingParticipantRole,
  SummaryRecipientPolicy,
} from "@shared/schema";

export interface CreateMeetingInput {
  orgId: number;
  kind: MeetingKind;
  title?: string | null;
  hostUserId?: number | null;
  channelId?: number | null;
  allowGuests?: boolean;
  waitingRoom?: boolean;
  recordingEnabled?: boolean;
  transcriptEnabled?: boolean;
  summaryEnabled?: boolean;
  summaryRecipientPolicy?: SummaryRecipientPolicy;
  maxDurationMinutes?: number;
  scheduledStartAt?: Date | null;
  startedAt?: Date | null;
  status?: MeetingStatus;
  // When linking an existing legacy call/room, pass its already-allocated
  // LiveKit room name so the meeting points at the SAME room rather than a
  // fresh `bdc-<code>` one. Omit for brand-new meetings.
  livekitRoomName?: string;
}

/**
 * Create a meeting with a unique code. The LiveKit room name is derived as
 * `bdc-<code>` so it's stable and human-traceable. We retry up to 5 times on a
 * code/room-name collision (UNIQUE constraint) before giving up — at ~8e14
 * combinations a collision is astronomically unlikely, but the retry keeps the
 * create idempotent under the vanishingly rare clash.
 */
export function createMeeting(input: CreateMeetingInput): Meeting {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateMeetingCode();
    const id = nanoid();
    const now = new Date();
    try {
      const row = db
        .insert(meetings)
        .values({
          id,
          code,
          orgId: input.orgId,
          kind: input.kind,
          title: input.title ?? null,
          hostUserId: input.hostUserId ?? null,
          channelId: input.channelId ?? null,
          livekitRoomName: input.livekitRoomName ?? `bdc-${code}`,
          status: input.status ?? "scheduled",
          allowGuests: input.allowGuests ?? false,
          waitingRoom: input.waitingRoom ?? false,
          recordingEnabled: input.recordingEnabled ?? false,
          transcriptEnabled: input.transcriptEnabled ?? false,
          summaryEnabled: input.summaryEnabled ?? false,
          summaryRecipientPolicy: input.summaryRecipientPolicy ?? "none",
          maxDurationMinutes: input.maxDurationMinutes ?? 240,
          scheduledStartAt: input.scheduledStartAt ?? null,
          startedAt: input.startedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      return row;
    } catch (e) {
      lastErr = e;
      // UNIQUE collision on code or livekit_room_name — try a fresh code.
      const msg = (e as { message?: string })?.message ?? "";
      if (!msg.includes("UNIQUE")) throw e;
    }
  }
  throw new Error(
    `createMeeting: failed to mint a unique code after 5 attempts: ${(lastErr as { message?: string })?.message ?? lastErr}`,
  );
}

export function getMeetingByCode(code: string): Meeting | undefined {
  return db.select().from(meetings).where(eq(meetings.code, code)).get();
}

export function getMeetingById(id: string): Meeting | undefined {
  return db.select().from(meetings).where(eq(meetings.id, id)).get();
}

export function setMeetingStatus(
  id: string,
  status: MeetingStatus,
  opts?: { startedAt?: Date; endedAt?: Date },
): void {
  const patch: Partial<typeof meetings.$inferInsert> = {
    status,
    updatedAt: new Date(),
  };
  if (opts?.startedAt) patch.startedAt = opts.startedAt;
  if (opts?.endedAt) patch.endedAt = opts.endedAt;
  db.update(meetings).set(patch).where(eq(meetings.id, id)).run();
}

export type MeetingPatch = Partial<
  Pick<
    typeof meetings.$inferInsert,
    | "title"
    | "allowGuests"
    | "waitingRoom"
    | "recordingEnabled"
    | "transcriptEnabled"
    | "summaryEnabled"
    | "summaryRecipientPolicy"
    | "maxDurationMinutes"
  >
>;

export function updateMeetingFields(id: string, patch: MeetingPatch): void {
  db.update(meetings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(meetings.id, id))
    .run();
}

export interface CreateParticipantInput {
  meetingId: string;
  participantIdentity: string;
  displayName: string;
  userId?: number | null;
  role?: MeetingParticipantRole;
  origin?: string | null;
}

export function createParticipant(input: CreateParticipantInput): MeetingParticipant {
  return db
    .insert(meetingParticipants)
    .values({
      meetingId: input.meetingId,
      participantIdentity: input.participantIdentity,
      displayName: input.displayName,
      userId: input.userId ?? null,
      role: input.role ?? "participant",
      origin: input.origin ?? null,
      joinedAt: new Date(),
    })
    .returning()
    .get();
}

/**
 * Mark the most recent still-present participant row for this identity as left.
 * A participant may rejoin (creating a new row); we only close the open one.
 */
export function markParticipantLeft(meetingId: string, participantIdentity: string): void {
  const open = db
    .select()
    .from(meetingParticipants)
    .where(
      and(
        eq(meetingParticipants.meetingId, meetingId),
        eq(meetingParticipants.participantIdentity, participantIdentity),
        isNull(meetingParticipants.leftAt),
      ),
    )
    .get();
  if (!open) return;
  db.update(meetingParticipants)
    .set({ leftAt: new Date() })
    .where(eq(meetingParticipants.id, open.id))
    .run();
}

export function listParticipants(meetingId: string): MeetingParticipant[] {
  return db
    .select()
    .from(meetingParticipants)
    .where(eq(meetingParticipants.meetingId, meetingId))
    .all();
}

export interface ResolvedRecipient {
  userId: number | null;
  email: string | null;
  name: string | null;
}

/**
 * Resolve the concrete set of summary recipients (email + optional userId) for
 * a meeting, honoring its summaryRecipientPolicy and merging any explicit
 * hand-added rows from meeting_summary_recipients. De-duplicates by email.
 */
export function resolveSummaryRecipients(meetingId: string): ResolvedRecipient[] {
  const meeting = getMeetingById(meetingId);
  if (!meeting) return [];

  const byEmail = new Map<string, ResolvedRecipient>();
  const add = (r: ResolvedRecipient) => {
    const key = (r.email ?? `user:${r.userId}`).toLowerCase();
    if (!key) return;
    if (!byEmail.has(key)) byEmail.set(key, r);
  };

  const addUserId = (uid: number) => {
    const u = db.select().from(users).where(eq(users.id, uid)).get();
    if (u?.email) add({ userId: u.id, email: u.email, name: u.name });
  };

  switch (meeting.summaryRecipientPolicy) {
    case "none":
      break;
    case "channel_members":
      if (meeting.channelId != null) {
        for (const uid of storage.listChannelMemberIds(meeting.channelId)) addUserId(uid);
      }
      break;
    case "all_attendees":
      for (const p of listParticipants(meetingId)) {
        if (p.userId != null) addUserId(p.userId);
      }
      break;
    case "explicit":
      // handled entirely by the explicit rows merged below
      break;
  }

  // Always merge the explicit hand-added rows (works for every policy, and is
  // the sole source for the 'explicit' policy).
  const explicit = db
    .select()
    .from(meetingSummaryRecipients)
    .where(eq(meetingSummaryRecipients.meetingId, meetingId))
    .all();
  for (const r of explicit) {
    if (r.userId != null) addUserId(r.userId);
    else if (r.email) add({ userId: null, email: r.email, name: null });
  }

  return Array.from(byEmail.values());
}

export function addSummaryRecipient(input: {
  meetingId: string;
  userId?: number | null;
  email?: string | null;
  addedByUserId?: number | null;
}): void {
  db.insert(meetingSummaryRecipients)
    .values({
      meetingId: input.meetingId,
      userId: input.userId ?? null,
      email: input.email ?? null,
      addedByUserId: input.addedByUserId ?? null,
      addedAt: new Date(),
    })
    .run();
}

type LinkableTable = "direct_calls" | "scheduled_calls" | "livekit_rooms" | "recordings" | "meeting_notes";

/**
 * Point an existing legacy call/room/notes row at a meeting. Used when an
 * already-created direct/scheduled/channel call is upgraded into the unified
 * model. Drizzle update by numeric/text id.
 */
export function linkExistingCallToMeeting(
  table: LinkableTable,
  rowId: number,
  meetingId: string,
): void {
  switch (table) {
    case "direct_calls":
      db.update(directCalls).set({ meetingId }).where(eq(directCalls.id, rowId)).run();
      break;
    case "scheduled_calls":
      db.update(scheduledCalls).set({ meetingId }).where(eq(scheduledCalls.id, rowId)).run();
      break;
    case "livekit_rooms":
      db.update(livekitRooms).set({ meetingId }).where(eq(livekitRooms.id, rowId)).run();
      break;
    case "recordings":
      db.update(recordings).set({ meetingId }).where(eq(recordings.id, rowId)).run();
      break;
    case "meeting_notes":
      db.update(meetingNotes).set({ meetingId }).where(eq(meetingNotes.id, rowId)).run();
      break;
  }
}
