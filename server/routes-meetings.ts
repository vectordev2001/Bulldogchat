import type { Express, Request, Response } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { requireAuth, tryAuth, AuthedRequest } from "./auth";
import { gateChannelById } from "./multitenant-access";
import { livekitConfigured, mintLivekitToken } from "./livekit";
import {
  createMeeting,
  getMeetingByCode,
  getMeetingById,
  setMeetingStatus,
  createParticipant,
  markParticipantLeft,
  listParticipants,
  addSummaryRecipient,
  updateMeetingFields,
} from "./storage/meetings";
import { storage } from "./storage";
import { sendSms, smsAvailable, buildMeetingInviteSmsBody, normalizeE164 } from "./sms";
import { checkSmsConsent } from "./auth-consent";
import {
  allowKnock,
  cancelKnock,
  createKnock,
  decideKnock,
  getKnock,
  listPending,
  markTokenIssued,
  startLobbySweeper,
} from "./storage/lobby";
import {
  meetingKinds,
  summaryRecipientPolicies,
  type Meeting,
} from "@shared/schema";

// Public-safe shape of a meeting. We never leak org-internal ids/policy
// internals to an unauthenticated joiner beyond what the join screen needs.
function publicMeetingShape(m: Meeting) {
  return {
    id: m.id,
    code: m.code,
    kind: m.kind,
    title: m.title,
    status: m.status,
    allowGuests: m.allowGuests,
    waitingRoom: m.waitingRoom,
    recordingEnabled: m.recordingEnabled,
    transcriptEnabled: m.transcriptEnabled,
    scheduledStartAt: m.scheduledStartAt ? new Date(m.scheduledStartAt).getTime() : null,
    startedAt: m.startedAt ? new Date(m.startedAt).getTime() : null,
    endedAt: m.endedAt ? new Date(m.endedAt).getTime() : null,
  };
}

// Mints a LiveKit token for a guest joining `meeting` under `identity`, and
// records the participant. Shared by the direct guest-join path and the lobby
// admit path so token minting lives in exactly one place.
async function mintGuestJoin(meeting: Meeting, identity: string, displayName: string) {
  if (meeting.status === "scheduled") {
    setMeetingStatus(meeting.id, "active", { startedAt: new Date() });
  }
  createParticipant({
    meetingId: meeting.id,
    participantIdentity: identity,
    displayName,
    userId: null,
    role: "guest",
    origin: "guest_link",
  });
  const token = await mintLivekitToken({
    identity,
    name: displayName,
    roomName: meeting.livekitRoomName,
    canPublish: true,
  });
  return {
    token,
    identity,
    roomName: meeting.livekitRoomName,
    ws_url: process.env.LIVEKIT_WS_URL,
    meeting: publicMeetingShape(meeting),
  };
}

const createBodySchema = z.object({
  kind: z.enum(meetingKinds).default("scheduled"),
  title: z.string().max(200).optional(),
  channelId: z.number().int().positive().optional(),
  allowGuests: z.boolean().optional(),
  waitingRoom: z.boolean().optional(),
  recordingEnabled: z.boolean().optional(),
  transcriptEnabled: z.boolean().optional(),
  summaryEnabled: z.boolean().optional(),
  summaryRecipientPolicy: z.enum(summaryRecipientPolicies).optional(),
  maxDurationMinutes: z.number().int().positive().max(1440).optional(),
  scheduledStartAt: z.number().int().optional(),
  // Hand-picked extra recipients (for the 'explicit' policy or as extras).
  summaryRecipientUserIds: z.array(z.number().int().positive()).optional(),
  summaryRecipientEmails: z.array(z.string().email()).optional(),
  // SMS invitees: org members (phone looked up on the users table) and raw
  // external E.164 numbers for non-users. Both additive + optional.
  inviteeUserIds: z.array(z.number().int().positive()).max(50).optional(),
  inviteeExternalPhones: z.array(z.string()).max(50).optional(),
});

const patchBodySchema = z.object({
  title: z.string().max(200).optional(),
  allowGuests: z.boolean().optional(),
  waitingRoom: z.boolean().optional(),
  recordingEnabled: z.boolean().optional(),
  transcriptEnabled: z.boolean().optional(),
  summaryEnabled: z.boolean().optional(),
  summaryRecipientPolicy: z.enum(summaryRecipientPolicies).optional(),
  maxDurationMinutes: z.number().int().positive().max(1440).optional(),
});

const joinBodySchema = z.object({
  // Display name used when joining as a guest (no chat account).
  guestName: z.string().min(1).max(80).optional(),
});

const knockBodySchema = z.object({
  displayName: z.string().max(60).optional(),
});

