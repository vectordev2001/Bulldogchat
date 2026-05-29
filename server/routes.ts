import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { nanoid } from "nanoid";
import { storage, sanitize } from "./storage";
import {
  signupSchema, loginSchema, acceptInviteSchema, sendMessageSchema, reactionSchema,
  insertProjectSchema, insertChannelSchema, insertInviteSchema,
} from "@shared/schema";
import { hashPassword, verifyPassword, signJwt, requireAuth, requireRole, setAuthCookie, clearAuthCookie, AuthedRequest, AUTH_COOKIE } from "./auth";
import { addSubscriber, removeSubscriber, emitMessageNew, emitMessageDelete, emitMessageUpdate, emitReactionChange, emitCallIncoming, emitCallAccepted, emitCallEnded, type CallEventPayload, WireMessage } from "./events";
import { generateLivekitToken, livekitConfigured } from "./livekit";
import { setupWebPush, pushConfigured, getPublicVapidKey, sendNotificationToUsers } from "./push";
import { runMigrations } from "./migrate";
import { runSeed } from "./seed";
import { registerV2Routes, parseMentions } from "./routes-v2";
import { bulldogSsoBridge } from "./bulldog-sso";

const APP_VERSION = "1.0.0";

// ─────────────────── HELPERS ───────────────────

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || `org-${Date.now()}`;
}

function authorFor(userId: number) {
  const u = storage.getUser(userId);
  if (!u) return { authorName: "Unknown", authorHue: 220, authorRole: "field", authorInitials: "?" };
  const initials = u.name.split(/\s+/).slice(0, 2).map(s => s[0] ?? "").join("").toUpperCase();
  return { authorName: u.name, authorHue: u.hue, authorRole: u.role, authorInitials: initials };
}

function buildWireMessage(messageId: number): WireMessage | null {
  const msg = storage.getMessage(messageId);
  if (!msg) return null;
  const author = authorFor(msg.userId);
  const rxns = storage.listReactions([messageId]);
  const grouped = new Map<string, { emoji: string; count: number; userIds: number[] }>();
  for (const r of rxns) {
    const g = grouped.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [] };
    g.count++;
    g.userIds.push(r.userId);
    grouped.set(r.emoji, g);
  }
  const atts = storage.listAttachmentsForMessages([messageId]);
  const attachmentsList = atts.map(a => {
    const { getStorageBackend } = require("./storage-files");
    const backend = getStorageBackend();
    const publicUrl = backend.publicUrl(a.storageKey);
    const thumbPublic = a.thumbnailKey ? backend.publicUrl(a.thumbnailKey) : null;
    return {
      id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes,
      url: publicUrl ?? `/api/files/${a.id}`,
      thumbnailUrl: thumbPublic ?? (a.thumbnailKey ? `/api/files/${a.id}?thumb=1` : null),
      createdAt: a.createdAt,
    };
  });
  return { ...msg, ...author, reactions: Array.from(grouped.values()), attachmentsList } as any;
}

// Make sure the requesting user belongs to the project (either project member or admin within org)
function userCanAccessProject(userId: number, orgId: number, projectId: number): boolean {
  const project = storage.getProject(projectId);
  if (!project || project.orgId !== orgId) return false;
  return storage.isProjectMember(projectId, userId);
}
function userCanAccessChannel(userId: number, orgId: number, channelId: number): { channel: ReturnType<typeof storage.getChannel>; project: ReturnType<typeof storage.getProject> } | null {
  const channel = storage.getChannel(channelId);
  if (!channel) return null;
  const project = storage.getProject(channel.projectId);
  if (!project || project.orgId !== orgId) return null;
  if (!storage.isProjectMember(project.id, userId)) return null;
  return { channel, project };
}

