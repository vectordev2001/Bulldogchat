import type { Express, Request, Response } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { requireAuth, tryAuth, AuthedRequest } from "./auth";
import { gateChannelById } from "./multitenant-access";
import { livekitConfigured, mintLivekitToken, mintLivekitBotToken, evictParticipant } from "./livekit";
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
  setMeetingTeamsLink,
  setMeetingBridge,
  recordBridgeEvent,
  upsertBridgeParticipant,
  markBridgeParticipantLeft,
  listBridgeParticipants,
} from "./storage/meetings";
import { createTeamsMeeting } from "./teams/createMeeting";
import {
  bridgeAvailable,
  dispatchBridge,
  deleteBridge,
  verifyBridgeWebhookSecret,
} from "./bridge/client";
import { storage } from "./storage";
import { sendSms, smsAvailable, buildMeetingInviteSmsBody, normalizeE164 } from "./sms";
import { sendEmail, isEmailConfigured } from "./email";
import { buildMeetingInviteEmail } from "./meetings/invite-email";
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
import { notifyInviteesMeetingStarted } from "./scheduled-calls";

// Public-safe shape of a meeting. We never leak org-internal ids/policy
// internals to an unauthenticated joiner beyond what the join screen needs.
function publicMeetingShape(m: Meeting) {
  // Live count of participants still in the room (joinedAt set, leftAt null).
  // Surfaced so in-channel "Started" meeting cards can show "3 people in this
  // meeting" without forcing an extra round-trip to /participants. Best-effort:
  // a count failure must not block the meeting fetch.
  let activeParticipantCount = 0;
  try {
    activeParticipantCount = listParticipants(m.id).filter((p) => p.joinedAt && !p.leftAt).length;
  } catch {
    /* best-effort */
  }
  // Surface bridge participants count alongside LiveKit participants so the
  // "X people in this meeting" badge in channel cards reflects the true
  // total (LiveKit attendees + Teams attendees forwarded via the bridge).
  let bridgeParticipantCount = 0;
  try {
    bridgeParticipantCount = listBridgeParticipants(m.id).filter((p) => p.joinedAt && !p.leftAt).length;
  } catch {
    /* best-effort */
  }
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
    activeParticipantCount,
    // Teams interop — null when MS Graph isn't configured or admin
    // consent hasn't been granted. UI uses teamsJoinUrl to render a
    // "Copy Teams link" button next to "Copy invite link".
    teamsJoinUrl: m.teamsJoinUrl ?? null,
    bridgeStatus: m.bridgeStatus ?? null,
    bridgeParticipantCount,
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

    // ── Teams interop (Phase 0) ──────────────────────────────────────
    // Mint a Teams onlineMeeting in parallel so external attendees who only
    // have a Teams client can still join. Mirrors what scheduled-calls
    // already does for scheduled meetings (see scheduled-calls.ts:1072).
    //
    // Fail-open: if Graph isn't configured, admin consent isn't granted,
    // or the call errors, we proceed with a LiveKit-only meeting. The
    // teamsJoinUrl response field will be null and the SMS body falls
    // back to the LiveKit-only template.
    //
    // We don't await the bridge dispatch here for two reasons: (1) the
    // bridge isn't live yet (Phase 2 ships unified audio/video), and
    // (2) even when it ships, the dispatch is best-effort and shouldn't
    // delay the meeting-create response. The bridge is dispatched in the
    // background; the client polls /api/meetings/:code for bridgeStatus
    // updates if it cares.
    let teamsJoinUrl: string | null = null;
    let teamsMeetingId: string | null = null;
    try {
      const startUtc = meeting.scheduledStartAt ?? new Date();
      const endUtc = new Date(
        startUtc.getTime() + (meeting.maxDurationMinutes ?? 240) * 60_000,
      );
      const teams = await createTeamsMeeting({
        subject: meeting.title ?? "Bulldog meeting",
        startUtc,
        endUtc,
      });
      if (teams) {
        teamsJoinUrl = teams.joinUrl;
        teamsMeetingId = teams.meetingId;
        setMeetingTeamsLink(meeting.id, teamsJoinUrl, teamsMeetingId);
        // Re-read so publicMeetingShape() at the end of the handler picks
        // up the new teamsJoinUrl column in the response.
        const refreshed = getMeetingById(meeting.id);
        if (refreshed) Object.assign(meeting, refreshed);
      }
    } catch (e) {
      console.warn("[meetings] createTeamsMeeting error:", (e as Error).message);
    }

    // ── Bulldog Bridge dispatch (Phase 0 — best-effort, in background) ──────
    // When the bridge env vars are set and we successfully created a Teams
    // meeting, ask bulldog-bridge to dispatch a bot. Fire-and-forget: we
    // record the result asynchronously via setMeetingBridge so the
    // POST /api/meetings response doesn't block on bridge cold-start.
    if (teamsJoinUrl && teamsMeetingId && bridgeAvailable()) {
      const livekitWsUrl = process.env.LIVEKIT_WS_URL ?? "";
      void (async () => {
        try {
          const botToken = await mintLivekitBotToken({
            identity: `bridge-${meeting.id}`,
            name: "Bulldog Bridge (recording)",
            roomName: meeting.livekitRoomName,
            ttlMinutes: Math.max(60, meeting.maxDurationMinutes ?? 240),
          });
          const result = await dispatchBridge({
            meetingId: meeting.id,
            teamsJoinUrl: teamsJoinUrl!,
            teamsMeetingId: teamsMeetingId!,
            livekitRoom: meeting.livekitRoomName,
            livekitToken: botToken,
            livekitWsUrl,
            organizerId: meeting.hostUserId ? String(meeting.hostUserId) : null,
            options: {
              audioMode: "duplex",
              videoMode: "duplex",
              screenShareMode: "duplex",
              announceOnJoin: true,
              maxDurationMinutes: meeting.maxDurationMinutes ?? 240,
            },
          });
          if (result) {
            setMeetingBridge(meeting.id, result.bridgeId, result.status);
            console.log(
              `[meetings] bridge dispatched meeting=${meeting.id} bridgeId=${result.bridgeId} status=${result.status}`,
            );
          } else {
            // dispatchBridge returned null — bridge unavailable or 5xx.
            // Persist a 'failed' sentinel so the UI can surface a retry
            // button without polling the bridge directly.
            setMeetingBridge(meeting.id, null, "failed");
          }
        } catch (e) {
          console.warn(
            "[meetings] bridge dispatch threw for meeting=",
            meeting.id,
            (e as Error).message,
          );
          setMeetingBridge(meeting.id, null, "failed");
        }
      })();
    }

    // ── SMS invites (best-effort) ──────────────────────────────────────────
    // Resolve invitees to a de-duped set of recipients. Org-member invites
    // run through the bulldog-auth consent gate (TCPA-safe). External
    // (manually-typed) phones bypass that gate because they have no email
    // key — they're handled by Twilio STOP/UNSUBSCRIBE keywords and the
    // SMS disclosure baked into buildMeetingInviteSmsBody.
    //
    // Self-invite policy mirrors the /invite endpoint: userId-based invites
    // skip the host's own phone, but explicitly-typed external phones are
    // honoured even if they match the host's number (e.g. host wants to
    // forward the link to their personal device or test the flow).
    //
    // Channel-meeting auto-invite: when a meeting is started inside a
    // channel, every channel member (minus the host) is treated as an
    // implicit invitee. Explicit `inviteeUserIds` from the request body
    // are merged in on top (deduped). Without this, channel meetings
    // created from the UI silently send no notifications at all — the
    // CreateMeetingDialog client doesn't populate inviteeUserIds, and
    // people get added to the room with no SMS or email ping.
    const hostPhone = normalizeE164(u.phone ?? null);
    const seenPhones = new Set<string>();
    const seenEmails = new Set<string>();
    const seenUserIds = new Set<number>();
    const recipients: {
      userId: number | null;
      email: string | null;
      phone: string | null;
      external: boolean;
    }[] = [];

    // Merge explicit + implicit channel-member invitees. Order matters
    // only for de-dupe — first add wins. Explicit invitees go first so
    // any odd channel-member ordering can\'t override caller intent.
    const implicitUserIds: number[] =
      body.channelId != null
        ? storage.listChannelMemberIds(body.channelId).filter((id) => id !== u.id)
        : [];
    const allInviteeUserIds = [
      ...(body.inviteeUserIds ?? []),
      ...implicitUserIds,
    ];

    for (const uid of allInviteeUserIds) {
      if (uid === u.id) continue;
      if (seenUserIds.has(uid)) continue;
      seenUserIds.add(uid);
      const invUser = storage.getUser(uid);
      if (!invUser) continue;
      // Cross-org safety: never invite a user from another org via id.
      if (invUser.orgId !== u.orgId) continue;
      const phone = normalizeE164(invUser.phone ?? null);
      const email = invUser.email?.trim().toLowerCase() || null;
      // Skip the host\'s own contacts (defensive — already filtered by id).
      if (phone && hostPhone && phone === hostPhone) continue;
      if (phone && seenPhones.has(phone)) continue;
      if (email && seenEmails.has(email)) continue;
      // Skip recipients with no contactable channel at all.
      if (!phone && !email) continue;
      if (phone) seenPhones.add(phone);
      if (email) seenEmails.add(email);
      recipients.push({ userId: uid, email, phone, external: false });
    }
    for (const raw of body.inviteeExternalPhones ?? []) {
      const phone = normalizeE164(raw);
      if (!phone || seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      recipients.push({ userId: null, email: null, phone, external: true });
    }

    // ── SMS fan-out (best-effort) ──────────────────────────────────────
    let smsOkCount = 0;
    let smsSkipCount = 0;
    if (recipients.length > 0 && smsAvailable()) {
      const smsBody = buildMeetingInviteSmsBody({
        hostName: u.name,
        joinUrl,
        title: meeting.title,
        teamsJoinUrl: meeting.teamsJoinUrl ?? null,
      });
      for (const r of recipients) {
        if (!r.phone) continue; // Email-only invitee.
        let to = r.phone;
        if (!r.external) {
          const consent = await checkSmsConsent(r.email ?? "", "meeting_invite");
          if (!consent.allowed) {
            smsSkipCount++;
            console.log(`[meetings] sms skipped (no consent): ${maskPhone(r.phone)}`);
            continue;
          }
          to = consent.phoneE164 ?? r.phone;
        }
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
    } else if (recipients.length > 0 && !smsAvailable()) {
      // SMS provider not configured — phone-channel invites are skipped.
      smsSkipCount = recipients.filter((r) => r.phone).length;
    }

    // ── Email fan-out (best-effort) ──────────────────────────────────────
    // Mirrors SMS but for the email channel. Org-member invitees get an
    // email if they have an `email` on the users table. External phone
    // entries (no email key) are skipped. We don\'t run the SMS consent
    // gate on email — TCPA covers SMS only; email opt-out is handled by
    // SendGrid unsubscribe groups upstream.
    let emailOkCount = 0;
    let emailSkipCount = 0;
    const emailRecipients = recipients.filter((r) => !r.external && r.email);
    if (emailRecipients.length > 0 && isEmailConfigured()) {
      const emailPayload = buildMeetingInviteEmail({
        hostName: u.name,
        joinUrl,
        title: meeting.title,
        teamsJoinUrl: meeting.teamsJoinUrl ?? null,
      });
      for (const r of emailRecipients) {
        try {
          const sent = await sendEmail({
            to: r.email!,
            subject: emailPayload.subject,
            text: emailPayload.text,
            html: emailPayload.html,
          });
          if (sent.sent) {
            emailOkCount++;
          } else {
            emailSkipCount++;
            console.warn(
              "[meetings] email invite failed:",
              sent.reason,
              "to=",
              r.email,
            );
          }
        } catch (e) {
          emailSkipCount++;
          console.warn("[meetings] email invite threw:", e);
        }
      }
    } else if (emailRecipients.length > 0 && !isEmailConfigured()) {
      emailSkipCount = emailRecipients.length;
    }

    res.json({
      meeting: publicMeetingShape(meeting),
      joinUrl,
      invitesSent: {
        sms: smsOkCount,
        smsSkipped: smsSkipCount,
        email: emailOkCount,
        emailSkipped: emailSkipCount,
        // Legacy field for any client still reading `.skipped` — sum both.
        skipped: smsSkipCount + emailSkipCount,
      },
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
      // Detect the scheduled→active transition BEFORE we mutate so the
      // notifier only fires once, on the actual first join.
      const wasScheduled = meeting.status === "scheduled";
      if (wasScheduled) {
        setMeetingStatus(meeting.id, "active", { startedAt: new Date() });
        // Teams-style: notify every invitee that the meeting just started.
        // Fire-and-forget; failure must not block the join.
        void notifyInviteesMeetingStarted(meeting.id, authed.id);
      }
      createParticipant({
        meetingId: meeting.id,
        participantIdentity: identity,
        displayName: authed.name,
        userId: authed.id,
        role,
        origin: "app",
      });
      // Evict any stale SFU publisher with the same identity BEFORE we
      // mint a fresh token. LiveKit auto-boots a duplicate identity on
      // reconnect, but only if the previous WebSocket was still alive.
      // If a prior tab/page crashed or the user closed the laptop lid,
      // ghost publishers can linger in the room until their server-side
      // timeout fires — manifesting as N copies of the same person in
      // the grid. Best-effort: swallow errors and proceed.
      await evictParticipant(meeting.livekitRoomName, identity);
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

  // ── INVITE more people to a meeting (authed org member) ──
  //
  // Mid-meeting invite. The host (or anyone in the same org as the meeting)
  // can fire SMS invites to additional users + raw external phone numbers.
  // Mirrors the SMS-fan-out block from POST /api/meetings on create.
  //
  // Why "any org member" and not just the host? Mid-meeting reality —
  // anyone in the room realizing "we need X here" should be able to text
  // them without rejoining as host. We still scope to the meeting's org
  // and run the same TCPA consent gate, so it's safe.
  app.post("/api/meetings/:code/invite", requireAuth, async (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const meeting = getMeetingByCode(String(req.params.code));
    if (!meeting) return res.status(404).json({ message: "Meeting not found" });
    if (meeting.orgId !== u.orgId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const InviteBodySchema = z.object({
      inviteeUserIds: z.array(z.number().int().positive()).max(50).optional(),
      inviteeExternalPhones: z.array(z.string()).max(50).optional(),
    });
    const parsed = InviteBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid invite", issues: parsed.error.flatten() });
    }
    const body = parsed.data;

    const joinUrl = `https://chat.bulldogops.com/m/${meeting.code}`;

    // Build a recipient set keyed by E.164 phone.
    //
    // Note on self-invite: we DON'T pre-add the caller's own phone to the
    // de-dupe set. The userId path filters self-invites by id above
    // (`uid === u.id`), and external phones the caller typed explicitly
    // should be honoured even if they happen to be the caller's number
    // (e.g. they want to forward the join link to their personal device or
    // test the flow). The only filter applied to external phones is
    // duplicate suppression within the same request.
    const callerPhone = normalizeE164(u.phone ?? null);
    const seen = new Set<string>();
    // `external: true` marks phones the caller typed manually (non-org-members).
    // These have no associated email so we can't run the bulldog-auth consent
    // check on them — we send via Twilio with the global SMS opt-out path
    // baked into Twilio itself (STOP keyword). Org-member invites still go
    // through the consent gate.
    const recipients: { email: string | null; phone: string; external: boolean }[] = [];

    for (const uid of body.inviteeUserIds ?? []) {
      if (uid === u.id) continue;
      const invUser = storage.getUser(uid);
      // Cross-org safety: ignore user ids that don't belong to this org.
      if (!invUser || invUser.orgId !== u.orgId) continue;
      const phone = normalizeE164(invUser.phone ?? null);
      if (!phone || seen.has(phone)) continue;
      // Even for userId invites, skip the caller's own phone — they may have
      // selected themselves indirectly (e.g. legacy id).
      if (callerPhone && phone === callerPhone) continue;
      seen.add(phone);
      recipients.push({ email: invUser.email ?? null, phone, external: false });
    }
    for (const raw of body.inviteeExternalPhones ?? []) {
      const phone = normalizeE164(raw);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      recipients.push({ email: null, phone, external: true });
    }

    if (recipients.length === 0) {
      return res.json({
        invitesSent: { sms: 0, smsSkipped: 0, email: 0, emailSkipped: 0, skipped: 0 },
        joinUrl,
      });
    }

    // Look up the host's name for the SMS body. Fall back to the caller's
    // name (they're the one pressing Invite, so that reads naturally too).
    // hostUserId can be null for guest-started rooms — guard accordingly.
    const host = meeting.hostUserId != null ? storage.getUser(meeting.hostUserId) : null;
    const hostName = host?.name || u.name;

    let smsOkCount = 0;
    let smsSkipCount = 0;
    if (smsAvailable()) {
      const smsBody = buildMeetingInviteSmsBody({
        hostName,
        joinUrl,
        title: meeting.title,
        teamsJoinUrl: meeting.teamsJoinUrl ?? null,
      });
      for (const r of recipients) {
        // External (manually-typed) phones bypass the bulldog-auth consent
        // lookup because they're not org members — no email key, no
        // notification preferences. Compliance for these recipients is
        // handled by Twilio STOP/UNSUBSCRIBE keywords + the SMS host's
        // disclosure footer baked into buildMeetingInviteSmsBody.
        let to = r.phone;
        if (!r.external) {
          const consent = await checkSmsConsent(r.email ?? "", "meeting_invite");
          if (!consent.allowed) {
            smsSkipCount++;
            console.log(`[meetings/invite] sms skipped (no consent): ${maskPhone(r.phone)}`);
            continue;
          }
          to = consent.phoneE164 ?? r.phone;
        }
        try {
          const sent = await sendSms({ to, body: smsBody });
          if (sent.ok) smsOkCount++;
          else {
            smsSkipCount++;
            console.warn("[meetings/invite] sms send failed:", sent.error);
          }
        } catch (e) {
          smsSkipCount++;
          console.warn("[meetings/invite] sms send threw:", e);
        }
      }
    } else {
      smsSkipCount = recipients.length;
    }

    // Email fan-out for org-member invitees (mirrors POST /api/meetings).
    let emailOkCount = 0;
    let emailSkipCount = 0;
    const emailRecipients = recipients.filter((r) => !r.external && r.email);
    if (emailRecipients.length > 0 && isEmailConfigured()) {
      const emailPayload = buildMeetingInviteEmail({
        hostName,
        joinUrl,
        title: meeting.title,
        teamsJoinUrl: meeting.teamsJoinUrl ?? null,
      });
      for (const r of emailRecipients) {
        try {
          const sent = await sendEmail({
            to: r.email!,
            subject: emailPayload.subject,
            text: emailPayload.text,
            html: emailPayload.html,
          });
          if (sent.sent) emailOkCount++;
          else {
            emailSkipCount++;
            console.warn("[meetings/invite] email failed:", sent.reason, "to=", r.email);
          }
        } catch (e) {
          emailSkipCount++;
          console.warn("[meetings/invite] email threw:", e);
        }
      }
    } else if (emailRecipients.length > 0 && !isEmailConfigured()) {
      emailSkipCount = emailRecipients.length;
    }

    res.json({
      invitesSent: {
        sms: smsOkCount,
        smsSkipped: smsSkipCount,
        email: emailOkCount,
        emailSkipped: emailSkipCount,
        skipped: smsSkipCount + emailSkipCount,
      },
      joinUrl,
    });
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
  // Accepts either the opaque meeting id OR the human meeting code so the
  // in-channel "Started" card can pass the code it already has without an
  // extra id-resolution round-trip.
  app.get("/api/meetings/:id/participants", requireAuth, (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const key = String(req.params.id);
    const meeting = getMeetingById(key) ?? getMeetingByCode(key);
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

  // Bridge webhook — receives lifecycle + Teams participant events from the
  // bulldog-bridge signaling service. Auth via shared secret header. See
  // teams-bridge-spec.md §4.4 for the body shape.
  app.post("/internal/bridge-events", async (req: Request, res: Response) => {
    if (!verifyBridgeWebhookSecret(req.headers.authorization)) {
      return res.status(401).json({ message: "Invalid bridge secret" });
    }
    const body = (req.body ?? {}) as {
      bridgeId?: string;
      meetingId?: string;
      event?: string;
      timestamp?: string | number;
      data?: { teamsParticipantId?: string; displayName?: string } | null;
    };
    const { meetingId, event, timestamp, data } = body;
    if (!meetingId || !event) {
      return res.status(400).json({ message: "Bad payload" });
    }
    const eventAt = (() => {
      if (!timestamp) return new Date();
      const d = new Date(timestamp);
      return Number.isNaN(d.getTime()) ? new Date() : d;
    })();

    try {
      if (event === "teams-participant-joined" && data?.teamsParticipantId) {
        upsertBridgeParticipant({
          meetingId,
          teamsParticipantId: data.teamsParticipantId,
          displayName: data.displayName ?? "Teams attendee",
          joinedAt: eventAt,
        });
      } else if (event === "teams-participant-left" && data?.teamsParticipantId) {
        markBridgeParticipantLeft({
          meetingId,
          teamsParticipantId: data.teamsParticipantId,
          leftAt: eventAt,
        });
      } else {
        // Lifecycle: joined / active / failed / left → status update on meeting row.
        recordBridgeEvent(meetingId, event, eventAt);
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error("[bridge-events] handler error", err);
      return res.status(500).json({ message: "Bridge event handler failed" });
    }
  });
}

// Lazy import to avoid a circular dependency at module load (summary.ts pulls
// in the clerk pipeline which imports storage which imports this file's siblings).
async function deliverMeetingSummaryIfEnabled(meetingId: string): Promise<void> {
  const mod = await import("./meetings/summary");
  await mod.deliverMeetingSummary(meetingId);
}