// Mask a phone for logs — keep only the last 4 digits (e.g. +1•••••1234).
function maskPhone(e164: string): string {
  const last4 = e164.replace(/\D/g, "").slice(-4);
  return `•••••${last4}`;
}

// Resolve the client IP for the per-meeting knock rate-limit bucket.
function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function registerMeetingRoutes(app: Express) {
  // Single boot-time sweeper that expires overdue pending knocks (30s tick).
  startLobbySweeper();

  // ── CREATE a meeting (authed) ──
  app.post("/api/meetings", requireAuth, async (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const parsed = createBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid meeting", issues: parsed.error.flatten() });
    }
    const body = parsed.data;

    // If a channel is supplied, the caller must be able to see it. We check
    // both channel membership AND the multi-tenant region scope so a user
    // with PNW-only access can't host a meeting on a Southwest channel.
    if (body.channelId != null) {
      const isMember = storage.isChannelMember(body.channelId, u.id);
      if (!isMember && u.role !== "admin") {
        return res.status(403).json({ message: "Not a member of that channel" });
      }
      const gated = gateChannelById((req as unknown as AuthedRequest).access, body.channelId);
      if (!gated) {
        return res.status(404).json({ message: "Channel not found" });
      }
    }

    const meeting = createMeeting({
      orgId: u.orgId,
      kind: body.kind,
      title: body.title ?? null,
      hostUserId: u.id,
      channelId: body.channelId ?? null,
      allowGuests: body.allowGuests,
      waitingRoom: body.waitingRoom,
      recordingEnabled: body.recordingEnabled,
      transcriptEnabled: body.transcriptEnabled,
      summaryEnabled: body.summaryEnabled,
      summaryRecipientPolicy: body.summaryRecipientPolicy,
      maxDurationMinutes: body.maxDurationMinutes,
      scheduledStartAt: body.scheduledStartAt ? new Date(body.scheduledStartAt) : null,
    });

    for (const uid of body.summaryRecipientUserIds ?? []) {
      addSummaryRecipient({ meetingId: meeting.id, userId: uid, addedByUserId: u.id });
    }
    for (const email of body.summaryRecipientEmails ?? []) {
      addSummaryRecipient({ meetingId: meeting.id, email, addedByUserId: u.id });
    }

    const joinUrl = `https://chat.bulldogops.com/m/${meeting.code}`;

    // ── SMS invites (best-effort) ──────────────────────────────────────────
    // Resolve invitees to a de-duped set of { email, phone } recipients. Email
    // is the key the consent gate uses; external numbers carry none and so
    // fail-closed (skipped) under the consent check — TCPA-safe.
    const hostPhone = normalizeE164(u.phone ?? null);
    const seen = new Set<string>();
    if (hostPhone) seen.add(hostPhone); // never text the host themselves
    const recipients: { email: string | null; phone: string }[] = [];

    for (const uid of body.inviteeUserIds ?? []) {
      if (uid === u.id) continue;
      const invUser = storage.getUser(uid);
      const phone = normalizeE164(invUser?.phone ?? null);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      recipients.push({ email: invUser?.email ?? null, phone });
    }
    for (const raw of body.inviteeExternalPhones ?? []) {
      const phone = normalizeE164(raw);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      recipients.push({ email: null, phone });
    }

    let smsOkCount = 0;
    let smsSkipCount = 0;
    if (recipients.length > 0 && smsAvailable()) {
      const smsBody = buildMeetingInviteSmsBody({
        hostName: u.name,
        joinUrl,
        title: meeting.title,
      });
      for (const r of recipients) {
        // Consent gate (source of truth = bulldog-auth, keyed by email).
        const consent = await checkSmsConsent(r.email ?? "", "meeting_invite");
        if (!consent.allowed) {
          smsSkipCount++;
          console.log(`[meetings] sms skipped (no consent): ${maskPhone(r.phone)}`);
          continue;
        }
        const to = consent.phoneE164 ?? r.phone;
        try {
          const sent = await sendSms({ to, body: smsBody });
          if (sent.ok) {
            smsOkCount++;
          } else {
            smsSkipCount++;
            console.warn("[meetings] sms send failed:", sent.error);
          }
        } catch (e) {
          smsSkipCount++;
          console.warn("[meetings] sms send threw:", e);
        }
      }
    } else if (recipients.length > 0) {
      // SMS provider not configured — everything is effectively skipped.
      smsSkipCount = recipients.length;
    }

    res.json({
      meeting: publicMeetingShape(meeting),
      joinUrl,
      invitesSent: { sms: smsOkCount, skipped: smsSkipCount },
    });
  });

  // ── GET a meeting by code (public) ──
  app.get("/api/meetings/:code", (req: Request, res: Response) => {
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    res.json({ meeting: publicMeetingShape(meeting) });
  });

  // ── JOIN a meeting (public, tryAuth) ──
  // Mints a LiveKit token. Authed users join as `u_<id>`; guests as
  // `g_<nanoid>` — but only if the meeting allows guests.
  app.post("/api/meetings/:code/join", tryAuth, async (req: Request, res: Response) => {
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    if (meeting.status === "ended") {
      return res.status(409).json({ message: "This meeting has ended", code: meeting.code });
    }
    if (!livekitConfigured()) {
      return res.status(503).json({ message: "Calling unavailable: LiveKit not configured" });
    }

    const parsed = joinBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid join request" });
    }
    const authed = (req as unknown as Partial<AuthedRequest>).user;

    if (authed) {
      // Authed users must belong to the same org as the meeting.
      if (authed.orgId !== meeting.orgId) {
        return res.status(403).json({ message: "This meeting belongs to another organization" });
      }
      const identity = `u_${authed.id}`;
      const role = meeting.hostUserId === authed.id ? "host" : "participant";
      if (meeting.status === "scheduled") {
        setMeetingStatus(meeting.id, "active", { startedAt: new Date() });
      }
      createParticipant({
        meetingId: meeting.id,
        participantIdentity: identity,
        displayName: authed.name,
        userId: authed.id,
        role,
        origin: "app",
      });
      const token = await mintLivekitToken({
        identity,
        name: authed.name,
        roomName: meeting.livekitRoomName,
        canPublish: true,
      });
      return res.json({
        token,
        identity,
        roomName: meeting.livekitRoomName,
        ws_url: process.env.LIVEKIT_WS_URL,
        meeting: publicMeetingShape(meeting),
      });
    }

    if (!meeting.allowGuests) {
      return res.status(401).json({ message: "Sign-in required to join this meeting" });
    }
    const guestName = parsed.data.guestName?.trim();
    if (!guestName) return res.status(400).json({ message: "Guest name required" });
    const result = await mintGuestJoin(meeting, `g_${nanoid(10)}`, guestName);
    res.json(result);
  });

  // ── KNOCK: guest requests entry to a lobby-gated meeting (public) ──
  app.post("/api/meetings/:code/knock", async (req: Request, res: Response) => {
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ error: "Meeting not found", message: "Meeting not found" });
    if (meeting.status === "ended") {
      return res.status(409).json({ error: "This meeting has ended", message: "This meeting has ended" });
    }
    if (!meeting.allowGuests) {
      return res.status(403).json({ error: "This meeting doesn't allow guests", message: "This meeting doesn't allow guests" });
    }
    if (!livekitConfigured()) {
      return res.status(503).json({ error: "Calling unavailable: LiveKit not configured", message: "Calling unavailable: LiveKit not configured" });
    }
    if (!allowKnock(meeting.code, clientIp(req))) {
      return res.status(429).json({ error: "Too many knocks. Try again in a minute.", message: "Too many knocks. Try again in a minute." });
    }

    const parsed = knockBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid knock request", message: "Invalid knock request" });
    }
    const displayName = (parsed.data.displayName?.trim() || "Guest").slice(0, 60);

    // Escape hatch: waiting room off → immediate token, no knock queued.
    if (!meeting.waitingRoom) {
      const result = await mintGuestJoin(meeting, `g_${nanoid(10)}`, displayName);
      return res.json({ admitted: true, ...result });
    }

    const knock = createKnock(meeting.code, displayName);
    res.json({ knockId: knock.id, status: knock.status, pollIntervalMs: 2000 });
  });

  // ── KNOCK POLL: guest polls for a decision; one-shot token on admit (public) ──
  app.get("/api/meetings/:code/knock/:knockId", async (req: Request, res: Response) => {
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ error: "Meeting not found", message: "Meeting not found" });
    const knock = getKnock(String(req.params.knockId));
    if (!knock || knock.meetingCode !== meeting.code) {
      return res.status(404).json({ error: "Knock not found", message: "Knock not found" });
    }

    if (knock.status === "admitted" && !knock.tokenIssued) {
      // One-shot: mint the token now and consume the admit.
      const result = await mintGuestJoin(meeting, knock.guestIdentity, knock.displayName);
      markTokenIssued(knock.id);
      return res.json({ status: "admitted", ...result });
    }
    if (knock.status === "admitted") {
      return res.json({ status: "admitted", tokenIssued: true });
    }
    res.json({ status: knock.status });
  });

  // ── KNOCK CANCEL: guest leaves the lobby (public) ──
  app.delete("/api/meetings/:code/knock/:knockId", (req: Request, res: Response) => {
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ error: "Meeting not found", message: "Meeting not found" });
    const knock = getKnock(String(req.params.knockId));
    if (!knock || knock.meetingCode !== meeting.code) {
      return res.status(404).json({ error: "Knock not found", message: "Knock not found" });
    }
    cancelKnock(knock.id);
    res.json({ status: getKnock(knock.id)?.status ?? "cancelled" });
  });

  // ── LOBBY LIST: host polls pending knocks (authed + org-gated) ──
  app.get("/api/meetings/:code/lobby", requireAuth, (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ error: "Meeting not found", message: "Meeting not found" });
    if (meeting.orgId !== u.orgId) {
      return res.status(403).json({ error: "Forbidden", message: "Forbidden" });
    }
    res.json({ pending: listPending(meeting.code) });
  });

  // ── LOBBY ADMIT (authed + org-gated) ──
  app.post("/api/meetings/:code/lobby/:knockId/admit", requireAuth, (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ error: "Meeting not found", message: "Meeting not found" });
    if (meeting.orgId !== u.orgId) {
      return res.status(403).json({ error: "Forbidden", message: "Forbidden" });
    }
    const knock = getKnock(String(req.params.knockId));
    if (!knock || knock.meetingCode !== meeting.code) {
      return res.status(404).json({ error: "Knock not found", message: "Knock not found" });
    }
    const updated = decideKnock(knock.id, "admitted", `u_${u.id}`);
    if (!updated) return res.status(409).json({ error: "Knock is no longer pending", message: "Knock is no longer pending" });
    res.json({ status: updated.status });
  });

  // ── LOBBY DENY (authed + org-gated) ──
  app.post("/api/meetings/:code/lobby/:knockId/deny", requireAuth, (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ error: "Meeting not found", message: "Meeting not found" });
    if (meeting.orgId !== u.orgId) {
      return res.status(403).json({ error: "Forbidden", message: "Forbidden" });
    }
    const knock = getKnock(String(req.params.knockId));
    if (!knock || knock.meetingCode !== meeting.code) {
      return res.status(404).json({ error: "Knock not found", message: "Knock not found" });
    }
    const updated = decideKnock(knock.id, "denied", `u_${u.id}`);
    if (!updated) return res.status(409).json({ error: "Knock is no longer pending", message: "Knock is no longer pending" });
    res.json({ status: updated.status });
  });

  // ── LEAVE a meeting (public) ──
  app.post("/api/meetings/:code/leave", (req: Request, res: Response) => {
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    const identity = String(req.body?.identity ?? "");
    if (!identity) return res.status(400).json({ message: "identity required" });
    markParticipantLeft(meeting.id, identity);
    res.json({ ok: true });
  });

  // ── PATCH a meeting (authed host) ──
  app.patch("/api/meetings/:id", requireAuth, (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const meeting = getMeetingById(String(req.params.id));
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    if (meeting.hostUserId !== u.id && u.role !== "admin") {
      return res.status(403).json({ message: "Only the host can edit this meeting" });
    }
    const parsed = patchBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid update", issues: parsed.error.flatten() });
    }
    updateMeetingFields(meeting.id, parsed.data);
    const fresh = getMeetingById(meeting.id)!;
    res.json({ meeting: publicMeetingShape(fresh) });
  });

  // ── END a meeting (authed host) ──
  app.post("/api/meetings/:id/end", requireAuth, async (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const meeting = getMeetingById(String(req.params.id));
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    if (meeting.hostUserId !== u.id && u.role !== "admin") {
      return res.status(403).json({ message: "Only the host can end this meeting" });
    }
    if (meeting.status !== "ended") {
      setMeetingStatus(meeting.id, "ended", { endedAt: new Date() });
      // Fire-and-forget summary delivery (no-op if summaries are disabled).
      void deliverMeetingSummaryIfEnabled(meeting.id).catch((e) =>
        console.warn(`[meetings] summary delivery failed for ${meeting.id}:`, e?.message),
      );
    }
    res.json({ meeting: publicMeetingShape(getMeetingById(meeting.id)!) });
  });

  // ── PARTICIPANTS (authed) ──
  app.get("/api/meetings/:id/participants", requireAuth, (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const meeting = getMeetingById(String(req.params.id));
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    if (meeting.orgId !== u.orgId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    res.json({
      participants: listParticipants(meeting.id).map((p) => ({
        id: p.id,
        participantIdentity: p.participantIdentity,
        displayName: p.displayName,
        userId: p.userId,
        role: p.role,
        origin: p.origin,
        joinedAt: p.joinedAt ? new Date(p.joinedAt).getTime() : null,
        leftAt: p.leftAt ? new Date(p.leftAt).getTime() : null,
      })),
    });
  });
}

// Lazy import to avoid a circular dependency at module load (summary.ts pulls
// in the clerk pipeline which imports storage which imports this file's siblings).
async function deliverMeetingSummaryIfEnabled(meetingId: string): Promise<void> {
  const mod = await import("./meetings/summary");
  await mod.deliverMeetingSummary(meetingId);
}
