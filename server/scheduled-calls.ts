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
import { emitMessageNew } from "./events";
import { requireAuth, type AuthedRequest } from "./auth";
import type { ScheduledCall, ScheduledCallInvitee, ScheduledCallSystemMessageMeta, RsvpResponse } from "@shared/schema";

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
  return rowToScheduledCall(row);
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
  });
  return `${CHAT_BASE_URL}/call-join?t=${encodeURIComponent(token)}`;
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

/* ─────────────────── Dispatch (send invite SMSes) ─────────────────────── */
async function dispatchInvites(call: ScheduledCall): Promise<void> {
  const organizer = storage.getUser(call.organizerId);
  if (!organizer) return;
  const invitees = listInviteesForCall(call.id);
  const whenLabel = formatWhenLabel(call.startAt);
  for (const inv of invitees) {
    if (inv.inviteSentAt) continue; // already sent
    let phone: string | null = null;
    if (inv.userId) {
      const u = storage.getUser(inv.userId);
      phone = normalizeE164(u?.phone);
    } else if (inv.externalPhone) {
      phone = normalizeE164(inv.externalPhone);
    }
    if (!phone) {
      markInviteSent(inv.id, "no phone");
      continue;
    }
    if (!smsAvailable()) {
      markInviteSent(inv.id, "SMS not configured");
      continue;
    }
    const joinUrl = buildJoinUrl(call, inv, organizer.name);
    const body = buildScheduledCallSmsBody({
      organizerName: organizer.name,
      title: call.title,
      whenLabel,
      joinUrl,
      rsvpCode: `#${inv.rsvpCode}`,
    });
    try {
      const res = await sendSms({ to: phone, body });
      if (res.ok) markInviteSent(inv.id, null);
      else markInviteSent(inv.id, res.error || "unknown");
    } catch (e: any) {
      markInviteSent(inv.id, e?.message ?? "exception");
    }
  }
}

/* ─────────────────── Reminder loop (in-process) ───────────────────────── */
async function dispatchReminders() {
  // Find calls starting in the next ~6 minutes that haven't been reminded yet.
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + 6 * 60;
  const rows = rawDb.prepare(`
    SELECT * FROM scheduled_calls
    WHERE status = 'scheduled'
      AND reminder_sent_at IS NULL
      AND start_at <= ?
      AND start_at > ?
  `).all(horizon, now) as any[];
  for (const r of rows) {
    const call = rowToScheduledCall(r);
    const organizer = storage.getUser(call.organizerId);
    if (!organizer) continue;
    const invitees = listInviteesForCall(call.id);
    for (const inv of invitees) {
      if (inv.reminderSentAt) continue;
      if (inv.response === "no") continue; // don't pester declines
      let phone: string | null = null;
      if (inv.userId) {
        const u = storage.getUser(inv.userId);
        phone = normalizeE164(u?.phone);
      } else if (inv.externalPhone) {
        phone = normalizeE164(inv.externalPhone);
      }
      if (!phone || !smsAvailable()) {
        markInviteeReminderSent(inv.id);
        continue;
      }
      const joinUrl = buildJoinUrl(call, inv, organizer.name);
      const minutes = Math.max(1, Math.round((call.startAt.getTime() - Date.now()) / 60000));
      const body = buildReminderSmsBody({ title: call.title, minutesUntilStart: minutes, joinUrl });
      try {
        await sendSms({ to: phone, body });
      } catch (e) { /* best-effort */ }
      markInviteeReminderSent(inv.id);
    }
    markReminderSent(call.id);
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
      calls: visible.map((c) => ({
        ...c,
        startAt: c.startAt.getTime(),
        endAt: c.endAt.getTime(),
        reminderSentAt: c.reminderSentAt?.getTime() ?? null,
        createdAt: c.createdAt.getTime(),
        updatedAt: c.updatedAt.getTime(),
        invitees: listInviteesForCall(c.id).map((i) => ({
          id: i.id,
          userId: i.userId,
          externalPhone: i.externalPhone,
          externalEmail: i.externalEmail,
          response: i.response,
          // intentionally not returning rsvpCode here — it's only embedded in the SMS
        })),
      })),
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

    // Post an in-channel RSVP card if bound to a channel.
    if (channelId) await postScheduledCallCard(call, "scheduled_call.created");

    // Fan out SMS in the background; don't make the user wait.
    dispatchInvites(call).catch((e) => console.warn("[scheduled-calls] dispatch error:", e));

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
    const inv = rawDb.prepare(`
      SELECT * FROM scheduled_call_invitees
      WHERE scheduled_call_id = ? AND user_id = ?
    `).get(callId, u.id) as any;
    if (!inv) return res.status(404).json({ message: "not an invitee" });
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
        `Join: ${joinUrl}\nOrganizer: ${organizer.name}`,
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
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
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
      `<Response><Message>Got it — you replied ${word} to "${matched.title}". Thanks.</Message></Response>`
    );
  });
}
