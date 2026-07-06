/**
 * Scheduled calls (Phase 1.9.1).
 *
 * A scheduled_call is a future Bulldog call (voice/video) with a set of
 * invitees. We:
 *   1. Persist the meeting + invitees (with a per-invitee RSVP code)
 *   2. Fan out invites: in-app system message in the channel, SMS to anyone
 *      with a phone, .ics email attachment (TODO when email is wired)
 *   3. Accept RSVPs from in-app buttons, the SMS Y/N reply webhook, or a
 *      web RSVP page (future)
 *   4. Fire a reminder SMS ~5 min before start
 *   5. At start time, transition status -> 'started' so the in-channel card
 *      shows a live "Join now" CTA. Room name is pre-allocated so the join
 *      link is stable from the moment the meeting is created.
 *
 * The dispatch + reminder loop is intentionally in-process (setInterval) for
 * simplicity. When we move to multi-instance hosting we'll switch to a
 * proper job queue, but that's not needed for our single-Render-service
 * deployment today.
 */
import type { Request, Response, Express } from "express";
import { db, rawDb } from "./db";
import { storage } from "./storage";
import { signCallJoinToken, sendSms, buildScheduledCallSmsBody, buildReminderSmsBody, generateRsvpCode, buildIcsForScheduledCall, parseRsvpSms, smsAvailable, verifyTwilioSignature } from "./sms";
import { mintShortLink, resolveShortLink } from "./short-links";
import { createMeeting as createMeetingRow, linkExistingCallToMeeting } from "./storage/meetings";
import { checkSmsConsent } from "./auth-consent";
import { emitMessageNew, emitMessageDelete } from "./events";
import { requireAuth, type AuthedRequest } from "./auth";
import { canSeeChannel as mtCanSeeChannel } from "./multitenant-access";
import { sendEmail, isEmailConfigured, emailFromAddress, emailFromName } from "./email";
import { sendNotificationToUsers } from "./push";
import { createTeamsMeeting } from "./teams/createMeeting";
import { emitOpsNotifications } from "./notify-ops";
import type { ScheduledCall, ScheduledCallInvitee, ScheduledCallSystemMessageMeta, RsvpResponse } from "@shared/schema";
import {
  getMeetingById,
  setMeetingTeamsLink,
  setMeetingBridge,
} from "./storage/meetings";
import { bridgeAvailable, dispatchBridge } from "./bridge/client";
import { mintLivekitBotToken } from "./livekit";

const CHAT_BASE_URL = process.env.CHAT_BASE_URL || "https://chat.bulldogops.com";

/* ─────────────── E.164 normalization (mirrors sip.ts) ──────────────────── */
function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (String(raw).trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/* ─────────────────────────── Storage ──────────────────────────────────── */
interface CreateInput {
  orgId: number;
  channelId: number | null;
  organizerId: number;
  title: string;
  notes: string | null;
  kind: "voice" | "video";
  provider?: "bulldog" | "both" | "teams";
  startAt: Date;
  endAt: Date;
  inviteeUserIds: number[];
  externalPhones: string[]; // raw, will be normalized
  externalEmails: string[];
}

function rowToScheduledCall(r: any): ScheduledCall {
  return {
    id: r.id,
    orgId: r.org_id,
    channelId: r.channel_id ?? null,
    organizerId: r.organizer_id,
    title: r.title,
    notes: r.notes ?? null,
    kind: r.kind,
    startAt: new Date(r.start_at * 1000),
    endAt: new Date(r.end_at * 1000),
    roomName: r.room_name,
    status: r.status,
    reminderSentAt: r.reminder_sent_at ? new Date(r.reminder_sent_at * 1000) : null,
    icsSequence: r.ics_sequence,
    teamsJoinUrl: r.teams_join_url ?? null,
    provider: (r.provider as "bulldog" | "both" | "teams") ?? "both",
    teamsMeetingId: r.teams_meeting_id ?? null,
    createdAt: new Date(r.created_at * 1000),
    updatedAt: new Date(r.updated_at * 1000),
  };
}

function rowToInvitee(r: any): ScheduledCallInvitee {
  return {
    id: r.id,
    scheduledCallId: r.scheduled_call_id,
    userId: r.user_id ?? null,
    externalPhone: r.external_phone ?? null,
    externalEmail: r.external_email ?? null,
    rsvpCode: r.rsvp_code,
    response: r.response,
    respondedAt: r.responded_at ? new Date(r.responded_at * 1000) : null,
    responseChannel: r.response_channel ?? null,
    inviteSentAt: r.invite_sent_at ? new Date(r.invite_sent_at * 1000) : null,
    inviteError: r.invite_error ?? null,
    inviteAttempts: r.invite_attempts ?? 0,
    inviteNextRetryAt: r.invite_next_retry_at ?? null,
    reminderSentAt: r.reminder_sent_at ? new Date(r.reminder_sent_at * 1000) : null,
  };
}

function createScheduledCallRow(input: CreateInput): ScheduledCall {
  const now = Math.floor(Date.now() / 1000);
  // We need an id to build the stable room name, but room_name has a NOT
  // NULL constraint. Insert with a placeholder, then update with the final
  // value in the same transaction.
  const tx = rawDb.transaction(() => {
    const ins = rawDb.prepare(`
      INSERT INTO scheduled_calls
        (org_id, channel_id, organizer_id, title, notes, kind, provider, start_at, end_at,
         room_name, status, ics_sequence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)
    `).run(
      input.orgId,
      input.channelId,
      input.organizerId,
      input.title,
      input.notes,
      input.kind,
      input.provider ?? "both",
      Math.floor(input.startAt.getTime() / 1000),
      Math.floor(input.endAt.getTime() / 1000),
      "_pending_", // placeholder
      now, now,
    );
    const id = ins.lastInsertRowid as number;
    const roomName = `sched-${id}-${Date.now()}`;
    rawDb.prepare("UPDATE scheduled_calls SET room_name = ? WHERE id = ?").run(roomName, id);
    return id;
  });
  const id = tx();
  const row = rawDb.prepare("SELECT * FROM scheduled_calls WHERE id = ?").get(id);
  const call = rowToScheduledCall(row);

  // Unified meetings model — mirror the scheduled call into a meeting using the
  // SAME pre-allocated room name, and link the scheduled_calls row. The
  // scheduled_call row keeps owning RSVP/reminder state; the meeting is the
  // durable identity (stable code + room). Best-effort: a failure here must not
  // block scheduling the call.
  try {
    const meeting = createMeetingRow({
      orgId: call.orgId,
      kind: "scheduled",
      hostUserId: call.organizerId,
      channelId: call.channelId ?? null,
      livekitRoomName: call.roomName,
      title: call.title,
      status: "scheduled",
      scheduledStartAt: call.startAt,
    });
    linkExistingCallToMeeting("scheduled_calls", call.id, meeting.id);
  } catch (e) {
    console.warn(`[meetings] link scheduled_call#${call.id} failed:`, (e as { message?: string })?.message ?? e);
  }

  return call;
}

function createInvitees(call: ScheduledCall, input: CreateInput): ScheduledCallInvitee[] {
  const code = generateRsvpCode(call.id);
  const created: ScheduledCallInvitee[] = [];
  const insertStmt = rawDb.prepare(`
    INSERT INTO scheduled_call_invitees
      (scheduled_call_id, user_id, external_phone, external_email, rsvp_code, response)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  for (const uid of input.inviteeUserIds) {
    // Skip the organizer if they accidentally added themselves.
    if (uid === input.organizerId) continue;
    const r = insertStmt.run(call.id, uid, null, null, code);
    const row = rawDb.prepare("SELECT * FROM scheduled_call_invitees WHERE id = ?").get(r.lastInsertRowid as number);
    created.push(rowToInvitee(row));
  }
  for (const rawPhone of input.externalPhones) {
    const e164 = normalizeE164(rawPhone);
    if (!e164) continue;
    const r = insertStmt.run(call.id, null, e164, null, code);
    const row = rawDb.prepare("SELECT * FROM scheduled_call_invitees WHERE id = ?").get(r.lastInsertRowid as number);
    created.push(rowToInvitee(row));
  }
  for (const email of input.externalEmails) {
    const clean = email.trim().toLowerCase();
    if (!clean || !clean.includes("@")) continue;
    const r = insertStmt.run(call.id, null, null, clean, code);
    const row = rawDb.prepare("SELECT * FROM scheduled_call_invitees WHERE id = ?").get(r.lastInsertRowid as number);
    created.push(rowToInvitee(row));
  }
  // Always include the organizer in the roster, auto-accepted. They get the
  // email/.ics too. Uses the same rsvpCode as the rest of the invite batch.
  const organizerInsert = rawDb.prepare(`
    INSERT INTO scheduled_call_invitees
      (scheduled_call_id, user_id, external_phone, external_email, rsvp_code, response, responded_at)
    VALUES (?, ?, ?, ?, ?, 'yes', strftime('%s','now'))
  `);
  const or = organizerInsert.run(call.id, input.organizerId, null, null, code);
  const orow = rawDb.prepare("SELECT * FROM scheduled_call_invitees WHERE id = ?").get(or.lastInsertRowid as number);
  created.push(rowToInvitee(orow));
  return created;
}

function listInviteesForCall(callId: number): ScheduledCallInvitee[] {
  return rawDb.prepare("SELECT * FROM scheduled_call_invitees WHERE scheduled_call_id = ? ORDER BY id ASC")
    .all(callId).map(rowToInvitee);
}

function listScheduledCallsForOrg(orgId: number, opts: { from?: Date; to?: Date; status?: string[] } = {}): ScheduledCall[] {
  const params: any[] = [orgId];
  let sql = "SELECT * FROM scheduled_calls WHERE org_id = ?";
  if (opts.from) { sql += " AND end_at >= ?"; params.push(Math.floor(opts.from.getTime() / 1000)); }
  if (opts.to)   { sql += " AND start_at <= ?"; params.push(Math.floor(opts.to.getTime() / 1000)); }
  if (opts.status && opts.status.length) {
    sql += ` AND status IN (${opts.status.map(() => "?").join(",")})`;
    params.push(...opts.status);
  }
  sql += " ORDER BY start_at ASC LIMIT 500";
  return (rawDb.prepare(sql).all(...params) as any[]).map(rowToScheduledCall);
}

function getScheduledCall(id: number): ScheduledCall | null {
  const r = rawDb.prepare("SELECT * FROM scheduled_calls WHERE id = ?").get(id);
  return r ? rowToScheduledCall(r) : null;
}

function setScheduledCallStatus(id: number, status: "scheduled" | "started" | "ended" | "cancelled") {
  const now = Math.floor(Date.now() / 1000);
  rawDb.prepare("UPDATE scheduled_calls SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
}

function markReminderSent(id: number) {
  const now = Math.floor(Date.now() / 1000);
  rawDb.prepare("UPDATE scheduled_calls SET reminder_sent_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

function setTeamsMeeting(id: number, joinUrl: string, meetingId: string) {
  const now = Math.floor(Date.now() / 1000);
  rawDb.prepare(
    "UPDATE scheduled_calls SET teams_join_url = ?, teams_meeting_id = ?, updated_at = ? WHERE id = ?",
  ).run(joinUrl, meetingId, now, id);
  // Mirror into the linked unified-meetings row so downstream reads that go
  // through the canonical meeting shape (routes-meetings, bridge dispatch,
  // in-room UI) see the Teams metadata. Without this, `GET /api/meetings/:code`
  // returns teamsJoinUrl:null even though the scheduled_calls row has it,
  // and the bridge never gets dispatched for scheduled meetings.
  const linkedMeetingId = rawDb
    .prepare("SELECT meeting_id FROM scheduled_calls WHERE id = ?")
    .get(id) as { meeting_id?: string | null } | undefined;
  if (linkedMeetingId?.meeting_id) {
    try {
      setMeetingTeamsLink(linkedMeetingId.meeting_id, joinUrl, meetingId);
    } catch (e) {
      console.warn(
        `[scheduled-calls] setMeetingTeamsLink failed for meeting=${linkedMeetingId.meeting_id}:`,
        (e as Error).message,
      );
    }
  }
}

/**
 * Dispatch the Bulldog Bridge for a scheduled call, wiring the parallel
 * Teams meeting into the LiveKit room so external Teams guests land in
 * the same audio/video call as Bulldog users instead of being stranded in
 * the Teams lobby.
 *
 * Fire-and-forget: any error is logged and the meeting continues in the
 * two-parallel-rooms fallback shape. Mirrors the dispatch block in
 * routes-meetings.ts:291 but keyed off the scheduled_call → meeting link.
 */
async function dispatchBridgeForScheduledCall(
  call: ScheduledCall,
  teamsJoinUrl: string,
  teamsMeetingId: string,
): Promise<void> {
  if (!bridgeAvailable()) return;
  const linkedMeetingRow = rawDb
    .prepare("SELECT meeting_id FROM scheduled_calls WHERE id = ?")
    .get(call.id) as { meeting_id?: string | null } | undefined;
  const meetingId = linkedMeetingRow?.meeting_id;
  if (!meetingId) {
    console.warn(
      `[scheduled-calls] bridge dispatch skipped: scheduled_call#${call.id} has no linked meeting row`,
    );
    return;
  }
  const meeting = getMeetingById(meetingId);
  if (!meeting) {
    console.warn(
      `[scheduled-calls] bridge dispatch skipped: meeting=${meetingId} not found`,
    );
    return;
  }
  const livekitWsUrl = process.env.LIVEKIT_WS_URL ?? "";
  const durationMinutes = Math.max(
    60,
    Math.ceil((call.endAt.getTime() - call.startAt.getTime()) / 60_000),
  );
  try {
    const botToken = await mintLivekitBotToken({
      identity: `bridge-${meeting.id}`,
      name: "Bulldog Bridge (recording)",
      roomName: meeting.livekitRoomName,
      ttlMinutes: durationMinutes,
    });
    const result = await dispatchBridge({
      meetingId: meeting.id,
      teamsJoinUrl,
      teamsMeetingId,
      livekitRoom: meeting.livekitRoomName,
      livekitToken: botToken,
      livekitWsUrl,
      organizerId: call.organizerId ? String(call.organizerId) : null,
      options: {
        audioMode: "duplex",
        videoMode: "duplex",
        screenShareMode: "duplex",
        announceOnJoin: true,
        maxDurationMinutes: durationMinutes,
      },
    });
    if (result) {
      setMeetingBridge(meeting.id, result.bridgeId, result.status);
      console.log(
        `[scheduled-calls] bridge dispatched call=${call.id} meeting=${meeting.id} bridgeId=${result.bridgeId} status=${result.status}`,
      );
    } else {
      setMeetingBridge(meeting.id, null, "failed");
    }
  } catch (e) {
    console.warn(
      `[scheduled-calls] bridge dispatch threw for call=${call.id}:`,
      (e as Error).message,
    );
    setMeetingBridge(meeting.id, null, "failed");
  }
}