// ─────────────────── ROUTES ───────────────────
export async function registerRoutes(_httpServer: Server, app: Express) {
  runMigrations();
  await runSeed();
  setupWebPush();

  // Bulldog SSO bridge — if request has bulldog_access JWT cookie but no
  // vc_token, mint a vc_token for the matching local user.
  app.use(bulldogSsoBridge());

  registerV2Routes(app);

  // Health
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: APP_VERSION, db: "connected", livekit: livekitConfigured(), push: pushConfigured() });
  });

  // ── AUTH ──
  app.post("/api/auth/signup", (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input" });
    const { orgName, name, email, password } = parsed.data;

    if (storage.getUserByEmail(email)) {
      return res.status(409).json({ message: "Email is already registered" });
    }
    let slug = slugify(orgName);
    if (storage.getOrgBySlug(slug)) slug = `${slug}-${nanoid(6).toLowerCase()}`;
    const org = storage.createOrg({ name: orgName, slug, plan: "starter" });

    const user = storage.createUser({
      orgId: org.id,
      email,
      passwordHash: hashPassword(password),
      name,
      title: "Owner",
      avatarUrl: null,
      hue: 232,
      role: "admin",
      status: "online",
    });

    // Create starter project + channels
    const project = storage.createProject({
      orgId: org.id, name: "General", slug: "general",
      short: "GEN", hue: 232, description: "Your team's first project.",
    });
    storage.addProjectMember(project.id, user.id, "owner");
    storage.createChannel({ projectId: project.id, name: "general", type: "text", topic: "Team-wide chatter.", position: 0 });
    storage.createChannel({ projectId: project.id, name: "announcements", type: "text", topic: "Important drops.", position: 1 });
    storage.createChannel({ projectId: project.id, name: "Daily Standup", type: "voice", topic: null, position: 2 });

    const token = signJwt(user.id);
    setAuthCookie(res, token);
    res.json({ token, user: sanitize(user), org });
  });

  app.post("/api/auth/login", (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input" });
    const { email, password } = parsed.data;
    const user = storage.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    const token = signJwt(user.id);
    setAuthCookie(res, token);
    storage.updateUserLastSeen(user.id);
    res.json({ token, user: sanitize(user), org: storage.getOrg(user.orgId) });
  });

  app.post("/api/auth/logout", (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    res.json({ user: sanitize(u), org: storage.getOrg(u.orgId) });
  });

  // ── ORG MEMBERS ──
  app.get("/api/org/members", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const list = storage.listUsersByOrg(u.orgId).map(sanitize);
    res.json(list);
  });

  // ── PROJECTS ──
  app.get("/api/projects", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const projects = storage.listProjectsForUser(u.id);
    res.json(projects);
  });

  app.post("/api/projects", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const parsed = insertProjectSchema.omit({ orgId: true }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input" });
    const project = storage.createProject({ ...parsed.data, orgId: u.orgId });
    storage.addProjectMember(project.id, u.id, "owner");
    // Default channels
    storage.createChannel({ projectId: project.id, name: "general", type: "text", topic: "General chatter.", position: 0 });
    storage.createChannel({ projectId: project.id, name: "announcements", type: "text", topic: null, position: 1 });
    storage.createChannel({ projectId: project.id, name: "Daily Standup", type: "voice", topic: null, position: 2 });
    res.json(project);
  });

  app.get("/api/projects/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id)) return res.status(404).json({ message: "Not found" });
    res.json(storage.getProject(id));
  });

  app.get("/api/projects/:id/members", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id)) return res.status(404).json({ message: "Not found" });
    res.json(storage.listProjectMembers(id).map(sanitize));
  });

  app.get("/api/projects/:id/channels", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id)) return res.status(404).json({ message: "Not found" });
    res.json(storage.listChannelsByProject(id));
  });

  app.post("/api/projects/:id/channels", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id)) return res.status(404).json({ message: "Not found" });
    const parsed = insertChannelSchema.omit({ projectId: true, position: true }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input" });
    const existing = storage.listChannelsByProject(id);
    const channel = storage.createChannel({ ...parsed.data, projectId: id, position: existing.length });
    res.json(channel);
  });

  // ── MESSAGES ──
  app.get("/api/channels/:id/messages", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const allMsgs = storage.listMessages(channelId, { before, limit });
    // Exclude thread replies from main timeline
    const msgs = allMsgs.filter(m => !m.replyToMessageId);
    const ids = msgs.map(m => m.id);
    const rxns = storage.listReactions(ids);
    const grouped = new Map<number, Map<string, { emoji: string; count: number; userIds: number[] }>>();
    for (const r of rxns) {
      if (!grouped.has(r.messageId)) grouped.set(r.messageId, new Map());
      const g = grouped.get(r.messageId)!;
      const item = g.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [] };
      item.count++;
      item.userIds.push(r.userId);
      g.set(r.emoji, item);
    }
    const atts = storage.listAttachmentsForMessages(ids);
    const { getStorageBackend } = await import("./storage-files");
    const backend = getStorageBackend();
    const attsByMsg = new Map<number, any[]>();
    for (const a of atts) {
      const list = attsByMsg.get(a.messageId!) ?? [];
      const publicUrl = backend.publicUrl(a.storageKey);
      const thumbPublic = a.thumbnailKey ? backend.publicUrl(a.thumbnailKey) : null;
      list.push({
        id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes,
        url: publicUrl ?? `/api/files/${a.id}`,
        thumbnailUrl: thumbPublic ?? (a.thumbnailKey ? `/api/files/${a.id}?thumb=1` : null),
        createdAt: a.createdAt,
      });
      attsByMsg.set(a.messageId!, list);
    }
    const mentionsRaw = storage.listMentionsForMessages(ids);
    const mentionsByMsg = new Map<number, Array<{ userId: number | null; type: string }>>();
    for (const m of mentionsRaw) {
      const list = mentionsByMsg.get(m.messageId) ?? [];
      list.push({ userId: m.mentionedUserId, type: m.type });
      mentionsByMsg.set(m.messageId, list);
    }
    const replyCounts = storage.threadReplyCounts(ids);
    const wire = msgs.map(m => ({
      ...m,
      ...authorFor(m.userId),
      reactions: Array.from(grouped.get(m.id)?.values() ?? []),
      attachmentsList: attsByMsg.get(m.id) ?? [],
      mentions: mentionsByMsg.get(m.id) ?? [],
      replyCount: replyCounts.get(m.id)?.count ?? 0,
      lastReplyAt: replyCounts.get(m.id)?.lastAt ? new Date((replyCounts.get(m.id)!.lastAt) * 1000).toISOString() : null,
    }));
    res.json(wire);
  });

  app.post("/api/channels/:id/messages", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });
    if (access.channel?.type === "voice") return res.status(400).json({ message: "Cannot post text to a voice channel" });
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input" });

    const msg = storage.createMessage({
      channelId,
      userId: u.id,
      content: parsed.data.content,
      attachments: parsed.data.attachments ? JSON.stringify(parsed.data.attachments) : null,
      replyToMessageId: parsed.data.replyToMessageId ?? null,
    });

    // Link uploaded attachments (created via /api/uploads) to this message
    if (parsed.data.attachmentIds && parsed.data.attachmentIds.length > 0) {
      storage.linkAttachmentsToMessage(parsed.data.attachmentIds, msg.id, u.id);
    }

    // Parse + persist mentions
    const projectId = access.project!.id;
    const members = storage.listProjectMembers(projectId);
    const mentions = parseMentions(parsed.data.content, members.map(m => ({ id: m.id, name: m.name })));
    storage.createMentions(msg.id, mentions);

    const wire = buildWireMessage(msg.id)!;
    (wire as any).mentions = mentions.map(m => ({ userId: m.userId, type: m.type }));
    (wire as any).replyCount = 0;
    emitMessageNew(u.orgId, wire);

    // Push routing
    const now = Date.now();
    const userMentions = new Set(mentions.filter(m => m.type === "user" && m.userId != null).map(m => m.userId as number));
    const hasEveryone = mentions.some(m => m.type === "everyone");
    const hasHere = mentions.some(m => m.type === "here");

    const recipientIds = new Set<number>();
    for (const m of members) {
      if (m.id === u.id) continue;
      if (userMentions.has(m.id)) { recipientIds.add(m.id); continue; }
      if (hasEveryone) { recipientIds.add(m.id); continue; }
      const lastSeen = m.lastSeenAt ? new Date(m.lastSeenAt).getTime() : 0;
      const isOnline = (now - lastSeen) < 60_000;
      if (hasHere && isOnline) { recipientIds.add(m.id); continue; }
      // Default: only push if not active
      if (!hasHere && !hasEveryone && !isOnline) recipientIds.add(m.id);
    }

    if (recipientIds.size > 0) {
      void sendNotificationToUsers(Array.from(recipientIds), {
        title: `#${access.channel!.name} · ${access.project!.name}`,
        body: `${u.name}: ${parsed.data.content.slice(0, 140)}`,
        url: `/#/channels/${channelId}/m/${msg.id}`,
        tag: `channel-${channelId}`,
      });
    }

    res.json(wire);
  });

  app.patch("/api/messages/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const existing = storage.getMessage(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (existing.userId !== u.id) return res.status(403).json({ message: "Only the author can edit" });
    const content = String(req.body?.content ?? "").trim();
    if (content.length === 0 || content.length > 4000) return res.status(400).json({ message: "Content invalid" });
    const updated = storage.updateMessage(id, content);
    if (!updated) return res.status(404).json({ message: "Not found" });
    const wire = buildWireMessage(id)!;
    emitMessageUpdate(u.orgId, wire);
    res.json(wire);
  });

  app.delete("/api/messages/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const msg = storage.getMessage(id);
    if (!msg) return res.status(404).json({ message: "Not found" });
    if (msg.userId !== u.id && u.role !== "admin") return res.status(403).json({ message: "Not allowed" });
    storage.deleteMessage(id);
    emitMessageDelete(u.orgId, { channelId: msg.channelId, messageId: id });
    res.json({ ok: true });
  });

  app.post("/api/messages/:id/pin", requireAuth, requireRole(["admin", "foreman", "safety"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const msg = storage.getMessage(id);
    if (!msg) return res.status(404).json({ message: "Not found" });
    const updated = storage.pinMessage(id, !msg.isPinned);
    const wire = buildWireMessage(id)!;
    emitMessageUpdate(u.orgId, wire);
    res.json(updated);
  });

  app.post("/api/messages/:id/reactions", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const msg = storage.getMessage(id);
    if (!msg) return res.status(404).json({ message: "Not found" });
    const parsed = reactionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid emoji" });
    storage.addReaction(id, u.id, parsed.data.emoji);
    emitReactionChange(u.orgId, { messageId: id, channelId: msg.channelId });
    res.json(buildWireMessage(id));
  });

  app.delete("/api/messages/:id/reactions/:emoji", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const emoji = decodeURIComponent(req.params.emoji);
    const msg = storage.getMessage(id);
    if (!msg) return res.status(404).json({ message: "Not found" });
    storage.removeReaction(id, u.id, emoji);
    emitReactionChange(u.orgId, { messageId: id, channelId: msg.channelId });
    res.json(buildWireMessage(id));
  });

  // ── INVITES ──
  app.post("/api/projects/:id/invites", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const projectId = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, projectId)) return res.status(404).json({ message: "Not found" });
    const parsed = insertInviteSchema.omit({ orgId: true, projectId: true }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input" });
    const token = nanoid(28);
    const invite = storage.createInvite({
      orgId: u.orgId,
      projectId,
      email: parsed.data.email ?? null,
      role: parsed.data.role,
      token,
      invitedByUserId: u.id,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const inviteUrl = `${proto}://${host}/#/accept-invite/${token}`;
    res.json({ invite, url: inviteUrl });
  });

  app.get("/api/invites/:token", (req, res) => {
    const invite = storage.getInviteByToken(req.params.token);
    if (!invite) return res.status(404).json({ message: "Invite not found" });
    if (invite.acceptedAt) return res.status(410).json({ message: "Invite already used" });
    if (new Date(invite.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Invite expired" });
    const org = storage.getOrg(invite.orgId);
    const inviter = storage.getUser(invite.invitedByUserId);
    res.json({
      orgName: org?.name ?? "Vector Services",
      role: invite.role,
      inviterName: inviter?.name ?? "Admin",
    });
  });

  app.post("/api/auth/accept-invite", (req, res) => {
    const parsed = acceptInviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input" });
    const invite = storage.getInviteByToken(parsed.data.token);
    if (!invite) return res.status(404).json({ message: "Invite not found" });
    if (invite.acceptedAt) return res.status(410).json({ message: "Invite already used" });
    if (new Date(invite.expiresAt).getTime() < Date.now()) return res.status(410).json({ message: "Invite expired" });

    const email = invite.email ?? `${nanoid(8)}@vector-invite.local`;
    if (storage.getUserByEmail(email)) return res.status(409).json({ message: "Email already registered" });

    const user = storage.createUser({
      orgId: invite.orgId,
      email,
      passwordHash: hashPassword(parsed.data.password),
      name: parsed.data.name,
      title: null,
      avatarUrl: null,
      hue: 218,
      role: invite.role,
      status: "online",
    });
    if (invite.projectId) storage.addProjectMember(invite.projectId, user.id, "member");
    storage.markInviteAccepted(invite.id);

    const token = signJwt(user.id);
    setAuthCookie(res, token);
    res.json({ token, user: sanitize(user), org: storage.getOrg(user.orgId) });
  });

  // ── VOICE / LIVEKIT ──
  app.post("/api/channels/:id/voice/token", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });
    if (access.channel?.type !== "voice") return res.status(400).json({ message: "Not a voice channel" });

    if (!livekitConfigured()) {
      return res.status(503).json({
        preview_mode: true,
        message: "LiveKit not configured — preview mode only. Add LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL to environment.",
      });
    }
    const roomName = `vector-${u.orgId}-channel-${channelId}`;
    const token = await generateLivekitToken({
      userId: u.id, userName: u.name, roomName, canPublish: true,
    });
    res.json({ token, ws_url: process.env.LIVEKIT_WS_URL, room_name: roomName });
  });

  // ── DIRECT (1:1) CALLS ──
  // Start a 1:1 call. Creates a direct_call row in 'ringing' state, mints
  // LiveKit tokens for both peers (returns the caller's), and fires SSE +
  // web-push to the callee so their browser/PWA can show an incoming call.
  app.post("/api/calls/start", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const calleeId = Number(req.body?.calleeId);
    const kind = (req.body?.kind === "video" ? "video" : "voice") as "voice" | "video";
    if (!calleeId || calleeId === u.id) return res.status(400).json({ message: "Invalid callee" });
    const callee = storage.getUser(calleeId);
    if (!callee || callee.orgId !== u.orgId) return res.status(404).json({ message: "User not found" });
    if (callee.deactivated) return res.status(400).json({ message: "User is deactivated" });

    if (!livekitConfigured()) {
      return res.status(503).json({ message: "Calling unavailable: LiveKit not configured" });
    }

    // Pre-allocate the row so we have an id for the room name.
    const row = storage.createDirectCall({
      orgId: u.orgId, callerId: u.id, calleeId, roomName: "", kind,
    });
    const roomName = `direct-${row.id}`;
    // Update the row with the now-known roomName. Drizzle has no
    // "update returning" in this layer, so re-fetch.
    storage.updateDirectCallStatus(row.id, "ringing");
    // Persist roomName via raw SQL since it's a single field and we
    // already loaded the schema. We use the storage method indirectly
    // by updating status (already done) and patching room_name here.
    (await import("./db")).rawDb.prepare(`UPDATE direct_calls SET room_name = ? WHERE id = ?`).run(roomName, row.id);

    const token = await generateLivekitToken({
      userId: u.id, userName: u.name, roomName, canPublish: true,
    });

    const payload: CallEventPayload = {
      callId: row.id, callerId: u.id, calleeId,
      callerName: u.name, callerHue: u.hue, kind, roomName,
    };
    emitCallIncoming(payload);

    // Fire push notification to the callee — the in-tab SSE catches the
    // call when chat is open; the push wakes the device when it isn't.
    void sendNotificationToUsers([calleeId], {
      title: `\ud83d\udcde ${u.name} is calling`,
      body: kind === "video" ? "Incoming video call" : "Incoming voice call",
      url: `/call/${row.id}`,
      tag: `call-${row.id}`,
    });

    // Auto-miss after 45s if not answered. Setinterval/timeout is fine
    // for a single-instance Render deployment; if we ever scale out
    // we'll need a job queue.
    setTimeout(() => {
      const current = storage.getDirectCall(row.id);
      if (current && current.status === "ringing") {
        storage.updateDirectCallStatus(row.id, "missed", { endedAt: new Date() });
        emitCallEnded({ ...payload, reason: "missed" });
      }
    }, 45_000);

    res.json({
      callId: row.id,
      roomName,
      token,
      ws_url: process.env.LIVEKIT_WS_URL,
    });
  });

  // Callee accepts. Mints their token and flips the row to 'active'.
  app.post("/api/calls/:id/accept", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const call = storage.getDirectCall(id);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    if (call.calleeId !== u.id) return res.status(403).json({ message: "Not your call" });
    if (call.status !== "ringing") return res.status(409).json({ message: `Call already ${call.status}` });

    storage.updateDirectCallStatus(id, "active", { answeredAt: new Date() });
    const token = await generateLivekitToken({
      userId: u.id, userName: u.name, roomName: call.roomName, canPublish: true,
    });
    const caller = storage.getUser(call.callerId);
    const payload: CallEventPayload = {
      callId: call.id, callerId: call.callerId, calleeId: call.calleeId,
      callerName: caller?.name ?? "", callerHue: caller?.hue ?? 220,
      kind: call.kind as "voice" | "video", roomName: call.roomName,
    };
    emitCallAccepted(payload);
    res.json({ callId: id, roomName: call.roomName, token, ws_url: process.env.LIVEKIT_WS_URL });
  });

  // Either peer can decline (callee) or end (either). 'decline' marks
  // 'declined' if not yet active; otherwise treated as 'ended'.
  app.post("/api/calls/:id/end", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const action = (req.body?.action === "decline" ? "decline" : "end") as "decline" | "end";
    const call = storage.getDirectCall(id);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    if (call.callerId !== u.id && call.calleeId !== u.id) {
      return res.status(403).json({ message: "Not your call" });
    }
    if (call.status === "ended" || call.status === "missed" || call.status === "declined") {
      return res.json({ ok: true, status: call.status }); // idempotent
    }
    const nextStatus = action === "decline" && call.status === "ringing" ? "declined" : "ended";
    storage.updateDirectCallStatus(id, nextStatus, { endedAt: new Date() });
    const caller = storage.getUser(call.callerId);
    emitCallEnded({
      callId: call.id, callerId: call.callerId, calleeId: call.calleeId,
      callerName: caller?.name ?? "", callerHue: caller?.hue ?? 220,
      kind: call.kind as "voice" | "video", roomName: call.roomName,
      reason: nextStatus === "declined" ? "declined" : "ended",
    });
    res.json({ ok: true, status: nextStatus });
  });

  // Fetch call details + a fresh token (used by /call/:id page on direct
  // navigation, e.g. when the push notification is clicked).
  app.get("/api/calls/:id", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const call = storage.getDirectCall(id);
    if (!call || call.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    if (call.callerId !== u.id && call.calleeId !== u.id) {
      return res.status(403).json({ message: "Not your call" });
    }
    const otherId = call.callerId === u.id ? call.calleeId : call.callerId;
    const other = storage.getUser(otherId);
    // Only mint a token if the call is still live; ended calls just
    // return metadata so the page can render a "Call ended" state.
    let token: string | null = null;
    if (livekitConfigured() && (call.status === "ringing" || call.status === "active")) {
      token = await generateLivekitToken({
        userId: u.id, userName: u.name, roomName: call.roomName, canPublish: true,
      });
    }
    res.json({
      call: {
        id: call.id,
        callerId: call.callerId,
        calleeId: call.calleeId,
        roomName: call.roomName,
        kind: call.kind,
        status: call.status,
        startedAt: call.startedAt,
      },
      other: other ? {
        id: other.id, name: other.name, hue: other.hue, role: other.role, title: other.title,
      } : null,
      iAm: call.callerId === u.id ? "caller" : "callee",
      token,
      ws_url: process.env.LIVEKIT_WS_URL,
    });
  });

  // ── PUSH ──
  app.get("/api/push/vapid-public-key", (_req, res) => {
    const key = getPublicVapidKey();
    res.json({ key, configured: pushConfigured() });
  });
  app.post("/api/push/subscribe", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = req.body?.subscription ?? req.body;
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      return res.status(400).json({ message: "Invalid subscription" });
    }
    const sub = storage.addPushSubscription({
      userId: u.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      deviceLabel: req.body?.deviceLabel ?? null,
    });
    res.json(sub);
  });
  app.delete("/api/push/subscribe/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    storage.deletePushSubscription(Number(req.params.id), u.id);
    res.json({ ok: true });
  });

  // ── SSE EVENTS ──
  app.get("/api/events", (req: Request, res: Response) => {
    // Support token via query (EventSource cannot set headers)
    let token = (req.query.token as string) || null;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) token = authHeader.slice(7);
    }
    if (!token) {
      const cookie = req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`));
      if (cookie) token = decodeURIComponent(cookie[1]);
    }
    if (!token) return res.status(401).end();
    const userId = (async () => {
      const { verifyJwt } = await import("./auth");
      return verifyJwt(token!);
    })();
    Promise.resolve(userId).then(async (uid) => {
      if (!uid) return res.status(401).end();
      const user = storage.getUser(uid);
      if (!user) return res.status(401).end();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ userId: uid })}\n\n`);
      const sub = { userId: uid, orgId: user.orgId, res };
      addSubscriber(sub);
      req.on("close", () => removeSubscriber(sub));
    });
  });
}
