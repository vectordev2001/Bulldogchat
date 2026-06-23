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
import { sendEmail, isEmailConfigured, emailFromAddress, emailFromName } from "./email";
import { sendNotificationToUsers } from "./push";
import { createTeamsMeeting } from "./teams/createMeeting";
import { emitOpsNotifications } from "./notify-ops";
import type { ScheduledCall, ScheduledCallInvitee, ScheduledCallSystemMessageMeta, RsvpResponse } from "@shared/schema";
import { getMeetingById } from "./storage/meetings";

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
        (org_id, channel_id, organizer_id, title, notes, kind, start_at, end_at,
         room_name, status, ics_sequence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)
    `).run(
      input.orgId,
      input.channelId,
      input.organizerId,
      input.title,
      input.notes,
      input.kind,
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
}

function markInviteSent(inviteeId: number, err: string | null) {
  const now = Math.floor(Date.now() / 1000);
  if (err) {
    rawDb.prepare("UPDATE scheduled_call_invitees SET invite_error = ? WHERE id = ?").run(err.slice(0, 500), inviteeId);
  } else {
    rawDb.prepare("UPDATE scheduled_call_invitees SET invite_sent_at = ?, invite_error = NULL WHERE id = ?").run(now, inviteeId);
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
    const rsvpBase = `${CHAT_BASE_URL}/api/scheduled-calls/${call.id}/rsvp-public?code=${inv.rsvpCode}`;
    const rsvpYesUrl    = `${rsvpBase}&response=yes`;
    const rsvpNoUrl     = `${rsvpBase}&response=no`;
    const rsvpMaybeUrl  = `${rsvpBase}&response=maybe`;
    const channelUrl    = call.channelId ? `${CHAT_BASE_URL}/channel/${call.channelId}` : CHAT_BASE_URL;

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
        const subject = `${organizer.name} invited you to "${call.title}" — ${whenLabel}`;
        const textBody = [
          `${organizer.name} has scheduled a ${call.kind} call: "${call.title}"`,
          `When: ${whenLabel}`,
          ``,
          `Choose your preferred way to join:`,
          `Join via Bulldog: ${joinShortUrl}`,
          ...(call.teamsJoinUrl ? [`Join via Teams:   ${call.teamsJoinUrl}`] : []),
          ``,
          `RSVP:`,
          `  Yes    → ${rsvpYesUrl}`,
          `  No     → ${rsvpNoUrl}`,
          `  Maybe  → ${rsvpMaybeUrl}`,
        ].join("\n");

        const htmlBody = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:24px;">
<h2 style="color:#58a6ff;margin-top:0">${escH(call.title)}</h2>
<p><strong>Organizer:</strong> ${escH(organizer.name)}<br/>
<strong>When:</strong> ${escH(whenLabel)}</p>
<p style="margin-bottom:6px;font-size:13px;color:#8b949e;">Choose your preferred way to join:</p>
<p style="margin-top:0"><a href="${escH(joinShortUrl)}" style="display:inline-block;padding:10px 20px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Join via Bulldog</a>${
  call.teamsJoinUrl
    ? `<br/><a href="${escH(call.teamsJoinUrl)}" style="display:inline-block;padding:10px 20px;background:#5b5fc7;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;margin-top:8px;">Join via Microsoft Teams</a>`
    : ""
}</p>
<p style="margin-top:16px"><strong>RSVP:</strong></p>
<p>
  <a href="${escH(rsvpYesUrl)}" style="display:inline-block;margin-right:8px;padding:8px 16px;background:#238636;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Yes</a>
  <a href="${escH(rsvpNoUrl)}" style="display:inline-block;margin-right:8px;padding:8px 16px;background:#b91c1c;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">No</a>
  <a href="${escH(rsvpMaybeUrl)}" style="display:inline-block;padding:8px 16px;background:#92400e;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Maybe</a>
</p>
<p style="margin-top:24px;font-size:12px;color:#8b949e;">You received this because you were invited to a Bulldog Chat meeting.</p>
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
        } else {
          errors.push(`email: ${res.reason ?? "unknown"}`);
          console.warn(`[scheduled-calls] email invite failed for inv ${inv.id}:`, res.reason);
        }
      } catch (e: any) {
        errors.push(`email: ${e?.message ?? "exception"}`);
        console.warn(`[scheduled-calls] email invite exception for inv ${inv.id}:`, e);
      }
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
      const smsBody = buildScheduledCallSmsBody({
        organizerName: organizer.name,
        title: call.title,
        whenLabel,
        joinUrl,
        rsvpCode: `#${inv.rsvpCode}`,
        shortUrl,
      });
      try {
        const res = await sendSms({ to: smsTo, body: smsBody });
        if (res.ok) {
          smsSent = true;
        } else {
          errors.push(`sms: ${res.error ?? "unknown"}`);
        }
      } catch (e: any) {
        errors.push(`sms: ${e?.message ?? "exception"}`);
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
    const channelUrl = call.channelId ? `/channel/${call.channelId}` : "/";

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
    dispatchReminders().catch((e) => console.warn("[scheduled-calls] reminder loop error:", e));
  }, 60 * 1000); // every 60s
  console.log("[scheduled-calls] reminder loop started (60s tick)");
}
export function stopReminderLoop() {
  if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
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

  const meta: ScheduledCallSystemMessageMeta = {
    system: true,
    kind,
    scheduledCallId: call.id,
    title: call.title,
    startAt: call.startAt.getTime(),
    endAt: call.endAt.getTime(),
    callKind: call.kind,
    organizerId: call.organizerId,
    inviteeCount: invitees.length,
    joinUrl: placeholderUrl,
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

    const channelId = body.channelId ? Number(body.channelId) : null;
    if (channelId) {
      const ch = storage.getChannel(channelId);
      if (!ch) return res.status(404).json({ message: "channel not found" });
      // Permission: only members of the channel can schedule into it.
      const isMember = storage.isChannelMember(channelId, u.id);
      if (!isMember && me.role !== "admin") return res.status(403).json({ message: "not a member of that channel" });
    }

    const kind = body.kind === "voice" ? "voice" : "video";
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
    try {
      const teams = await createTeamsMeeting({
        subject: call.title,
        startUtc: call.startAt,
        endUtc: call.endAt,
        organizerEmail: process.env.MS_GRAPH_DEFAULT_ORGANIZER?.trim() || "admin@bulldogops.com",
      });
      if (teams) {
        setTeamsMeeting(call.id, teams.joinUrl, teams.meetingId);
        call.teamsJoinUrl = teams.joinUrl;
        call.teamsMeetingId = teams.meetingId;
      }
    } catch (e) {
      console.warn("[scheduled-calls] teams meeting create error:", e);
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
    if (!from || !parsed) {
      // Respond politely so users replying random text aren't confused.
      return res.type("text/xml").send(
        "<Response><Message>Reply with your code + Y, N, or M (e.g. \"#A4F9 Y\"). Need help? Reply HELP.</Message></Response>"
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
        `<Response><Message>We couldn't find an invite with code #${parsed.code} for this number. Reply HELP to talk to the organizer.</Message></Response>`
      );
    }
    setRsvp(matched.id, parsed.response, "sms");
    const word = parsed.response === "yes" ? "YES" : parsed.response === "no" ? "NO" : "MAYBE";
    return res.type("text/xml").send(
      `<Response><Message>Got it \u2014 you replied ${word} to "${matched.title}". Thanks.</Message></Response>`
    );
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