// Retry backoff schedule: attempts 1..5 wait 30s, 2m, 10m, 30m, 60m before
// the next re-dispatch. After 5 failed attempts we stop retrying so a
// truly-invalid recipient doesn't loop forever. The reminder loop ticks at
// 60s, so real-world first retry lands 30–90s after the initial failure.
const INVITE_RETRY_BACKOFF_S: number[] = [30, 120, 600, 1800, 3600];
const INVITE_MAX_ATTEMPTS = INVITE_RETRY_BACKOFF_S.length;

function markInviteSent(inviteeId: number, err: string | null) {
  const now = Math.floor(Date.now() / 1000);
  if (err) {
    // Increment attempts + schedule next retry (bounded by MAX_ATTEMPTS).
    const row = rawDb.prepare(
      "SELECT invite_attempts FROM scheduled_call_invitees WHERE id = ?",
    ).get(inviteeId) as { invite_attempts?: number } | undefined;
    const attempts = (row?.invite_attempts ?? 0) + 1;
    const nextRetryAt =
      attempts >= INVITE_MAX_ATTEMPTS
        ? null
        : now + INVITE_RETRY_BACKOFF_S[attempts - 1];
    rawDb.prepare(
      "UPDATE scheduled_call_invitees SET invite_error = ?, invite_attempts = ?, invite_next_retry_at = ? WHERE id = ?",
    ).run(err.slice(0, 500), attempts, nextRetryAt, inviteeId);
    console.log(JSON.stringify({
      msg: "invite_send_failed",
      inviteeId,
      attempts,
      nextRetryAt,
      error: err.slice(0, 200),
    }));
  } else {
    rawDb.prepare(
      "UPDATE scheduled_call_invitees SET invite_sent_at = ?, invite_error = NULL, invite_next_retry_at = NULL WHERE id = ?",
    ).run(now, inviteeId);
  }
}

function markInviteeReminderSent(inviteeId: number) {
  const now = Math.floor(Date.now() / 1000);
  rawDb.prepare("UPDATE scheduled_call_invitees SET reminder_sent_at = ? WHERE id = ?").run(now, inviteeId);
}

function markInviteeReminder15Sent(inviteeId: number) {
  const now = Math.floor(Date.now() / 1000);
  rawDb.prepare("UPDATE scheduled_call_invitees SET reminder_15_at = ? WHERE id = ?").run(now, inviteeId);
}

function markInviteeReminderStartSent(inviteeId: number) {
  const now = Math.floor(Date.now() / 1000);
  rawDb.prepare("UPDATE scheduled_call_invitees SET reminder_start_at = ?, reminder_sent_at = ? WHERE id = ?").run(now, now, inviteeId);
}

function setRsvp(inviteeId: number, response: RsvpResponse, channel: string) {
  const now = Math.floor(Date.now() / 1000);
  rawDb.prepare(`
    UPDATE scheduled_call_invitees
    SET response = ?, responded_at = ?, response_channel = ?
    WHERE id = ?
  `).run(response, now, channel, inviteeId);
}

/* ─────────────────────── Join-URL builder ─────────────────────────────── */
function buildJoinUrl(call: ScheduledCall, invitee: ScheduledCallInvitee, callerName: string): string {
  // For chat-user invitees we mint a per-user join token so we know who is
  // joining when they redeem. For external phone/email invitees we mint a
  // token bound to the organizer's id (caller bypass) so they land in the
  // room as a guest under the organizer's namespace.
  const userId = invitee.userId ?? call.organizerId;
  const token = signCallJoinToken({
    userId,
    roomName: call.roomName,
    callerName,
    kind: call.kind,
    channelId: call.channelId,
  });
  return `${CHAT_BASE_URL}/call-join?t=${encodeURIComponent(token)}`;
}

/* ─────────────────── Short-link builder (per invitee) ─────────────────────
 * Mint a short link for `joinUrl` once per invitee and persist the token on
 * the invitee row so the reminder reuses the same link. The 30-day default
 * TTL covers meetings booked weeks out plus the reminder window. Returns the
 * full `${CHAT_BASE_URL}/j/<token>` URL. `existingToken` is read from the raw
 * invitee row's short_link_token so we don't widen the typed model.
 */
function getOrMintInviteeShortUrl(
  inviteeId: number,
  callId: number,
  joinUrl: string,
  existingToken: string | null,
): string {
  // Reuse a still-valid stored token; legacy/expired ones fall through to mint.
  if (existingToken && resolveShortLink(existingToken)) {
    return `${CHAT_BASE_URL}/j/${existingToken}`;
  }
  const token = mintShortLink(joinUrl, { scheduledCallId: callId });
  rawDb.prepare("UPDATE scheduled_call_invitees SET short_link_token = ? WHERE id = ?").run(token, inviteeId);
  return `${CHAT_BASE_URL}/j/${token}`;
}

/* ─────────────────── Time formatting (organizer TZ) ───────────────────── */
function formatWhenLabel(d: Date, tz: string = "America/Los_Angeles"): string {
  try {
    return d.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return d.toISOString();
  }
}

