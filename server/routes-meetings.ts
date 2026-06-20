import type { Express, Request, Response } from "express";
import { z } from "zod";
import { nanoid } from "nanoid";
import { requireAuth, tryAuth, AuthedRequest } from "./auth";
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

export function registerMeetingRoutes(app: Express) {
  // ── CREATE a meeting (authed) ──
  app.post("/api/meetings", requireAuth, (req: Request, res: Response) => {
    const u = (req as unknown as AuthedRequest).user;
    const parsed = createBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid meeting", issues: parsed.error.flatten() });
    }
    const body = parsed.data;

    // If a channel is supplied, the caller must be able to see it.
    if (body.channelId != null) {
      const isMember = storage.isChannelMember(body.channelId, u.id);
      if (!isMember && u.role !== "admin") {
        return res.status(403).json({ message: "Not a member of that channel" });
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

    res.json({
      meeting: publicMeetingShape(meeting),
      joinUrl: `https://chat.bulldogops.com/m/${meeting.code}`,
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

    let identity: string;
    let name: string;
    let userId: number | null;
    let role: "host" | "participant" | "guest";
    let origin: string;

    if (authed) {
      // Authed users must belong to the same org as the meeting.
      if (authed.orgId !== meeting.orgId) {
        return res.status(403).json({ message: "This meeting belongs to another organization" });
      }
      identity = `u_${authed.id}`;
      name = authed.name;
      userId = authed.id;
      role = meeting.hostUserId === authed.id ? "host" : "participant";
      origin = "app";
    } else {
      if (!meeting.allowGuests) {
        return res.status(401).json({ message: "Sign-in required to join this meeting" });
      }
      const guestName = parsed.data.guestName?.trim();
      if (!guestName) return res.status(400).json({ message: "Guest name required" });
      identity = `g_${nanoid(10)}`;
      name = guestName;
      userId = null;
      role = "guest";
      origin = "guest_link";
    }

    // First join flips a scheduled meeting to active.
    if (meeting.status === "scheduled") {
      setMeetingStatus(meeting.id, "active", { startedAt: new Date() });
    }

    createParticipant({
      meetingId: meeting.id,
      participantIdentity: identity,
      displayName: name,
      userId,
      role,
      origin,
    });

    const token = await mintLivekitToken({
      identity,
      name,
      roomName: meeting.livekitRoomName,
      canPublish: true,
    });

    res.json({
      token,
      identity,
      roomName: meeting.livekitRoomName,
      ws_url: process.env.LIVEKIT_WS_URL,
      meeting: publicMeetingShape(meeting),
    });
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