/* ─────────────────── RSVP confirmation page (server-rendered) ─────────── */
const NAVY = "#191E4A";
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function rsvpPageShell(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSVP — Bulldog Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f4f5f7; color: ${NAVY};
           font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 440px; width: 100%; background: #fff; border: 1px solid #e5e7eb;
            border-radius: 12px; padding: 36px 28px; text-align: center; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 12px; color: ${NAVY}; }
    .meeting { font-size: 17px; font-weight: 600; color: ${NAVY}; margin-bottom: 4px; }
    .when { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
    .actions { margin-top: 24px; }
    a.btn { display: inline-block; margin: 4px; padding: 10px 18px; border-radius: 8px;
            text-decoration: none; font-weight: 600; font-size: 14px;
            border: 1px solid ${NAVY}; color: ${NAVY}; background: #fff; }
    a.btn.primary { background: ${NAVY}; color: #fff; }
    p.hint { font-size: 14px; color: #6b7280; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">${inner}</div>
</body>
</html>`;
}
function renderRsvpConfirmationPage(p: {
  title: string;
  whenLabel: string;
  response: RsvpResponse;
  icsUrl: string;
  meetingsUrl: string;
  teamsJoinUrl?: string | null;
}): string {
  const headline =
    p.response === "yes" ? "✓ You're marked as attending" :
    p.response === "no" ? "✓ You're marked as declined" :
    "✓ You're marked as maybe";
  const teamsBtn = p.teamsJoinUrl
    ? `<a class="btn teams" href="${escHtml(p.teamsJoinUrl)}" style="background:#5b5fc7;color:#fff;border-color:#5b5fc7">Join via Teams</a>`
    : "";
  return rsvpPageShell(`
    <h1>${escHtml(headline)}</h1>
    <div class="meeting">${escHtml(p.title)}</div>
    <div class="when">${escHtml(p.whenLabel)}</div>
    <div class="actions">
      ${teamsBtn}
      <a class="btn" href="${escHtml(p.icsUrl)}">Add to calendar</a>
      <a class="btn primary" href="${escHtml(p.meetingsUrl)}">View in Bulldog</a>
    </div>`);
}
function renderRsvpErrorPage(message: string): string {
  return rsvpPageShell(`
    <h1>RSVP not recorded</h1>
    <p class="hint">${escHtml(message)}</p>`);
}

/* ─────────────────── Dispatch (send invite SMSes + emails) ────────────── */
async function dispatchInvites(call: ScheduledCall): Promise<void> {
  const organizer = storage.getUser(call.organizerId);
  if (!organizer) return;
  const invitees = listInviteesForCall(call.id);
  console.log(`[scheduled-calls] dispatch call=${call.id} organizer=${call.organizerId} invitees=${invitees.length}`);
  const whenLabel = formatWhenLabel(call.startAt);

  // Build attendee email list for .ics (all invitees with emails).
  const allAttendeeEmails: string[] = [];
  for (const i of invitees) {
    if (i.userId) {
      const u = storage.getUser(i.userId);
      if (u?.email) allAttendeeEmails.push(u.email);
    } else if (i.externalEmail) {
      allAttendeeEmails.push(i.externalEmail);
    }
  }

  // Build the human-readable invitee roster shown on every email so each
  // recipient can see who else is on the meeting. Organizer is always
  // listed first (as host); each app-user invitee renders by name (falling
  // back to email), and external phone/email invitees render by contact.
  const inviteeRosterParts: string[] = [`${organizer.name} (host)`];
  for (const inv of invitees) {
    if (inv.userId === organizer.id) continue; // organizer already listed
    if (inv.userId) {
      const u = storage.getUser(inv.userId);
      if (u?.name) inviteeRosterParts.push(u.name);
      else if (u?.email) inviteeRosterParts.push(u.email);
    } else if (inv.externalEmail) {
      inviteeRosterParts.push(inv.externalEmail);
    } else if (inv.externalPhone) {
      inviteeRosterParts.push(inv.externalPhone);
    }
  }
  const inviteeRoster = inviteeRosterParts.join(", ");

  for (const inv of invitees) {
    if (inv.inviteSentAt) continue; // already sent

    // Resolve contact methods independently.
    let phone: string | null = null;
    let email: string | null = null;
    if (inv.userId) {
      const u = storage.getUser(inv.userId);
      phone = normalizeE164(u?.phone);
      email = u?.email ?? null;
    } else if (inv.externalPhone) {
      phone = normalizeE164(inv.externalPhone);
    }
    if (inv.externalEmail) {
      email = inv.externalEmail;
    }
    console.log(`[scheduled-calls] inv=${inv.id} user=${inv.userId} email=${email ? "yes" : "no"} phone=${phone ? "yes" : "no"} emailConfigured=${isEmailConfigured()}`);

    const joinUrl = buildJoinUrl(call, inv, organizer.name);

    let emailSent = false;
    let smsSent = false;
    const errors: string[] = [];

    // Mint one short link per invitee, reused across email + SMS (and later
    // reminders via the persisted short_link_token). The short /j/<token> URL
    // is what the iOS AASA claims (/j/*) so it deep-links into the app, and it
    // keeps the visible link clean instead of a ~280-char signed JWT.
    let inviteeShortUrl: string | null = null;
    const ensureShortUrl = (): string => {
      if (!inviteeShortUrl) inviteeShortUrl = getOrMintInviteeShortUrl(inv.id, call.id, joinUrl, null);
      return inviteeShortUrl;
    };

    // ─── Email ───────────────────────────────────────────────────────────
    if (email && isEmailConfigured()) {
      try {
        const icsContent = buildIcsForScheduledCall({
          uid: `bulldog-${call.id}@bulldogops.com`,
          title: call.title,
          description:
            (call.notes ? call.notes + "\n\n" : "") +
            `Join via Bulldog: ${joinUrl}\n` +
            (call.teamsJoinUrl ? `Join via Teams: ${call.teamsJoinUrl}\n` : "") +
            `Organizer: ${organizer.name}`,
          startUtc: call.startAt,
          endUtc: call.endAt,
          organizerEmail: organizer.email,
          organizerName: organizer.name,
          attendeeEmails: allAttendeeEmails,
          joinUrl,
          sequence: call.icsSequence,
          method: "REQUEST",
        });

        const escH = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const joinShortUrl = ensureShortUrl();
        // RSVP buttons point at /r/<token> (record-and-confirm, no room drop).
        // The Join button keeps the /j/<token> short link (join-and-redirect).
        // Both reuse the same per-invitee short-link token.
        const shortToken = joinShortUrl.substring(joinShortUrl.lastIndexOf("/") + 1);
        const rsvpBase = `${CHAT_BASE_URL}/r/${shortToken}`;
        const rsvpYesUrl   = `${rsvpBase}?response=yes`;
        const rsvpNoUrl    = `${rsvpBase}?response=no`;
        const rsvpMaybeUrl = `${rsvpBase}?response=maybe`;
        const subject = `${organizer.name} invited you to "${call.title}" — ${whenLabel}`;
        const textBody = [
          `${organizer.name} has scheduled a ${call.kind} call: "${call.title}"`,
          `When: ${whenLabel}`,
          ``,
          `Join the meeting: ${joinShortUrl}`,
          ...(call.teamsJoinUrl ? [`Join via Teams:   ${call.teamsJoinUrl}`] : []),
          ``,
          `RSVP (records your response, does not join):`,
          `  Yes    → ${rsvpYesUrl}`,
          `  No     → ${rsvpNoUrl}`,
          `  Maybe  → ${rsvpMaybeUrl}`,
        ].join("\n");

        const callKindLabel = call.kind === "video" ? "Video call" : "Voice call";
        const htmlBody = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escH(call.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0B1020;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#E8EBF5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0B1020;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background:linear-gradient(180deg,#13182E 0%,#191E4A 100%);border:1px solid rgba(94,151,255,0.18);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.45);">
    <!-- Header bar with logo + brand -->
    <tr><td style="padding:24px 28px 8px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:middle;padding-right:12px;">
            <img src="https://chat.bulldogops.com/icon-192.png" width="36" height="36" alt="Bulldog" style="display:block;border-radius:8px;" />
          </td>
          <td style="vertical-align:middle;">
            <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#5E97FF;font-weight:700;">Bulldog Chat</div>
            <div style="font-size:13px;color:rgba(232,235,245,0.65);margin-top:2px;">${escH(callKindLabel)} invitation</div>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- Title -->
    <tr><td style="padding:20px 28px 0 28px;">
      <h1 style="margin:0;font-size:22px;line-height:1.25;color:#FFFFFF;font-weight:700;">${escH(call.title)}</h1>
    </td></tr>

    <!-- Meta strip -->
    <tr><td style="padding:14px 28px 0 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:10px 14px;background:rgba(94,151,255,0.08);border:1px solid rgba(94,151,255,0.18);border-radius:10px;">
            <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#5E97FF;font-weight:700;">When</div>
            <div style="font-size:14px;color:#FFFFFF;margin-top:2px;font-weight:600;">${escH(whenLabel)}</div>
            <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#5E97FF;font-weight:700;margin-top:12px;">Invitees</div>
            <div style="font-size:14px;color:#FFFFFF;margin-top:2px;font-weight:500;line-height:1.45;">${escH(inviteeRoster)}</div>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- How to join explainer -->
    <tr><td style="padding:24px 28px 0 28px;">
      <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#5E97FF;font-weight:700;">How to join</div>
      <div style="font-size:13px;color:rgba(232,235,245,0.85);margin-top:6px;line-height:1.55;">
        <strong style="color:#FFFFFF;">Bulldog Chat users:</strong> tap <em>Join meeting</em> to open the call in the Bulldog app or browser.${
          call.teamsJoinUrl
            ? `<br/><strong style="color:#FFFFFF;">Everyone else (no Bulldog account):</strong> tap <em>Join via Microsoft Teams</em> — works in any browser, no install required.`
            : ""
        }
      </div>
    </td></tr>

    <!-- Primary Join CTA -->
    <tr><td style="padding:14px 28px 0 28px;" align="center">
      <a href="${escH(joinShortUrl)}" style="display:inline-block;padding:14px 36px;background:#5E97FF;color:#FFFFFF;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.02em;box-shadow:0 6px 16px rgba(94,151,255,0.35);">Join meeting</a>
    </td></tr>${
      call.teamsJoinUrl
        ? `

    <!-- Teams CTA -->
    <tr><td style="padding:10px 28px 0 28px;" align="center">
      <a href="${escH(call.teamsJoinUrl)}" style="display:inline-block;padding:11px 24px;background:#5B5FC7;color:#FFFFFF;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">Join via Microsoft Teams</a>
    </td></tr>`
        : ""
    }

    <!-- RSVP -->
    <tr><td style="padding:24px 28px 0 28px;">
      <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(232,235,245,0.5);font-weight:700;margin-bottom:10px;">RSVP <span style="color:rgba(232,235,245,0.35);text-transform:none;letter-spacing:normal;font-weight:400;">— records your response without joining</span></div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding-right:8px;"><a href="${escH(rsvpYesUrl)}" style="display:inline-block;padding:9px 18px;background:#5E97FF;color:#FFFFFF;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">Yes</a></td>
          <td style="padding-right:8px;"><a href="${escH(rsvpNoUrl)}" style="display:inline-block;padding:9px 18px;background:#DD403D;color:#FFFFFF;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">No</a></td>
          <td><a href="${escH(rsvpMaybeUrl)}" style="display:inline-block;padding:9px 18px;background:#C99A2E;color:#FFFFFF;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">Maybe</a></td>
        </tr>
      </table>
    </td></tr>

    <!-- Footer -->
    <tr><td style="padding:28px 28px 24px 28px;border-top:1px solid rgba(94,151,255,0.12);margin-top:24px;">
      <div style="border-top:1px solid rgba(94,151,255,0.12);padding-top:18px;font-size:11px;color:rgba(232,235,245,0.45);line-height:1.5;">
        You were invited to a meeting in <span style="color:#5E97FF;font-weight:600;">Bulldog Chat</span>. Calendar invite attached (.ics).<br/>
        Update notification preferences at <a href="https://auth.bulldogops.com/settings/notifications" style="color:#5E97FF;text-decoration:none;">auth.bulldogops.com</a>.
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

        const res = await sendEmail({
          to: email,
          subject,
          text: textBody,
          html: htmlBody,
          attachments: [{
            filename: "meeting.ics",
            content: Buffer.from(icsContent, "utf8"),
            // SendGrid's attachments[].type field rejects semicolons. Use the
            // bare MIME type here; calendar clients pick up the METHOD from
            // the body of the .ics file itself.
            contentType: "text/calendar",
          }],
        });
        if (res.sent) {
          emailSent = true;
          console.log(JSON.stringify({
            msg: "invite_email_sent",
            inviteeId: inv.id,
            scheduledCallId: call.id,
            recipient: email,
          }));
        } else {
          errors.push(`email: ${res.reason ?? "unknown"}`);
          console.warn(JSON.stringify({
            msg: "invite_email_failed",
            inviteeId: inv.id,
            scheduledCallId: call.id,
            recipient: email,
            reason: (res.reason ?? "unknown").slice(0, 200),
          }));
        }
      } catch (e: any) {
        errors.push(`email: ${e?.message ?? "exception"}`);
        console.warn(JSON.stringify({
          msg: "invite_email_exception",
          inviteeId: inv.id,
          scheduledCallId: call.id,
          recipient: email,
          error: (e?.message ?? "exception").slice(0, 200),
        }));
      }
    } else if (email && !isEmailConfigured()) {
      // Diagnostic: recipient HAS an email but SendGrid isn't configured. This
      // is a deployment-level misconfig, not a per-invite failure — log once
      // per invitee so it's obvious in Render logs.
      console.warn(JSON.stringify({
        msg: "invite_email_skipped_no_provider",
        inviteeId: inv.id,
        scheduledCallId: call.id,
        recipient: email,
      }));
      errors.push("email: SENDGRID_API_KEY not set");
    }

    // ─── SMS ─────────────────────────────────────────────────────────────
    if (phone && smsAvailable()) {
      // Consent gate: ask bulldog-auth whether SMS is allowed for this
      // recipient + event. Fail-closed. Auth is the source of truth for the
      // destination phone, so use the number it returns over the local one.
      const consent = await checkSmsConsent(email ?? "", "meeting_invite");
      if (!consent.allowed) {
        console.log(JSON.stringify({
          msg: "sms_skipped",
          event: "meeting_invite",
          inviteeId: inv.id,
          scheduledCallId: call.id,
          reason: consent.reason,
        }));
      } else {
      const smsTo = consent.phoneE164 ?? phone;
      // Reuse the per-invitee short link (minted above for email, or here if
      // email wasn't sent); the reminder reuses the same token via
      // short_link_token on the invitee row.
      const shortUrl = ensureShortUrl();
      // Build the RSVP page URL from the same short-link token used for Join.
      // /r/<token> renders a Yes/No/Maybe page (the same page the email
      // RSVP buttons target). Two-URL SMS body preserves the SW 1.5.45
      // learning (no reply-based Y/N/M) while giving invitees an easy
      // tappable RSVP path from SMS.
      const smsShortToken = shortUrl.substring(shortUrl.lastIndexOf("/") + 1);
      const smsRsvpUrl = `${CHAT_BASE_URL}/r/${smsShortToken}`;
      const smsBody = buildScheduledCallSmsBody({
        organizerName: organizer.name,
        title: call.title,
        whenLabel,
        joinUrl,
        rsvpCode: `#${inv.rsvpCode}`,
        shortUrl,
        rsvpUrl: smsRsvpUrl,
      });
      try {
        const res = await sendSms({ to: smsTo, body: smsBody });
        if (res.ok) {
          smsSent = true;
          console.log(JSON.stringify({
            msg: "invite_sms_sent",
            inviteeId: inv.id,
            scheduledCallId: call.id,
            recipient: smsTo,
          }));
        } else {
          errors.push(`sms: ${res.error ?? "unknown"}`);
          console.warn(JSON.stringify({
            msg: "invite_sms_failed",
            inviteeId: inv.id,
            scheduledCallId: call.id,
            recipient: smsTo,
            reason: (res.error ?? "unknown").slice(0, 200),
          }));
        }
      } catch (e: any) {
        errors.push(`sms: ${e?.message ?? "exception"}`);
        console.warn(JSON.stringify({
          msg: "invite_sms_exception",
          inviteeId: inv.id,
          scheduledCallId: call.id,
          recipient: smsTo,
          error: (e?.message ?? "exception").slice(0, 200),
        }));
      }
      }
    }

    // ─── Mark result ─────────────────────────────────────────────────────
    if (emailSent || smsSent) {
      markInviteSent(inv.id, null);
    } else if (!email && !phone) {
      markInviteSent(inv.id, "no contact methods");
    } else {
      markInviteSent(inv.id, errors.length ? `all sends failed: ${errors.join("; ")}` : "no configured provider");
    }
  }

  // Organizer confirmation email — the organizer is intentionally filtered
  // out of the invitee fan-out above (they created the meeting, no SMS spam
  // needed). But they DO want a copy of the .ics so it lands on their
  // calendar like Google Calendar / Outlook. Best-effort: never throws.
  await sendOrganizerConfirmation(call, organizer, invitees, allAttendeeEmails, whenLabel, inviteeRoster).catch((e) =>
    console.warn(`[scheduled-calls] organizer confirmation failed call=${call.id}:`, e),
  );
}

/* Organizer confirmation email --------------------------------------------- */
async function sendOrganizerConfirmation(
  call: ScheduledCall,
  organizer: { id: number; name: string; email?: string | null },
  invitees: ScheduledCallInvitee[],
  allAttendeeEmails: string[],
  whenLabel: string,
  inviteeRoster: string,
): Promise<void> {
  if (!organizer.email) {
    console.log(`[scheduled-calls] organizer confirmation skip call=${call.id}: no organizer email`);
    return;
  }
  if (!isEmailConfigured()) {
    console.log(`[scheduled-calls] organizer confirmation skip call=${call.id}: email not configured`);
    return;
  }

  // Host email uses the same full roster (host + invitees) for consistency.
  const inviteeSummary = inviteeRoster;

  const hostJoinUrl = `${CHAT_BASE_URL}/call-join?t=${encodeURIComponent(
    signCallJoinToken({
      userId: organizer.id,
      roomName: call.roomName,
      callerName: organizer.name,
      kind: call.kind,
      channelId: call.channelId,
    }),
  )}`;

  const icsContent = buildIcsForScheduledCall({
    uid: `bulldog-${call.id}@bulldogops.com`,
    title: call.title,
    description:
      (call.notes ? call.notes + "\n\n" : "") +
      `Join via Bulldog: ${hostJoinUrl}\n` +
      (call.teamsJoinUrl ? `Join via Teams: ${call.teamsJoinUrl}\n` : "") +
      `Organizer: ${organizer.name}`,
    startUtc: call.startAt,
    endUtc: call.endAt,
    organizerEmail: organizer.email,
    organizerName: organizer.name,
    attendeeEmails: allAttendeeEmails,
    joinUrl: hostJoinUrl,
    sequence: call.icsSequence,
    method: "REQUEST",
  });

  const escH = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const subject = `Meeting scheduled: "${call.title}" — ${whenLabel}`;
  const textBody = [
    `You scheduled a ${call.kind} call: "${call.title}"`,
    `When: ${whenLabel}`,
    `Invitees: ${inviteeSummary}`,
    ``,
    `Join the meeting: ${hostJoinUrl}`,
    ...(call.teamsJoinUrl ? [`Join via Teams:   ${call.teamsJoinUrl}`] : []),
    ``,
    `An .ics calendar attachment is included so this lands on your calendar.`,
  ].join("\n");

  const callKindLabel = call.kind === "video" ? "Video call" : "Voice call";
  const htmlBody = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Meeting scheduled: ${escH(call.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0B1020;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#E8EBF5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0B1020;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;background:linear-gradient(180deg,#13182E 0%,#191E4A 100%);border:1px solid rgba(94,151,255,0.18);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.45);">
    <!-- Header bar with logo + brand -->
    <tr><td style="padding:24px 28px 8px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:middle;padding-right:12px;">
            <img src="https://chat.bulldogops.com/icon-192.png" width="36" height="36" alt="Bulldog" style="display:block;border-radius:8px;" />
          </td>
          <td style="vertical-align:middle;">
            <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#5E97FF;font-weight:700;">Bulldog Chat</div>
            <div style="font-size:13px;color:rgba(232,235,245,0.65);margin-top:2px;">${escH(callKindLabel)} scheduled</div>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- Title -->
    <tr><td style="padding:20px 28px 0 28px;">
      <h1 style="margin:0;font-size:22px;line-height:1.25;color:#FFFFFF;font-weight:700;">${escH(call.title)}</h1>
      <div style="margin-top:6px;font-size:13px;color:rgba(232,235,245,0.6);">You scheduled this meeting. A copy is attached for your calendar.</div>
    </td></tr>

    <!-- Meta strip -->
    <tr><td style="padding:14px 28px 0 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="padding:12px 14px;background:rgba(94,151,255,0.08);border:1px solid rgba(94,151,255,0.18);border-radius:10px;">
            <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#5E97FF;font-weight:700;">When</div>
            <div style="font-size:14px;color:#FFFFFF;margin-top:2px;font-weight:600;">${escH(whenLabel)}</div>
            <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#5E97FF;font-weight:700;margin-top:12px;">Invitees</div>
            <div style="font-size:14px;color:#FFFFFF;margin-top:2px;font-weight:500;line-height:1.45;">${escH(inviteeSummary)}</div>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- How to join explainer -->
    <tr><td style="padding:24px 28px 0 28px;">
      <div style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#5E97FF;font-weight:700;">How invitees join</div>
      <div style="font-size:13px;color:rgba(232,235,245,0.85);margin-top:6px;line-height:1.55;">
        <strong style="color:#FFFFFF;">Bulldog Chat users:</strong> tap <em>Join meeting</em> to open the call in the Bulldog app or browser.${
          call.teamsJoinUrl
            ? `<br/><strong style="color:#FFFFFF;">Everyone else (no Bulldog account):</strong> share the <em>Join via Microsoft Teams</em> link — works in any browser, no install required.`
            : ""
        }
      </div>
    </td></tr>

    <!-- Primary Join CTA -->
    <tr><td style="padding:14px 28px 0 28px;" align="center">
      <a href="${escH(hostJoinUrl)}" style="display:inline-block;padding:14px 36px;background:#5E97FF;color:#FFFFFF;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;letter-spacing:0.02em;box-shadow:0 6px 16px rgba(94,151,255,0.35);">Join meeting</a>
    </td></tr>${
    call.teamsJoinUrl
      ? `

    <!-- Teams CTA -->
    <tr><td style="padding:10px 28px 0 28px;" align="center">
      <a href="${escH(call.teamsJoinUrl)}" style="display:inline-block;padding:11px 24px;background:#5B5FC7;color:#FFFFFF;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">Join via Microsoft Teams</a>
    </td></tr>`
      : ""
  }

    <!-- Footer -->
    <tr><td style="padding:28px 28px 24px 28px;">
      <div style="border-top:1px solid rgba(94,151,255,0.12);padding-top:18px;font-size:11px;color:rgba(232,235,245,0.45);line-height:1.5;">
        You received this because you scheduled this meeting in <span style="color:#5E97FF;font-weight:600;">Bulldog Chat</span>. Calendar invite attached (.ics).<br/>
        Update notification preferences at <a href="https://auth.bulldogops.com/settings/notifications" style="color:#5E97FF;text-decoration:none;">auth.bulldogops.com</a>.
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  const res = await sendEmail({
    to: organizer.email,
    subject,
    text: textBody,
    html: htmlBody,
    attachments: [{
      filename: "invite.ics",
      content: Buffer.from(icsContent, "utf8"),
      contentType: "text/calendar",
    }],
  });

  if (res.sent) {
    console.log(`[scheduled-calls] organizer confirmation sent call=${call.id} to=${organizer.email}`);
  } else {
    console.warn(`[scheduled-calls] organizer confirmation send failed call=${call.id}: ${res.reason ?? "unknown"}`);
  }
}

/* ────────────────── Invite retry loop (in-process) ─────────────────────
 * The initial `dispatchInvites(call)` is fire-and-forget from the create
 * route. If a specific recipient's send failed transiently (e.g. SendGrid
 * 5xx, DNS blip, checkSmsConsent lookup timeout), that invitee was left
 * with invite_sent_at = NULL and would never get another attempt — the
 * reminder loop only fires reminders, not initial invites. This function
 * scans for pending invitees whose retry window has come due and re-fans
 * them out. Runs on the same 60s reminder tick so we don't spin up a
 * second timer.
 * ------------------------------------------------------------------------ */
async function dispatchInviteRetries() {
  const now = Math.floor(Date.now() / 1000);
  // Find calls with any invitee still pending + due for retry. We limit to
  // scheduled/started calls (never retry a cancelled meeting).
  const rows = rawDb.prepare(`
    SELECT DISTINCT sc.id
    FROM scheduled_calls sc
    JOIN scheduled_call_invitees sci ON sci.scheduled_call_id = sc.id
    WHERE sc.status IN ('scheduled', 'started')
      AND sci.invite_sent_at IS NULL
      AND sci.invite_next_retry_at IS NOT NULL
      AND sci.invite_next_retry_at <= ?
      AND sci.invite_attempts < ?
    LIMIT 50
  `).all(now, INVITE_MAX_ATTEMPTS) as Array<{ id: number }>;
  if (rows.length === 0) return;
  console.log(`[scheduled-calls] retry loop: ${rows.length} call(s) with due invites`);
  for (const r of rows) {
    const call = getScheduledCall(r.id);
    if (!call) continue;
    try {
      await dispatchInvites(call);
    } catch (e) {
      console.warn(
        `[scheduled-calls] retry dispatch call=${call.id} error:`,
        (e as { message?: string })?.message ?? e,
      );
    }
  }
}

// Exported for smoke tests — lets the test drive one retry pass without
// starting the 60s timer. Not part of the public surface but stable.
export function _dispatchInviteRetriesForTest(): Promise<void> {
  return dispatchInviteRetries();
}

/* ─────────────────── Reminder loop (in-process) ───────────────────────── */
async function dispatchReminders() {
  const now = Math.floor(Date.now() / 1000);

  // Find calls starting in the next 16 minutes (covers 15-min and at-start
  // reminder windows). Include a slight grace window for at-start.
  const horizon = now + 16 * 60;
  const rows = rawDb.prepare(`
    SELECT * FROM scheduled_calls
    WHERE status = 'scheduled'
      AND start_at <= ?
      AND start_at > ?
  `).all(horizon, now - 60) as any[];

  for (const r of rows) {
    const call = rowToScheduledCall(r);
    const organizer = storage.getUser(call.organizerId);
    if (!organizer) continue;
    const inviteesRaw = rawDb.prepare(
      "SELECT * FROM scheduled_call_invitees WHERE scheduled_call_id = ? ORDER BY id ASC"
    ).all(call.id) as any[];

    const secondsUntilStart = call.startAt.getTime() / 1000 - now;
    // Hash-route so the Expo mobile shell + web both resolve the SPA route
    // correctly. Web service worker uses location.href = url which works
    // with a leading "/" and trailing "#/path"; SPA hash router needs the
    // "#/" prefix to actually mount the channel view.
    const channelUrl = call.channelId ? `/#/channel/${call.channelId}` : "/";

    for (const row of inviteesRaw) {
      const inv = rowToInvitee(row);
      if (inv.response === "no") continue;

      const joinUrl = buildJoinUrl(call, inv, organizer.name);

      if (inv.userId) {
        // App-user invitee: web push notifications.

        // 15-min push reminder
        if (secondsUntilStart <= 15 * 60 && !row.reminder_15_at) {
          try {
            await sendNotificationToUsers([inv.userId], {
              title: `Meeting in 15 min: ${call.title}`,
              body: `${call.title} starts in about 15 minutes.`,
              url: channelUrl,
              tag: `sched-${call.id}`,
            });
          } catch (e) { /* best-effort */ }
          markInviteeReminder15Sent(inv.id);
        }

        // At-start push + SMS reminder
        if (secondsUntilStart <= 60 && !row.reminder_start_at) {
          try {
            await sendNotificationToUsers([inv.userId], {
              title: `${call.title} starting now`,
              body: `Your ${call.kind} call is starting now.`,
              url: channelUrl,
              tag: `sched-${call.id}`,
            });
          } catch (e) { /* best-effort */ }
          const u = storage.getUser(inv.userId);
          const phone = normalizeE164(u?.phone);
          if (phone && smsAvailable()) {
            const consent = await checkSmsConsent(u?.email ?? "", "meeting_reminder");
            if (!consent.allowed) {
              console.log(JSON.stringify({
                msg: "sms_skipped",
                event: "meeting_reminder",
                inviteeId: inv.id,
                scheduledCallId: call.id,
                reason: consent.reason,
              }));
            } else {
              const minutes = Math.max(0, Math.round(secondsUntilStart / 60));
              const shortUrl = getOrMintInviteeShortUrl(inv.id, call.id, joinUrl, row.short_link_token ?? null);
              const smsBody = buildReminderSmsBody({ title: call.title, minutesUntilStart: minutes, joinUrl, shortUrl });
              try { await sendSms({ to: consent.phoneE164 ?? phone, body: smsBody }); } catch (e) { /* best-effort */ }
            }
          }
          markInviteeReminderStartSent(inv.id);
        }
      } else {
        // External-phone-only invitee: legacy 5-min SMS reminder.
        if (inv.reminderSentAt) continue;
        const phone = normalizeE164(inv.externalPhone);
        if (!phone || !smsAvailable()) {
          markInviteeReminderSent(inv.id);
          continue;
        }
        if (secondsUntilStart <= 6 * 60) {
          const consent = await checkSmsConsent(inv.externalEmail ?? "", "meeting_reminder");
          if (!consent.allowed) {
            console.log(JSON.stringify({
              msg: "sms_skipped",
              event: "meeting_reminder",
              inviteeId: inv.id,
              scheduledCallId: call.id,
              reason: consent.reason,
            }));
          } else {
            const minutes = Math.max(1, Math.round(secondsUntilStart / 60));
            const shortUrl = getOrMintInviteeShortUrl(inv.id, call.id, joinUrl, row.short_link_token ?? null);
            const smsBody = buildReminderSmsBody({ title: call.title, minutesUntilStart: minutes, joinUrl, shortUrl });
            try { await sendSms({ to: consent.phoneE164 ?? phone, body: smsBody }); } catch (e) { /* best-effort */ }
          }
          markInviteeReminderSent(inv.id);
        }
      }
    }

    // Mark call-level reminder_sent_at when all invitee at-start reminders done.
    const allDone = inviteesRaw.every((row: any) =>
      row.response === "no" ||
      (row.user_id ? !!row.reminder_start_at : !!row.reminder_sent_at)
    );
    if (allDone && !r.reminder_sent_at) {
      markReminderSent(call.id);
    }
  }
  // Also auto-transition calls whose start_at has passed but status is still 'scheduled'.
  const startedRows = rawDb.prepare(`
    SELECT id, channel_id FROM scheduled_calls
    WHERE status = 'scheduled' AND start_at <= ?
  `).all(now) as any[];
  for (const sr of startedRows) {
    setScheduledCallStatus(sr.id, "started");
    // Update the in-channel system-message card with the new status by
    // posting a 'started' card (the original 'created' card stays in history).
    if (sr.channel_id) {
      const call = getScheduledCall(sr.id);
      if (call) postScheduledCallCard(call, "scheduled_call.started").catch(() => {});
    }
  }
  // Auto-end calls past their end_at + a 60-min grace window.
  const endHorizon = now - 60 * 60;
  rawDb.prepare(`
    UPDATE scheduled_calls
    SET status = 'ended', updated_at = ?
    WHERE status IN ('scheduled','started') AND end_at <= ?
  `).run(now, endHorizon);
}

let reminderTimer: NodeJS.Timeout | null = null;
export function startReminderLoop() {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    // Retry pending invites first so a due retry lands before the reminder
    // scan looks at invitee state. Both are best-effort; a throw from one
    // must not stop the other.
    dispatchInviteRetries().catch((e) =>
      console.warn("[scheduled-calls] invite retry loop error:", e),
    );
    dispatchReminders().catch((e) =>
      console.warn("[scheduled-calls] reminder loop error:", e),
    );
  }, 60 * 1000); // every 60s
  console.log("[scheduled-calls] reminder loop started (60s tick, includes invite retries)");
}
export function stopReminderLoop() {
  if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
}

/**
 * Notify every app-user invitee of a scheduled meeting that the meeting has
 * actually started (someone joined the LiveKit room). Mirrors Teams' "Bob
 * started a meeting" prompt: each invitee gets a web push with a one-tap
 * Join URL pointing at the meeting's canonical /m/<code> page.
 *
 * Looks up the scheduled_calls row by its linked meeting_id (set when the
 * scheduled call was mirrored into the meetings table). Idempotent guard:
 * uses the call's existing `reminder_sent_at` timestamp as a marker so we
 * don't re-fire if the host re-joins after a brief drop. Best-effort: never
 * throws; failures here must not block the meeting join flow.
 */
export async function notifyInviteesMeetingStarted(
  meetingId: string,
  starterUserId: number,
): Promise<void> {
  try {
    const row = rawDb
      .prepare(
        "SELECT id, organizer_id, title, reminder_sent_at FROM scheduled_calls WHERE meeting_id = ? AND status IN ('scheduled','started')",
      )
      .get(meetingId) as
      | { id: number; organizer_id: number; title: string; reminder_sent_at: number | null }
      | undefined;
    if (!row) return;
    // Don't re-spam invitees if we've already fanned out for this meeting.
    if (row.reminder_sent_at) return;

    const call = getScheduledCall(row.id);
    if (!call) return;
    const starter = storage.getUser(starterUserId);
    const starterName = starter?.name ?? "Someone";

    // Resolve the meeting code for the Join link.
    const meeting = getMeetingById(meetingId);
    if (!meeting?.code) return;
    const joinUrl = `https://chat.bulldogops.com/m/${meeting.code}`;

    // Mark started + reminder_sent_at up-front (best-effort) so a concurrent
    // re-join doesn't double-fire.
    setScheduledCallStatus(call.id, "started");
    markReminderSent(call.id);

    // Pull every app-user invitee EXCEPT the starter themself — they're
    // already in the room. We don't push to phone/email-only invitees here;
    // those got SMS/email reminders earlier.
    const invitees = listInviteesForCall(call.id);
    const userIds = invitees
      .map((inv) => inv.userId)
      .filter((id): id is number => typeof id === "number" && id > 0 && id !== starterUserId);
    if (userIds.length === 0) return;

    await sendNotificationToUsers(userIds, {
      title: `${starterName} started “${call.title}”`,
      body: "Tap to join the meeting now.",
      url: joinUrl,
      tag: `meeting-started-${call.id}`,
    });

    // Also re-post the scheduled-call card as 'started' so the in-channel
    // card flips from "Scheduled" to "Started" with the live count. The
    // client-side renderer dedupes by scheduledCallId, so older cards for
    // the same meeting collapse into this one.
    if (call.channelId) {
      postScheduledCallCard(call, "scheduled_call.started").catch(() => {});
    }
  } catch (e) {
    console.warn("[scheduled-calls] notifyInviteesMeetingStarted failed:", (e as { message?: string })?.message ?? e);
  }
}

/* ─────────────────── In-channel RSVP card ─────────────────────────────── */
async function postScheduledCallCard(call: ScheduledCall, kind: ScheduledCallSystemMessageMeta["kind"]) {
  if (!call.channelId) return;
  const organizer = storage.getUser(call.organizerId);
  if (!organizer) return;
  const invitees = listInviteesForCall(call.id);
  // For the in-channel card the join URL is built per-recipient at render
  // time on the client (since each user can only redeem their own token).
  // We embed a placeholder URL bound to the organizer for now; the client
  // overrides via /api/scheduled-calls/:id/join-url on click.
  const placeholderUrl = buildJoinUrl(call, { ...invitees[0], userId: organizer.id } as ScheduledCallInvitee, organizer.name);

  // Build a snapshot invitee roster (excludes organizer — they're implicit yes).
  const inviteeSnapshot = invitees.map((inv) => {
    let name = "Guest";
    if (inv.userId) {
      const u = storage.getUser(inv.userId);
      name = u?.name ?? `User #${inv.userId}`;
    } else if (inv.externalEmail) {
      name = inv.externalEmail;
    } else if (inv.externalPhone) {
      // Mask phone: keep last 4 digits
      name = `...${inv.externalPhone.slice(-4)}`;
    }
    return { id: inv.id, name, response: inv.response as "pending" | "yes" | "no" | "maybe" };
  });

  // Resolve the linked meeting's stable code so client cards can build a
  // /m/<code> deep link and (for 'started' cards) poll the live participant
  // count via /api/meetings/<code>/participants. The link is set when the
  // scheduled_call was mirrored into the meetings table.
  let meetingCode: string | null = null;
  try {
    const raw = rawDb
      .prepare("SELECT meeting_id FROM scheduled_calls WHERE id = ?")
      .get(call.id) as { meeting_id?: string | null } | undefined;
    if (raw?.meeting_id) {
      const meeting = getMeetingById(raw.meeting_id);
      if (meeting?.code) meetingCode = meeting.code;
    }
  } catch {
    /* best-effort */
  }

  const meta: ScheduledCallSystemMessageMeta & { callTitle: string; meetingCode: string | null } = {
    system: true,
    kind,
    scheduledCallId: call.id,
    // Both `title` (server canonical) and `callTitle` (client API surface)
    // are emitted so older + newer renderers find the title in the meta.
    // The client UI reads `meta.callTitle` (see ApiScheduledCallSystemMessageMeta).
    title: call.title,
    callTitle: call.title,
    startAt: call.startAt.getTime(),
    endAt: call.endAt.getTime(),
    callKind: call.kind,
    organizerId: call.organizerId,
    inviteeCount: invitees.length,
    joinUrl: placeholderUrl,
    meetingCode,
    teamsJoinUrl: call.teamsJoinUrl ?? null,
    provider: (call.provider as "bulldog" | "both" | "teams") ?? "both",
    invitees: inviteeSnapshot,
  };
  const content =
    kind === "scheduled_call.created"   ? `${organizer.name} scheduled "${call.title}" for ${formatWhenLabel(call.startAt)}` :
    kind === "scheduled_call.updated"   ? `${organizer.name} updated "${call.title}"` :
    kind === "scheduled_call.cancelled" ? `${organizer.name} cancelled "${call.title}"` :
                                          `"${call.title}" is starting now`;
  try {
    const msg = storage.createMessage({
      channelId: call.channelId,
      userId: call.organizerId,
      content,
      meta: JSON.stringify(meta),
    });
    const wire: any = {
      ...msg,
      meta,
      authorName: organizer.name,
      authorHue: (organizer as any).hue ?? 220,
      authorRole: organizer.role,
      authorInitials: organizer.name.slice(0, 2).toUpperCase(),
      reactions: [],
      attachmentsList: [],
      mentions: [],
      replyCount: 0,
      lastReplyAt: null,
    };
    emitMessageNew(call.orgId, wire);
  } catch (e) {
    console.warn("[scheduled-calls] post card failed:", e);
  }
}

/* ─────────────────────────── HTTP routes ──────────────────────────────── */
export function registerScheduledCallRoutes(app: Express) {
  // List meetings visible to the caller (organizer of, invitee of, or admin
  // anywhere in the org).
  app.get("/api/scheduled-calls", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const me = storage.getUser(u.id);
    const fromParam = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 24 * 3600 * 1000);
    const toParam = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const all = listScheduledCallsForOrg(u.orgId, { from: fromParam, to: toParam });
    const isAdmin = me?.role === "admin";
    const visible = all.filter((c) => {
      if (isAdmin) return true;
      if (c.organizerId === u.id) return true;
      const invs = listInviteesForCall(c.id);
      return invs.some((i) => i.userId === u.id);
    });
    res.json({
      calls: visible.map((c) => {
        // Resolve meetingCode from the linked meetings row (via meeting_id FK).
        let meetingCode: string | null = null;
        try {
          const raw = rawDb.prepare("SELECT meeting_id FROM scheduled_calls WHERE id = ?").get(c.id) as { meeting_id?: string | null } | undefined;
          if (raw?.meeting_id) {
            const meeting = getMeetingById(raw.meeting_id);
            meetingCode = meeting?.code ?? null;
          }
        } catch { /* best-effort */ }
        return {
          ...c,
          startAt: c.startAt.getTime(),
          endAt: c.endAt.getTime(),
          reminderSentAt: c.reminderSentAt?.getTime() ?? null,
          createdAt: c.createdAt.getTime(),
          updatedAt: c.updatedAt.getTime(),
          meetingCode,
          invitees: listInviteesForCall(c.id).map((i) => ({
            id: i.id,
            userId: i.userId,
            externalPhone: i.externalPhone,
            externalEmail: i.externalEmail,
            response: i.response,
            // intentionally not returning rsvpCode here — it's only embedded in the SMS
          })),
        };
      }),
    });
  });

  // Create a new meeting. Body: { channelId?, title, notes?, kind?, startAt (ISO), endAt (ISO),
  //   userIds?: number[], phones?: string[], emails?: string[] }.
  app.post("/api/scheduled-calls", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const me = storage.getUser(u.id);
    if (!me) return res.status(401).json({ message: "Unknown user" });
    const body = req.body ?? {};
    const title = String(body.title || "").trim();
    if (!title) return res.status(400).json({ message: "title required" });
    if (title.length > 200) return res.status(400).json({ message: "title too long" });
    const startAt = body.startAt ? new Date(body.startAt) : null;
    const endAt = body.endAt ? new Date(body.endAt) : null;
    if (!startAt || isNaN(startAt.getTime())) return res.status(400).json({ message: "startAt invalid" });
    if (!endAt || isNaN(endAt.getTime())) return res.status(400).json({ message: "endAt invalid" });
    if (endAt.getTime() <= startAt.getTime()) return res.status(400).json({ message: "endAt must be after startAt" });
    if (startAt.getTime() < Date.now() - 60_000) return res.status(400).json({ message: "startAt is in the past" });

    // Channel is OPTIONAL. If a channelId is provided but the channel is gone
    // (deleted, stale prop from the client, or never existed), silently fall
    // back to "no channel" rather than 404-ing the whole creation. The
    // meeting itself doesn't depend on a channel — the channel only governs
    // where the in-channel RSVP card gets posted. The 403 (not a member)
    // check is still strict because that's a real permission violation.
    let channelId: number | null = null;
    const rawChannelId = body.channelId;
    if (rawChannelId !== undefined && rawChannelId !== null && rawChannelId !== "" && rawChannelId !== 0) {
      const parsed = Number(rawChannelId);
      if (Number.isFinite(parsed) && parsed > 0) {
        const ch = storage.getChannel(parsed);
        if (ch) {
          const isMember = storage.isChannelMember(parsed, u.id);
          if (!isMember && me.role !== "admin") {
            return res.status(403).json({ message: "not a member of that channel" });
          }
          // Multi-tenant: even if isChannelMember/admin passes, region scope must match.
          if (!mtCanSeeChannel((req as AuthedRequest).access, ch.projectId, ch.regionId ?? null)) {
            return res.status(404).json({ message: "channel not found" });
          }
          channelId = parsed;
        } else {
          console.warn(`[scheduled-calls] ignoring stale channelId=${parsed} (channel not found)`);
        }
      }
    }

    const kind = body.kind === "voice" ? "voice" : "video";
    // MVP scope decision (2026-07-06): Bulldog Meet only. The Teams bridging
    // feature is parked until the MediaWorker media plane is finished. Any
    // non-"bulldog" provider from the client is coerced back to "bulldog"
    // unless TEAMS_BRIDGING_ENABLED is explicitly set. See
    // memory/knowledge/projects/bulldog-meeting-bridge.md.
    const teamsBridgingEnabled =
      String(process.env.TEAMS_BRIDGING_ENABLED ?? "false").toLowerCase() === "true";
    const rawProvider: "bulldog" | "both" | "teams" =
      body.provider === "bulldog" || body.provider === "teams" || body.provider === "both"
        ? body.provider
        : "bulldog";
    const provider: "bulldog" | "both" | "teams" = teamsBridgingEnabled
      ? rawProvider
      : "bulldog";
    const userIds = Array.isArray(body.userIds)
      ? Array.from(new Set((body.userIds as unknown[]).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)))
      : [];
    const phones = Array.isArray(body.phones)
      ? (body.phones as unknown[]).map((p) => String(p)).filter(Boolean)
      : [];
    const emails = Array.isArray(body.emails)
      ? (body.emails as unknown[]).map((e) => String(e)).filter(Boolean)
      : [];

    if (userIds.length + phones.length + emails.length === 0) {
      return res.status(400).json({ message: "at least one invitee required" });
    }

    const call = createScheduledCallRow({
      orgId: u.orgId,
      channelId,
      organizerId: u.id,
      title,
      notes: body.notes ? String(body.notes).slice(0, 4000) : null,
      kind,
      provider,
      startAt,
      endAt,
      inviteeUserIds: userIds,
      externalPhones: phones,
      externalEmails: emails,
    });
    const invitees = createInvitees(call, {
      orgId: u.orgId,
      channelId,
      organizerId: u.id,
      title,
      notes: null,
      kind,
      startAt,
      endAt,
      inviteeUserIds: userIds,
      externalPhones: phones,
      externalEmails: emails,
    });

    // Best-effort: create a parallel Microsoft Teams online meeting so invites
    // can offer a Teams join link alongside the Bulldog link. If MS Graph is
    // not configured or the call fails, createTeamsMeeting returns null and we
    // continue with the Bulldog-only flow — scheduling must never fail because
    // Teams is unavailable. We do this before dispatch so the link is present
    // in the very first invite email.
    // Teams bridging is opt-in via TEAMS_BRIDGING_ENABLED (see above). When
    // disabled, provider is coerced to "bulldog" so this block never fires.
    if (teamsBridgingEnabled && call.provider !== "bulldog") {
      try {
        // Organizer resolution (GUID > email > admin@bulldogops.com default)
        // lives entirely in createTeamsMeeting via MS_GRAPH_DEFAULT_ORGANIZER_ID
        // and MS_GRAPH_DEFAULT_ORGANIZER env vars — no need to pass overrides.
        const teams = await createTeamsMeeting({
          subject: call.title,
          startUtc: call.startAt,
          endUtc: call.endAt,
        });
        if (teams) {
          setTeamsMeeting(call.id, teams.joinUrl, teams.meetingId);
          call.teamsJoinUrl = teams.joinUrl;
          call.teamsMeetingId = teams.meetingId;
          // Dispatch the Bulldog Bridge in the background so an external
          // Teams guest joining via `teams.joinUrl` is joined by a bridge
          // bot that relays their audio/video into the LiveKit room. Fire-
          // and-forget: dispatch failures fall back to two parallel rooms.
          void dispatchBridgeForScheduledCall(call, teams.joinUrl, teams.meetingId);
        }
      } catch (e) {
        console.warn("[scheduled-calls] teams meeting create error:", e);
      }
    }

    // Post an in-channel RSVP card if bound to a channel.
    if (channelId) await postScheduledCallCard(call, "scheduled_call.created");

    // Fan out SMS in the background; don't make the user wait.
    dispatchInvites(call).catch((e) => console.warn("[scheduled-calls] dispatch error:", e));

    // Cross-app: emit meeting_invite to Bulldog Ops for chat-user invitees
    // (keyed on email). Ops applies its own consent gate + toggles + escalation.
    // External phone/email invitees already get the chat-side SMS above. The
    // chat link is included; ops shortens it. Fire-and-forget.
    if (userIds.length > 0) {
      const when = new Date(call.startAt).toLocaleString();
      const recipients = storage.listUsersByIds(userIds)
        .filter((m) => !!m.email)
        .map((m) => ({ email: m.email }));
      emitOpsNotifications(recipients, {
        eventType: "meeting_invite",
        message: `Bulldog Chat: ${me.name} invited you to "${call.title}" on ${when}.`,
        linkUrl: `${CHAT_BASE_URL.replace(/\/$/, "")}/?meeting=${call.id}`,
        payload: { scheduledCallId: call.id, title: call.title, startAt: call.startAt.getTime() },
      }).catch((e) => console.warn("[scheduled-calls] ops emit failed:", e));
    }

    res.status(201).json({
      call: { ...call, startAt: call.startAt.getTime(), endAt: call.endAt.getTime() },
      invitees: invitees.map((i) => ({
        id: i.id, userId: i.userId,
        externalPhone: i.externalPhone, externalEmail: i.externalEmail,
        response: i.response,
      })),
    });
  });

  // RSVP from in-app card. Body: { response: 'yes'|'no'|'maybe' }.
  app.post("/api/scheduled-calls/:id/rsvp", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const callId = Number(req.params.id);
    const response = req.body?.response;
    if (!["yes", "no", "maybe"].includes(response)) return res.status(400).json({ message: "response invalid" });
    const call = getScheduledCall(callId);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "not found" });
    const inv = rawDb.prepare(`
      SELECT * FROM scheduled_call_invitees
      WHERE scheduled_call_id = ? AND user_id = ?
    `).get(callId, u.id) as any;
    // Organizer is implicitly yes — they have no invitee row.
    if (!inv) {
      if (call.organizerId === u.id) {
        return res.json({ ok: true, response, organizer: true });
      }
      return res.status(404).json({ message: "not an invitee" });
    }
    setRsvp(inv.id, response as RsvpResponse, "in_app");
    res.json({ ok: true, response });
  });

  // Cancel a meeting. Only organizer or admin can.
  app.post("/api/scheduled-calls/:id/cancel", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const me = storage.getUser(u.id);
    const callId = Number(req.params.id);
    const call = getScheduledCall(callId);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "not found" });
    if (call.organizerId !== u.id && me?.role !== "admin") return res.status(403).json({ message: "not allowed" });
    setScheduledCallStatus(call.id, "cancelled");
    if (call.channelId) await postScheduledCallCard({ ...call, status: "cancelled" }, "scheduled_call.cancelled");
    res.json({ ok: true });
  });

  // Hard delete a scheduled call. Removes invitees + the call row. The
  // organizer or any admin can delete. We delete invitees first because
  // they FK -> scheduled_calls.
  app.delete("/api/scheduled-calls/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const me = storage.getUser(u.id);
    const callId = Number(req.params.id);
    const call = getScheduledCall(callId);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "not found" });
    if (call.organizerId !== u.id && me?.role !== "admin") return res.status(403).json({ message: "not allowed" });
    try {
      // Find every system-message card that references this scheduled call
      // (created / updated / cancelled / started) so we can delete them and
      // notify live clients to drop them from the channel + jobs feed.
      const cards = rawDb.prepare(
        `SELECT id, channel_id FROM messages
         WHERE meta IS NOT NULL
           AND CAST(json_extract(meta, '$.scheduledCallId') AS INTEGER) = ?`,
      ).all(callId) as Array<{ id: number; channel_id: number }>;
      console.log(`[scheduled-calls] delete call=${callId} found ${cards.length} cards`);
      rawDb.prepare(`DELETE FROM scheduled_call_invitees WHERE scheduled_call_id = ?`).run(callId);
      rawDb.prepare(`DELETE FROM scheduled_calls WHERE id = ?`).run(callId);
      for (const c of cards) {
        try {
          rawDb.prepare(`DELETE FROM message_mentions WHERE message_id = ?`).run(c.id);
          rawDb.prepare(`DELETE FROM reactions WHERE message_id = ?`).run(c.id);
        } catch (_) {}
        rawDb.prepare(`DELETE FROM messages WHERE id = ?`).run(c.id);
        try { emitMessageDelete(u.orgId, { channelId: c.channel_id, messageId: c.id }); } catch (_) {}
      }
      res.json({ ok: true, deleted: callId, cardsRemoved: cards.length });
    } catch (err: any) {
      console.error("[delete-scheduled-call]", err);
      res.status(500).json({ message: "failed to delete meeting" });
    }
  });

  // Per-user join URL for a meeting. Returns the tokenized /call-join URL
  // bound to the caller's user id. Used by the in-channel RSVP card.
  app.get("/api/scheduled-calls/:id/join-url", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const callId = Number(req.params.id);
    const call = getScheduledCall(callId);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "not found" });
    const me = storage.getUser(u.id);
    const organizer = storage.getUser(call.organizerId);
    const isInvitee = rawDb.prepare(
      "SELECT 1 FROM scheduled_call_invitees WHERE scheduled_call_id = ? AND user_id = ?"
    ).get(callId, u.id);
    if (!isInvitee && call.organizerId !== u.id && me?.role !== "admin") {
      return res.status(403).json({ message: "not an invitee" });
    }
    const url = buildJoinUrl(
      call,
      { userId: u.id } as ScheduledCallInvitee,
      organizer?.name || "Bulldog",
    );
    res.json({ url });
  });

  // ICS download. Public-ish: requires the scheduled-call id + a per-invitee
  // rsvp_code as the auth (so anyone with the SMS code can re-download).
  app.get("/api/scheduled-calls/:id/ics", (req, res) => {
    const callId = Number(req.params.id);
    const code = String(req.query.code || "").toUpperCase();
    const call = getScheduledCall(callId);
    if (!call) return res.status(404).send("Not found");
    if (!code) return res.status(400).send("Missing code");
    const invitees = listInviteesForCall(callId);
    const inv = invitees.find((i) => i.rsvpCode === code);
    if (!inv) return res.status(403).send("Invalid code");
    const organizer = storage.getUser(call.organizerId);
    if (!organizer) return res.status(500).send("Organizer missing");
    // Build the .ics with attendee emails of all chat-user invitees +
    // external emails. Phone-only invitees are omitted from ATTENDEE: a
    // .ics can't reach them anyway.
    const attendeeEmails: string[] = [];
    for (const i of invitees) {
      if (i.userId) {
        const u = storage.getUser(i.userId);
        if (u?.email) attendeeEmails.push(u.email);
      } else if (i.externalEmail) {
        attendeeEmails.push(i.externalEmail);
      }
    }
    const joinUrl = buildJoinUrl(call, inv, organizer.name);
    const ics = buildIcsForScheduledCall({
      uid: `bulldog-${call.id}@bulldogops.com`,
      title: call.title,
      description:
        (call.notes ? call.notes + "\n\n" : "") +
        `Join via Bulldog: ${joinUrl}\n` +
        (call.teamsJoinUrl ? `Join via Teams: ${call.teamsJoinUrl}\n` : "") +
        `Organizer: ${organizer.name}`,
      startUtc: call.startAt,
      endUtc: call.endAt,
      organizerEmail: organizer.email,
      organizerName: organizer.name,
      attendeeEmails,
      joinUrl,
      sequence: call.icsSequence,
      method: call.status === "cancelled" ? "CANCEL" : "REQUEST",
    });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bulldog-call-${call.id}.ics"`);
    res.send(ics);
  });

  // Twilio inbound SMS webhook. Twilio POSTs application/x-www-form-urlencoded
  // with From (E.164), Body, and an X-Twilio-Signature header. We parse the
  // RSVP, find the most recent invitee row for that phone with a matching
  // code, and update the response.
  app.post("/api/sms/inbound", async (req, res) => {
    const sig = req.headers["x-twilio-signature"] as string | undefined;
    const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
    const url = `${proto}://${host}${req.originalUrl}`;
    // Twilio sends form-encoded; Express only parses if the bodyParser is set
    // up for that. We support both shapes.
    const params: Record<string, string> = {};
    for (const k of Object.keys(req.body ?? {})) params[k] = String((req.body as any)[k]);
    if (!verifyTwilioSignature({ signature: sig, url, params })) {
      console.warn("[sms/inbound] signature mismatch");
      return res.status(403).type("text/xml").send("<Response/>");
    }
    const from = String(params.From || "").trim();
    const body = String(params.Body || "");
    const parsed = parseRsvpSms(body);
    const parseFailReply =
      "Sorry, we couldn't process that RSVP. Reply with the format: <code> Y/N/M (e.g., B38B Y)";
    if (!from || !parsed) {
      return res.type("text/xml").send(
        `<Response><Message>${parseFailReply}</Message></Response>`
      );
    }
    // Find invitees with this rsvp_code whose phone (either chat-user phone
    // or external_phone) matches `from` and whose call is in the next 7 days.
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const rows = rawDb.prepare(`
      SELECT sci.*, sc.start_at, sc.title, sc.organizer_id, sc.id AS call_id
      FROM scheduled_call_invitees sci
      JOIN scheduled_calls sc ON sc.id = sci.scheduled_call_id
      WHERE sci.rsvp_code = ? AND sc.end_at >= ?
      ORDER BY sc.start_at ASC
    `).all(parsed.code, cutoff) as any[];
    let matched: any | null = null;
    for (const r of rows) {
      const phone =
        r.external_phone ||
        (r.user_id ? (storage.getUser(r.user_id)?.phone ?? null) : null);
      const candidate = normalizeE164(phone);
      if (candidate && candidate === normalizeE164(from)) { matched = r; break; }
    }
    if (!matched) {
      return res.type("text/xml").send(
        `<Response><Message>${parseFailReply}</Message></Response>`
      );
    }
    setRsvp(matched.id, parsed.response, "sms");
    // Confirm back via an outbound SMS (best-effort). We reply with an empty
    // TwiML body so the recipient gets exactly one confirmation message.
    const phrase =
      parsed.response === "yes" ? `attending "${matched.title}"` :
      parsed.response === "no" ? `declined for "${matched.title}"` :
      `maybe for "${matched.title}"`;
    const whenLabel = formatWhenLabel(new Date(matched.start_at * 1000));
    const confirmBody = `Got it \u2014 you're marked as ${phrase} on ${whenLabel}.`;
    try {
      const replyTo = normalizeE164(from);
      if (replyTo && smsAvailable()) {
        await sendSms({ to: replyTo, body: confirmBody });
      }
    } catch (e) {
      console.warn("[sms/inbound] confirmation reply failed:", e);
    }
    return res.type("text/xml").send("<Response/>");
  });

  // RSVP-only confirmation route — records the response WITHOUT joining the
  // meeting, then renders a server-side confirmation page. The token is the
  // per-invitee short-link token (same one /j/:token redeems for joining), so
  // /r/<token> and /j/<token> share identity but do different things:
  //   /j/<token> → join-and-redirect into the LiveKit room
  //   /r/<token> → record RSVP + show confirmation page (no room drop)
  // GET /r/:token?response=yes|no|maybe
  app.get("/r/:token", (req, res) => {
    const token = String(req.params.token || "");
    const response = String(req.query.response || "").toLowerCase();
    const row = rawDb.prepare(
      "SELECT * FROM scheduled_call_invitees WHERE short_link_token = ?"
    ).get(token) as any;
    if (!row) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(renderRsvpErrorPage("This RSVP link is invalid or has expired."));
    }
    const inv = rowToInvitee(row);
    const call = getScheduledCall(inv.scheduledCallId);
    if (!call) {
      res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(renderRsvpErrorPage("This meeting could not be found."));
    }
    if (!["yes", "no", "maybe"].includes(response)) {
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(renderRsvpErrorPage(
        "Please click one of the RSVP buttons (Yes, No, or Maybe) in your invitation email."
      ));
    }
    setRsvp(inv.id, response as RsvpResponse, "web");
    const whenLabel = formatWhenLabel(call.startAt);
    const icsUrl = `${CHAT_BASE_URL}/api/scheduled-calls/${call.id}/ics?code=${encodeURIComponent(inv.rsvpCode)}`;
    const meetingsUrl = `${CHAT_BASE_URL}/meetings`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderRsvpConfirmationPage({
      title: call.title,
      whenLabel,
      response: response as RsvpResponse,
      icsUrl,
      meetingsUrl,
      teamsJoinUrl: call.teamsJoinUrl ?? null,
    }));
  });

  // Public RSVP page — no login required; rsvp_code is the auth token.
  // GET /api/scheduled-calls/:id/rsvp-public?code=<rsvpCode>&response=<yes|no|maybe>
  app.get("/api/scheduled-calls/:id/rsvp-public", (req, res) => {
    const callId = Number(req.params.id);
    const code = String(req.query.code || "").toUpperCase();
    const response = String(req.query.response || "").toLowerCase();
    if (!["yes", "no", "maybe"].includes(response)) {
      return res.status(400).send("Invalid response. Use yes, no, or maybe.");
    }
    const call = getScheduledCall(callId);
    if (!call) return res.status(404).send("Meeting not found.");
    if (!code) return res.status(400).send("Missing code.");
    const invitees = listInviteesForCall(callId);
    const inv = invitees.find((i) => i.rsvpCode === code);
    if (!inv) return res.status(403).send("Invalid RSVP code.");
    setRsvp(inv.id, response as RsvpResponse, "web");
    const organizer = storage.getUser(call.organizerId);
    const whenLabel = formatWhenLabel(call.startAt);
    const channelUrl = call.channelId
      ? `${CHAT_BASE_URL}/channel/${call.channelId}`
      : CHAT_BASE_URL;
    const responseLabel = response === "yes" ? "Yes" : response === "no" ? "No" : "Maybe";
    const responseColor = response === "yes" ? "#238636" : response === "no" ? "#b91c1c" : "#92400e";
    const escH = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RSVP Recorded — Bulldog Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 440px; width: 100%; background: #161b22; border: 1px solid #30363d;
            border-radius: 12px; padding: 32px 28px; text-align: center; }
    .badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-weight: 700;
             font-size: 14px; color: #fff; margin-bottom: 20px; background: ${responseColor}; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .meeting { font-size: 16px; font-weight: 600; color: #58a6ff; margin-bottom: 4px; }
    .when { font-size: 13px; color: #8b949e; margin-bottom: 24px; }
    a.btn { display: inline-block; padding: 10px 24px; background: #1f6feb; color: #fff;
            border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
    a.btn:hover { background: #388bfd; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${escH(responseLabel)}</div>
    <h1>RSVP Recorded</h1>
    <div class="meeting">${escH(call.title)}</div>
    <div class="when">${escH(whenLabel)}</div>
    <a class="btn" href="${escH(channelUrl)}">Open Bulldog Chat</a>
  </div>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  // Live invitee list for a scheduled call. Requires auth, scoped to org.
  // GET /api/scheduled-calls/:id/invitees
  app.get("/api/scheduled-calls/:id/invitees", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const callId = Number(req.params.id);
    const call = getScheduledCall(callId);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "not found" });
    const me = storage.getUser(u.id);
    const isInvitee = rawDb.prepare(
      "SELECT 1 FROM scheduled_call_invitees WHERE scheduled_call_id = ? AND user_id = ?"
    ).get(callId, u.id);
    if (!isInvitee && call.organizerId !== u.id && me?.role !== "admin") {
      return res.status(403).json({ message: "not an invitee" });
    }
    const invitees = listInviteesForCall(callId);
    const result = invitees.map((inv) => {
      let name = "Guest";
      if (inv.userId) {
        const usr = storage.getUser(inv.userId);
        name = usr?.name ?? `User #${inv.userId}`;
      } else if (inv.externalEmail) {
        name = inv.externalEmail;
      } else if (inv.externalPhone) {
        name = `...${inv.externalPhone.slice(-4)}`;
      }
      return { id: inv.id, name, response: inv.response };
    });
    res.json({ invitees: result });
  });
}
