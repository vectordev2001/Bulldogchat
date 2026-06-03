import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { nanoid } from "nanoid";
import { storage, sanitize } from "./storage";
import {
  signupSchema, loginSchema, acceptInviteSchema, sendMessageSchema, reactionSchema,
  insertProjectSchema, insertChannelSchema, insertInviteSchema, channelCreateSchema,
} from "@shared/schema";
import { hashPassword, verifyPassword, signJwt, requireAuth, requireRole, setAuthCookie, clearAuthCookie, AuthedRequest, AUTH_COOKIE } from "./auth";
import { addSubscriber, removeSubscriber, emitMessageNew, emitMessageDelete, emitMessageUpdate, emitReactionChange, emitChannelDelete, emitCallIncoming, emitCallAccepted, emitCallEnded, emitPresenceChange, type CallEventPayload, WireMessage } from "./events";
import { generateLivekitToken, livekitConfigured, listRoomParticipantIdentities } from "./livekit";
import { setupWebPush, pushConfigured, getPublicVapidKey, sendNotificationToUsers } from "./push";
import { runMigrations } from "./migrate";
import { runSeed } from "./seed";
import { registerV2Routes, parseMentions } from "./routes-v2";
import { registerWorkObjectRoutes } from "./routes-work-objects";
import { registerIntegrationRoutes } from "./routes-integrations";
import { bulldogSsoBridge } from "./bulldog-sso";
import { dialPhoneIntoRoom, sipConfigured } from "./sip";
import { signCallJoinToken, verifyCallJoinToken, sendSms, smsAvailable, buildCallInviteSmsBody } from "./sms";
import { registerScheduledCallRoutes, startReminderLoop } from "./scheduled-calls";

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
  return { ...msg, meta: parseMessageMeta((msg as any).meta), ...author, reactions: Array.from(grouped.values()), attachmentsList } as any;
}

// Messages can carry a JSON `meta` blob (system-message kind, work-object
// refs, field diffs, etc.). The column is stored as TEXT; we parse on the
// way out and tolerate corruption silently — a bad meta string just means
// the message renders as a normal user message.
function parseMessageMeta(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return null; }
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
  const user = storage.getUser(userId);
  if (!user) return null;
  if (!storage.userCanSeeChannel(channel, user)) return null;
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
  registerWorkObjectRoutes(app);
  registerIntegrationRoutes(app);
  registerScheduledCallRoutes(app);
  // Kick off the in-process reminder loop. Cheap (60s tick), idempotent.
  startReminderLoop();

  // Health
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: APP_VERSION, db: "connected", livekit: livekitConfigured(), push: pushConfigured() });
  });

  // ── CALL JOIN LINK (SMS deep-link) ──
  // SMS contains: https://chat.bulldogops.com/call-join?t=<JWT>
  //
  // Flow:
  //   1. User taps the SMS link. Server checks for a bulldog_access cookie.
  //   2. If signed-in, the SSO bridge will mint the chat JWT downstream;
  //      we redirect to the SPA hash route /#/call-join/<t> which calls
  //      /api/call-join/redeem to get a LiveKit token and joins.
  //   3. If NOT signed-in, we bounce to auth.bulldogops.com/?next=<url>
  //      which loops back here after login.
  //
  // The JWT carries: userId (the invitee), roomName, callerName, kind.
  // We force SSO login (per Josh's spec) so the user has a real chat
  // identity before joining — the token only identifies WHICH user we
  // expect, not WHO is on the device.
  app.get("/call-join", (req, res) => {
    const t = String(req.query.t || "");
    if (!t) return res.status(400).send("Missing token");
    // Quick validation: reject obviously-bad tokens before bouncing through
    // auth so we don't waste a login round-trip.
    const payload = verifyCallJoinToken(t);
    if (!payload) return res.status(401).send("This call link has expired. Ask the organizer to resend.");
    // Detect an existing chat session OR bulldog-auth session via cookies.
    const cookieHeader = req.headers.cookie || "";
    const hasAuthCookie =
      /(?:^|;\s*)bulldog_access=/.test(cookieHeader) ||
      new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=`).test(cookieHeader);
    if (hasAuthCookie) {
      // SSO bridge will resolve the chat JWT on the way to the SPA. Hash
      // route survives any further redirects the SPA does.
      return res.redirect(`/#/call-join/${encodeURIComponent(t)}`);
    }
    // Bounce through auth, asking auth to send us back here.
    const back = `${process.env.CHAT_BASE_URL || "https://chat.bulldogops.com"}/call-join?t=${encodeURIComponent(t)}`;
    const authBase = process.env.BULLDOG_AUTH_URL || "https://auth.bulldogops.com";
    return res.redirect(`${authBase}/?next=${encodeURIComponent(back)}`);
  });

  // POST /api/call-join/redeem: client posts the SMS token here AFTER
  // they're logged in via SSO. We confirm the logged-in chat user matches
  // the token's userId, then mint a LiveKit token for the room. If the
  // device-side user is different from the token's userId (e.g. shared
  // phone, organizer forwarded the link), we accept it but tag the
  // participant identity as the actual signed-in user so accountability
  // is preserved.
  app.post("/api/call-join/redeem", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const t = String((req.body ?? {}).token || "");
    if (!t) return res.status(400).json({ message: "token required" });
    const payload = verifyCallJoinToken(t);
    if (!payload) return res.status(401).json({ message: "Invalid or expired join link" });
    if (!livekitConfigured()) {
      return res.status(503).json({ message: "Calling unavailable: LiveKit not configured" });
    }
    const me = storage.getUser(u.id);
    if (!me || me.deactivated) return res.status(403).json({ message: "User inactive" });
    try {
      // Always use the SIGNED-IN user's identity for the LiveKit join —
      // never the token's userId. The token only authorizes 'this room
      // is open to this person'; the actual identity must reflect who
      // is on the device.
      const lkToken = await generateLivekitToken({
        userId: me.id,
        userName: me.name,
        roomName: payload.roomName,
        canPublish: true,
      });
      res.json({
        roomName: payload.roomName,
        token: lkToken,
        ws_url: process.env.LIVEKIT_WS_URL,
        callerName: payload.callerName,
        kind: payload.kind,
        userName: me.name,
        userHue: me.hue,
      });
    } catch (e: any) {
      console.error("[call-join/redeem] failed:", e);
      res.status(500).json({ message: "Failed to issue call token" });
    }
  });

  // ── AUTH ──
  // Phase 1.9.2 — user creation is centralized in bulldog-auth. Chat must
  // not provision its own users, otherwise an unauthenticated attacker can
  // POST here and become an org admin. Returns 410 Gone with a redirect
  // hint so any stale client gets a clear error instead of silently failing.
  app.post("/api/auth/signup", (_req, res) => {
    res.status(410).json({
      message: "Self-signup is disabled. Ask your admin to add you on auth.bulldogops.com.",
      redirect: "https://auth.bulldogops.com/",
      code: "signup_disabled",
    });
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
  // Returns every user in the caller's org. For any member with a null
  // `phone`, we opportunistically backfill from bulldog-auth using the
  // caller's own bulldog_access cookie (works because the auth admin API
  // is gated on admin role and Josh — the main caller — is admin). This
  // closes the gap where a user's chat row was provisioned before their
  // phone was set in auth and never re-synced (e.g. John Hotek).
  app.get("/api/org/members", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    let list = storage.listUsersByOrg(u.orgId).map(sanitize);

    // Admin sync from bulldog-auth: backfill phones AND soft-delete ghost
    // users (deleted/deactivated in auth but still showing in chat). We
    // only run this when the caller is an admin because auth's admin API
    // 403s for everyone else. Cheap operations — we just hit
    // /api/admin/users once.
    const me = storage.getUser(u.id);
    if (me?.role === "admin") {
      try {
        // Forward the caller's bulldog-auth cookie verbatim. If they don't
        // have one (e.g. legacy HS256-only chat login) we silently skip.
        const cookieHeader = req.headers.cookie || "";
        const hasAuthCookie = /(?:^|;\s*)bulldog_access=/.test(cookieHeader);
        if (hasAuthCookie) {
          const authBase = process.env.BULLDOG_AUTH_URL || "https://auth.bulldogops.com";
          const resp = await fetch(`${authBase}/api/admin/users`, {
            headers: { Cookie: cookieHeader },
          });
          if (resp.ok) {
            // Auth wraps the list as { users: [...] }; tolerate either shape.
            const body = (await resp.json()) as
              | { users?: Array<{ email?: string; phone?: string | null; active?: boolean }> }
              | Array<{ email?: string; phone?: string | null; active?: boolean }>;
            const authUsers = Array.isArray(body) ? body : (body.users ?? []);
            const phoneByEmail = new Map<string, string>();
            const activeEmails = new Set<string>();
            for (const au of authUsers) {
              if (!au.email) continue;
              const e = au.email.toLowerCase();
              if (au.active !== false) activeEmails.add(e);
              if (au.phone) phoneByEmail.set(e, au.phone);
            }
            // 1) Persist phones into chat DB so subsequent calls don't re-hit auth.
            for (const m of list) {
              if (m.phone) continue;
              const fresh = phoneByEmail.get(m.email.toLowerCase());
              if (fresh) {
                try { storage.updateUser(m.id, { phone: fresh }); }
                catch (e) { console.warn("[org/members] phone backfill update failed:", e); }
              }
            }
            // 2) Ghost roster cleanup: any chat user whose email is NOT in
            //    auth's active set gets soft-deactivated. Skip the caller
            //    themselves (no self-lockout), already-deactivated rows,
            //    and system-deleted emails (deleted-*@deleted.local).
            for (const m of list) {
              if (m.deactivated) continue;
              if (m.id === u.id) continue;
              const e = m.email.toLowerCase();
              if (e.endsWith("@deleted.local")) continue;
              if (!activeEmails.has(e)) {
                try {
                  storage.setUserDeactivated(m.id, true);
                  console.log(`[org/members] ghost cleanup: deactivated chat user ${m.id} (${m.email}) — not in auth active set`);
                } catch (err) {
                  console.warn("[org/members] ghost cleanup failed:", err);
                }
              }
            }
            // Re-read so the response reflects backfills + deactivations.
            list = storage.listUsersByOrg(u.orgId).map(sanitize);
          }
        }
      } catch (e) {
        console.warn("[org/members] auth sync failed:", e);
      }
    }

    res.json(list);
  });

  // ── PRESENCE (Phase 1.9) ──
  // Client posts here when the user picks a status from the top-bar popover,
  // when the idle detector flips to 'away', or on page-hide to 'offline'.
  // Server persists and fans out via SSE so the dot updates everywhere.
  app.post("/api/presence", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const raw = String((req.body ?? {}).presence ?? "").toLowerCase();
    const allowed = ["online", "away", "busy", "offline"] as const;
    type Presence = typeof allowed[number];
    if (!(allowed as readonly string[]).includes(raw)) {
      return res.status(400).json({ message: "presence must be online|away|busy|offline" });
    }
    const presence = raw as Presence;
    storage.updateUser(u.id, { presence });
    // Also bump lastSeenAt so the legacy idle indicator stays consistent.
    storage.updateUserLastSeen(u.id);
    emitPresenceChange(u.orgId, { userId: u.id, presence });
    res.json({ ok: true, presence });
  });

  // ── PROJECTS ──
  app.get("/api/projects", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    // Phase 1.8: admins see every company in their org (so admin tooling
    // and the company switcher are fully populated). Non-admins see only
    // the companies they're a member of via project_members.
    const projects = storage.listProjectsForUserInOrg(u.id, u.orgId);
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
    // Scope-aware list: admins see everything; others only see channels they
    // are permitted by scope (global / matching entity / matching team-role /
    // private membership).
    res.json(storage.listChannelsForUserInProject(id, u.id));
  });

  app.post("/api/projects/:id/channels", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id)) return res.status(404).json({ message: "Not found" });
    const parsed = channelCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input" });
    // Phase 1.8: if the caller wants to nest this channel under a Job
    // (work_object), make sure that job lives in the same company. Cross-
    // company nesting would be confusing in the sidebar.
    let workObjectId: number | null = null;
    if (parsed.data.workObjectId) {
      const job = storage.getWorkObject(parsed.data.workObjectId);
      if (!job || job.orgId !== u.orgId || (job.projectId ?? null) !== id) {
        return res.status(400).json({ message: "Job does not belong to this company" });
      }
      workObjectId = job.id;
    }
    const existing = storage.listChannelsByProject(id);
    const channel = storage.createChannel({
      projectId: id,
      workObjectId,
      position: existing.length,
      name: parsed.data.name,
      type: parsed.data.type,
      topic: parsed.data.topic ?? null,
      scope: parsed.data.scope,
      entityId: parsed.data.scope === "entity" ? parsed.data.entityId ?? null : null,
      teamRole: parsed.data.scope === "team" ? parsed.data.teamRole ?? null : null,
    });
    // Seed private membership. Caller is always added so they don't lose
    // access to the channel they just created.
    if (parsed.data.scope === "private") {
      const ids = new Set<number>(parsed.data.memberIds ?? []);
      ids.add(u.id);
      // Filter to org members only (defence-in-depth).
      const orgMemberIds = new Set(storage.listUsersByOrg(u.orgId).map(m => m.id));
      const filtered = Array.from(ids).filter(id => orgMemberIds.has(id));
      storage.addChannelMembers(channel.id, filtered);
    }
    res.json(channel);
  });

  // List members of a private channel (admin/creator visibility, but here
  // we allow any project member who can see the channel to read the roster).
  app.get("/api/channels/:id/members", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });
    const ids = storage.listChannelMemberIds(channelId);
    res.json(storage.listUsersByIds(ids).map(sanitize));
  });

  // Add members to a private channel. Admins only — keeps the surface
  // small. Foreman can be added later if needed.
  app.post("/api/channels/:id/members", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access || !access.channel) return res.status(404).json({ message: "Not found" });
    // Any scope can have explicit members — they serve as extra grants on
    // top of the scope's built-in visibility (entity/team/global).
    const raw = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const wanted = raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0);
    if (wanted.length === 0) return res.status(400).json({ message: "userIds required" });
    const orgMemberIds = new Set(storage.listUsersByOrg(u.orgId).map(m => m.id));
    const filtered = wanted.filter((id: number) => orgMemberIds.has(id));
    storage.addChannelMembers(channelId, filtered);
    res.json({ ok: true, memberIds: storage.listChannelMemberIds(channelId) });
  });

  // Remove a channel member. Admins can remove anyone; a non-admin can
  // only remove themself (self-leave). Scope-specific channels keep their
  // role/entity visibility — the removal only strips the explicit grant.
  app.delete("/api/channels/:id/members/:userId", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access || !access.channel) return res.status(404).json({ message: "Not found" });
    if (u.role !== "admin" && targetId !== u.id) {
      return res.status(403).json({ message: "Only admins can remove other members" });
    }
    storage.removeChannelMember(channelId, targetId);
    res.json({ ok: true });
  });

  // ── PHASE 1.8: ADMIN MOVE CHANNEL ──
  // Admin-only. Re-home a channel to a different company (projectId) and/or
  // nest it under a different Job (workObjectId). Used by the "Move channel"
  // admin action in the sidebar context menu.
  //
  // Cross-company rules:
  //   - Target company must be in the same org as the caller.
  //   - If workObjectId is provided, that job must belong to the target
  //     company. NULL workObjectId moves the channel back to company-global.
  //   - We do NOT touch channel_members on move — explicit private grants
  //     are preserved (admins can edit membership separately).
  app.patch("/api/channels/:id", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "Not found" });
    // Source company must be in caller's org.
    const srcProject = storage.getProject(channel.projectId);
    if (!srcProject || srcProject.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });

    const patch: { name?: string; topic?: string | null; projectId?: number; workObjectId?: number | null; position?: number } = {};
    if (typeof req.body?.name === "string" && req.body.name.trim().length > 0) {
      patch.name = String(req.body.name).slice(0, 80);
    }
    if (req.body?.topic === null || typeof req.body?.topic === "string") {
      patch.topic = req.body.topic === null ? null : String(req.body.topic).slice(0, 500);
    }
    if (typeof req.body?.position === "number" && Number.isFinite(req.body.position)) {
      patch.position = req.body.position;
    }

    // Resolve target company. Default = current.
    let targetProjectId = channel.projectId;
    if (req.body?.projectId !== undefined && req.body.projectId !== null) {
      const pid = Number(req.body.projectId);
      if (!Number.isFinite(pid)) return res.status(400).json({ message: "Invalid projectId" });
      const target = storage.getProject(pid);
      if (!target || target.orgId !== u.orgId) return res.status(400).json({ message: "Target company not found" });
      targetProjectId = pid;
      if (pid !== channel.projectId) patch.projectId = pid;
    }

    // Resolve target job. Explicit null = move to company-global.
    if (req.body?.workObjectId === null) {
      patch.workObjectId = null;
    } else if (req.body?.workObjectId !== undefined) {
      const woid = Number(req.body.workObjectId);
      if (!Number.isFinite(woid)) return res.status(400).json({ message: "Invalid workObjectId" });
      const job = storage.getWorkObject(woid);
      if (!job || job.orgId !== u.orgId || (job.projectId ?? null) !== targetProjectId) {
        return res.status(400).json({ message: "Job does not belong to the target company" });
      }
      patch.workObjectId = woid;
    } else if (patch.projectId !== undefined && channel.workObjectId !== null) {
      // Moving to a new company but no job specified — clear the job link
      // (the old job lives in the old company and would be invalid here).
      patch.workObjectId = null;
    }

    if (Object.keys(patch).length === 0) return res.json(channel);
    const updated = storage.updateChannel(channelId, patch);
    res.json(updated);
  });

  // ── PHASE 1.9: ADMIN DELETE CHANNEL ──
  // Admin-only: cascade-delete a channel and all of its messages,
  // reactions, mentions, read receipts, member grants, recordings, and
  // livekit room rows. The channel's company must belong to the caller's
  // org. This is destructive and irreversible.
  app.delete("/api/channels/:id", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Invalid id" });
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "Not found" });
    const project = storage.getProject(channel.projectId);
    if (!project || project.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    try {
      storage.deleteChannelCascade(channelId);
      // Push the deletion to every live client in the org so their
      // sidebars/active views update without a manual refresh.
      emitChannelDelete(u.orgId, { channelId, deletedByUserId: u.id });
      res.json({ ok: true, deleted: { type: "channel", id: channelId } });
    } catch (err) {
      console.error("[delete-channel]", err);
      res.status(500).json({ message: "Failed to delete channel" });
    }
  });

  // ── PHASE 1.8: COMPANY MEMBERSHIP ──
  // Admins can grant/revoke access to a company. Flat membership — no
  // per-company roles (the user's org-level role still governs what they
  // can do).
  app.post("/api/projects/:id/members", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const projectId = Number(req.params.id);
    const project = storage.getProject(projectId);
    if (!project || project.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    const raw = Array.isArray(req.body?.userIds) ? req.body.userIds : (typeof req.body?.userId === "number" ? [req.body.userId] : []);
    const wanted = raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0);
    if (wanted.length === 0) return res.status(400).json({ message: "userIds required" });
    const orgMemberIds = new Set(storage.listUsersByOrg(u.orgId).map(m => m.id));
    let added = 0;
    for (const uid of wanted) {
      if (!orgMemberIds.has(uid)) continue;
      storage.addProjectMember(projectId, uid);
      added += 1;
    }
    res.json({ ok: true, added, memberIds: storage.listProjectMembers(projectId).map(m => m.id) });
  });

  app.delete("/api/projects/:id/members/:userId", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const projectId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    const project = storage.getProject(projectId);
    if (!project || project.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    // Don't let an admin remove themself from a company by accident — they
    // can lose admin tooling on that surface. They can still revoke other
    // admins; the UI gates this with a confirm.
    if (targetId === u.id) return res.status(400).json({ message: "Use a different admin to remove yourself" });
    storage.removeProjectMember(projectId, targetId);
    res.json({ ok: true });
  });

  // ── SINGLE CHANNEL (for deep-link) ──
  app.get("/api/channels/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "bad id" });
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });
    return res.json({ ...access.channel, projectId: access.project!.id });
  });

  // ─────────────── DIRECT MESSAGES ───────────────
  // DMs are modeled as channels with scope='dm' under the user's home project.
  // This lets messages/reactions/attachments/mentions/push all reuse channel
  // infrastructure. The two endpoints here surface DM threads to the sidebar.
  //
  // The DM thread itself is read/written via the regular channel message
  // endpoints (/api/channels/:id/messages) — the only difference is the
  // scope='dm' row in the channels table.

  // List every DM channel the caller is part of, decorated with member ids
  // and counts so the sidebar can render names without a second round-trip.
  app.get("/api/dms", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const chs = storage.listDmChannelsForUser(u.id);
    const wire = chs.map(c => ({
      ...c,
      memberIds: storage.listChannelMemberIds(c.id),
    }));
    res.json(wire);
  });

  // Find-or-create a DM channel for the given member set. The caller is
  // always implicitly included. Idempotent: passing the same member set
  // returns the same channel row, so the picker doesn't accidentally spawn
  // duplicate threads.
  app.post("/api/dms", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = req.body ?? {};
    const rawIds = Array.isArray(body.memberIds) ? body.memberIds : [];
    const memberIds: number[] = [];
    for (const v of rawIds) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n !== u.id) memberIds.push(n);
    }
    if (memberIds.length === 0) {
      return res.status(400).json({ message: "At least one other member is required" });
    }
    if (memberIds.length > 20) {
      return res.status(400).json({ message: "Group DMs are capped at 20 other members" });
    }
    // Validate every target is a real user in the caller's org. We don't want
    // a malformed payload silently creating a DM with a stranger or a deleted
    // account.
    const targets = storage.listUsersByIds(memberIds);
    const okIds = new Set(targets.filter(t => t.orgId === u.orgId).map(t => t.id));
    const cleaned = memberIds.filter(id => okIds.has(id));
    if (cleaned.length === 0) {
      return res.status(400).json({ message: "No valid recipients in your organization" });
    }

    // Pick the home project: prefer the caller's first project (usually VFD
    // in single-org installs). We never expose project membership in the DM
    // UI, so the row just needs a valid project_id.
    const homeProjects = storage.listProjectsForUserInOrg(u.id, u.orgId);
    const homeProject = homeProjects[0];
    if (!homeProject) return res.status(400).json({ message: "No home project — contact an admin" });

    const fullSet = [u.id, ...cleaned];
    const existing = storage.findDmChannelByMemberSet(fullSet);
    if (existing) {
      return res.json({
        ...existing,
        memberIds: storage.listChannelMemberIds(existing.id),
        created: false,
      });
    }
    const ch = storage.createDmChannel({
      projectId: homeProject.id,
      memberIds: cleaned,
      createdByUserId: u.id,
    });
    res.json({
      ...ch,
      memberIds: storage.listChannelMemberIds(ch.id),
      created: true,
    });
  });

  // Delete a DM thread for everyone. Any member of the DM can do this
  // — there's no "thread owner" in a DM, every participant has equal
  // standing. This is a HARD delete: channel row, messages, reactions,
  // mentions, attachments, member grants all go. Irreversible.
  app.delete("/api/dms/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Invalid id" });
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "Not found" });
    if (channel.scope !== "dm") {
      return res.status(400).json({ message: "Not a DM channel — use DELETE /api/channels/:id instead" });
    }
    // Only members can wipe a DM (admins go through the same check; we don't
    // want an admin tripping over a DM they're not in).
    if (!storage.isChannelMember(channelId, u.id)) {
      return res.status(403).json({ message: "Not a member of this DM" });
    }
    const memberIds = storage.listChannelMemberIds(channelId);
    try {
      storage.deleteChannelCascade(channelId);
      // Tell every former member's open client to drop this DM. We reuse
      // the channel-delete event — it carries channelId, which is enough
      // for the client to evict from its caches.
      emitChannelDelete(u.orgId, { channelId, deletedByUserId: u.id, formerMemberIds: memberIds });
      res.json({ ok: true, deleted: { type: "dm", id: channelId } });
    } catch (err) {
      console.error("[delete-dm]", err);
      res.status(500).json({ message: "Failed to delete DM" });
    }
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
      meta: parseMessageMeta((m as any).meta),
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

    // Parse + persist mentions. DMs use channel_members for the audience
    // (members of THIS DM thread), regular channels use the project's
    // member roster.
    const projectId = access.project!.id;
    const isDm = access.channel!.scope === "dm";
    const audience: Array<{ id: number; name: string; lastSeenAt?: Date | string | null }> = isDm
      ? (() => {
          const ids = storage.listChannelMemberIds(access.channel!.id);
          const users = storage.listUsersByIds(ids);
          return users.map(usr => ({ id: usr.id, name: usr.name, lastSeenAt: usr.lastSeenAt }));
        })()
      : storage.listProjectMembers(projectId).map(m => ({ id: m.id, name: m.name, lastSeenAt: m.lastSeenAt }));
    const mentions = parseMentions(parsed.data.content, audience.map(m => ({ id: m.id, name: m.name })));
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
    for (const m of audience) {
      if (m.id === u.id) continue;
      if (isDm) {
        // DMs push every member every time — the whole point of a DM is
        // that the recipient gets pinged. DND (presence=busy) gating is
        // applied inside sendNotificationToUsers, so a busy user still
        // doesn't get woken up.
        recipientIds.add(m.id);
        continue;
      }
      if (userMentions.has(m.id)) { recipientIds.add(m.id); continue; }
      if (hasEveryone) { recipientIds.add(m.id); continue; }
      const lastSeen = m.lastSeenAt ? new Date(m.lastSeenAt).getTime() : 0;
      const isOnline = (now - lastSeen) < 60_000;
      if (hasHere && isOnline) { recipientIds.add(m.id); continue; }
      // Default: only push if not active
      if (!hasHere && !hasEveryone && !isOnline) recipientIds.add(m.id);
    }

    if (recipientIds.size > 0) {
      const title = isDm
        ? (audience.length <= 2
            ? `${u.name}` // 1:1 DM: just the sender's name
            : `${u.name} in ${audience.filter(m => m.id !== u.id).map(m => m.name.split(" ")[0]).slice(0, 3).join(", ")}`)
        : `#${access.channel!.name} · ${access.project!.name}`;
      void sendNotificationToUsers(Array.from(recipientIds), {
        title,
        body: isDm ? parsed.data.content.slice(0, 140) : `${u.name}: ${parsed.data.content.slice(0, 140)}`,
        url: isDm ? `/#/dms/${channelId}/m/${msg.id}` : `/#/channels/${channelId}/m/${msg.id}`,
        tag: isDm ? `dm-${channelId}` : `channel-${channelId}`,
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

  // Soft-delete a message. Author or admin only. We tombstone (keep the
  // row, wipe content/attachments/reactions/mentions) so threaded replies
  // pointing at this id stay coherent. SSE emits a message-update so live
  // clients re-render the row as "Message deleted" instead of yanking it.
  app.delete("/api/messages/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const msg = storage.getMessage(id);
    if (!msg) return res.status(404).json({ message: "Not found" });
    if (msg.userId !== u.id && u.role !== "admin") return res.status(403).json({ message: "Not allowed" });
    if (msg.deletedAt) return res.json({ ok: true, alreadyDeleted: true });
    storage.tombstoneMessage(id, u.id);
    // Emit BOTH update (so clients holding the message can re-render as
    // tombstone) and delete (for any client that prefers to drop the row).
    // The wire shape now carries deletedAt so the client renderer just
    // branches on that field.
    const wire = buildWireMessage(id)!;
    emitMessageUpdate(u.orgId, wire);
    emitMessageDelete(u.orgId, { channelId: msg.channelId, messageId: id });
    res.json({ ok: true, message: wire });
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
  // Phase 1.9.2 — invite minting also moved to bulldog-auth. Returns 410
  // with a redirect hint so any stale UI shows a clear path forward.
  // Previously: this minted a project invite link that, when redeemed,
  // created a brand-new local user with the role embedded in the link —
  // bypassing bulldog-auth entirely. Locking down kills that lateral path.
  app.post("/api/projects/:id/invites", requireAuth, requireRole(["admin"]), (_req, res) => {
    return res.status(410).json({
      message: "Project invites are disabled. Add users on auth.bulldogops.com and they'll see this project automatically.",
      redirect: "https://auth.bulldogops.com/",
      code: "project_invites_disabled",
    });
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

  // Phase 1.9.2 — same lockdown as /signup. Invite-based user creation
  // bypasses bulldog-auth and was used to mint admins. Direct people to
  // the central auth app instead. Existing users sign in through SSO and
  // get auto-provisioned via bulldog-sso.ts — no manual create needed.
  app.post("/api/auth/accept-invite", (_req, res) => {
    res.status(410).json({
      message: "Invite-based signup is disabled. Ask your admin to add you on auth.bulldogops.com.",
      redirect: "https://auth.bulldogops.com/",
      code: "invite_signup_disabled",
    });
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

  // ── CHANNEL CALL INVITE ──
  // Invite logged-in users (push notification) and/or external phone numbers
  // (Twilio SIP dial-out via LiveKit) into a channel's voice room.
  app.post("/api/channels/:id/invite", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });

    const rawUserIds: unknown = req.body?.userIds;
    const rawPhones: unknown = req.body?.phoneNumbers;
    const userIds: number[] = Array.isArray(rawUserIds)
      ? Array.from(new Set(rawUserIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0 && n !== u.id)))
      : [];
    const phoneNumbers: string[] = Array.isArray(rawPhones)
      ? Array.from(new Set(rawPhones.map((x) => String(x).trim()).filter((s) => s.length > 0)))
      : [];

    if (userIds.length === 0 && phoneNumbers.length === 0) {
      return res.status(400).json({ message: "userIds[] or phoneNumbers[] required" });
    }

    const roomName = `vector-${u.orgId}-channel-${channelId}`;
    const channelName = access.channel?.name ?? "voice channel";
    const warnings: string[] = [];
    let invited = 0;
    let dialed = 0;

    const onlineThresholdMs = 2 * 60 * 1000;
    const now = Date.now();

    // Logged-in users: push if online, dial phone if offline + has phone
    for (const id of userIds) {
      const target = storage.getUser(id);
      if (!target || target.orgId !== u.orgId) {
        warnings.push(`user ${id} not found or out of org`);
        continue;
      }
      if (target.deactivated) {
        warnings.push(`user ${id} is deactivated`);
        continue;
      }
      const lastSeen = target.lastSeenAt ? new Date(target.lastSeenAt).getTime() : 0;
      const isOnline = target.status === "online" || (now - lastSeen) < onlineThresholdMs;

      if (isOnline) {
        void sendNotificationToUsers([id], {
          title: `\ud83d\udcde ${u.name} is inviting you`,
          body: channelName,
          url: `/?channel=${channelId}`,
          tag: `invite-${channelId}`,
        });
        invited += 1;
      } else if (target.phone && sipConfigured()) {
        try {
          const ident = await dialPhoneIntoRoom({ phone: target.phone, roomName, displayName: target.name, channelLabel: channelName });
          if (ident) {
            dialed += 1;
          } else {
            warnings.push(`dial ${target.name}: SIP trunk unavailable (check server log)`);
          }
        } catch (err: any) {
          warnings.push(`dial ${target.name}: ${err?.message ?? "failed"}`);
        }
      } else if (target.phone && !sipConfigured()) {
        warnings.push(`${target.name} is offline and SIP is not configured`);
      } else {
        warnings.push(`${target.name} is offline and has no phone on file`);
      }
    }

    // Raw phone numbers: dial directly
    if (phoneNumbers.length > 0) {
      if (!sipConfigured()) {
        warnings.push("SIP not configured — phone dial-out skipped");
      } else {
        for (const phone of phoneNumbers) {
          try {
            const ident = await dialPhoneIntoRoom({ phone, roomName, displayName: phone, channelLabel: channelName });
            if (ident) {
              dialed += 1;
            } else {
              warnings.push(`dial ${phone}: SIP trunk unavailable (check server log)`);
            }
          } catch (err: any) {
            warnings.push(`dial ${phone}: ${err?.message ?? "failed"}`);
          }
        }
      }
    }

    res.json({ invited, dialed, warnings });
  });

  // ── DIAL ABSENT (Phase 1.9) ──
  // Fired from the channel call UI ~30s into an active call. Looks at every
  // user with access to this channel, figures out who's NOT in the LiveKit
  // room, and rings the phone of anyone who's marked offline or has been
  // idle. Admin/foreman only — keeps random field users from auto-dialing
  // the whole crew by accident.
  app.post("/api/channels/:id/dial-absent", requireAuth, requireRole(["admin", "foreman"]), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });
    if (!sipConfigured()) {
      return res.status(503).json({ message: "SIP not configured — cannot dial phones" });
    }
    if (!livekitConfigured()) {
      return res.status(503).json({ message: "LiveKit not configured" });
    }

    const roomName = `vector-${u.orgId}-channel-${channelId}`;
    const channelName = access.channel?.name ?? "channel";

    // Who's already in the room? Identities are `u_<id>` for users and
    // `sip_<digits>_<ts>` for phones. We only care about user identities
    // here — a phone we previously dialed shouldn't be re-dialed.
    const present = await listRoomParticipantIdentities(roomName);
    const presentUserIds = new Set<number>();
    for (const ident of present) {
      const m = /^u_(\d+)$/.exec(ident);
      if (m) presentUserIds.add(Number(m[1]));
    }

    // "Channel members" — anyone with access to this channel. For global
    // channels (the common case) that's every active user in the project.
    const projectId = access.project!.id;
    const candidates = storage.listProjectMembers(projectId)
      .filter(target =>
        !target.deactivated &&
        target.id !== u.id &&
        !presentUserIds.has(target.id) &&
        !!target.phone &&
        storage.userCanSeeChannel(access.channel!, target));

    // Of those, who's actually "absent" — i.e. their phone is the right way
    // to reach them? Treat presence=offline OR a stale lastSeen as absent.
    // Don't bug users in Busy (DND) by default.
    const STALE_MS = 2 * 60 * 1000;
    const now = Date.now();
    const dialed: Array<{ userId: number; name: string; phone: string }> = [];
    const skipped: Array<{ userId: number; name: string; reason: string }> = [];
    const warnings: string[] = [];

    for (const t of candidates) {
      const presence = (t as { presence?: "online" | "away" | "busy" | "offline" }).presence ?? "online";
      if (presence === "busy") { skipped.push({ userId: t.id, name: t.name, reason: "busy/DND" }); continue; }
      const lastSeen = t.lastSeenAt ? new Date(t.lastSeenAt).getTime() : 0;
      const stale = !lastSeen || (now - lastSeen) > STALE_MS;
      const absent = presence === "offline" || stale;
      if (!absent) { skipped.push({ userId: t.id, name: t.name, reason: "appears online" }); continue; }
      try {
        const ident = await dialPhoneIntoRoom({
          phone: t.phone!, roomName, displayName: t.name, channelLabel: channelName,
        });
        if (ident) {
          dialed.push({ userId: t.id, name: t.name, phone: t.phone! });
        } else {
          warnings.push(`dial ${t.name}: SIP trunk unavailable`);
        }
      } catch (err) {
        const msg = (err as { message?: string })?.message ?? "failed";
        warnings.push(`dial ${t.name}: ${msg}`);
      }
    }

    res.json({ dialed, skipped, warnings, presentUserCount: presentUserIds.size });
  });

  // ── DIAL ARBITRARY NUMBER (Phase 1.9) ──
  // "Dial in" input on the call dialog. Accepts a single E.164 number and
  // bridges it into the channel's LiveKit room. Admin/foreman only.
  app.post("/api/channels/:id/dial-number", requireAuth, requireRole(["admin", "foreman"]), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Not found" });
    if (!sipConfigured()) {
      return res.status(503).json({ message: "SIP not configured — cannot dial phones" });
    }
    const raw = String(req.body?.phone ?? "").trim();
    // Loose E.164 check — "+" then 8-15 digits. We don't strictly enforce
    // country because Twilio will reject anything truly bogus anyway, but
    // we do want to reject obvious garbage early.
    if (!/^\+\d{8,15}$/.test(raw)) {
      return res.status(400).json({ message: "phone must be E.164 (e.g. +12065551234)" });
    }
    const roomName = `vector-${u.orgId}-channel-${channelId}`;
    const channelName = access.channel?.name ?? "channel";
    try {
      const ident = await dialPhoneIntoRoom({
        phone: raw, roomName, displayName: raw, channelLabel: channelName,
      });
      if (!ident) {
        return res.status(502).json({ message: "SIP trunk unavailable" });
      }
      res.json({ ok: true, phone: raw, identity: ident });
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? "failed";
      res.status(500).json({ message: `dial failed: ${msg}` });
    }
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

  // ── GROUP CALLS FROM A TEXT CHANNEL ──
  // The user is in a text channel and wants to start a voice/video call that
  // pulls in some/all channel members. We piggyback on the 1:1 calling
  // infrastructure: one direct_call row PER invitee, all pointing at the
  // SAME LiveKit room. Each invitee sees the standard incoming-call modal
  // and accepts — their accept-flow already publishes them into the room.
  // The caller is returned a token for the shared room immediately.
  app.post("/api/channels/:id/group-call/start", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const kind = (req.body?.kind === "video" ? "video" : "voice") as "voice" | "video";
    const rawInvitees: unknown = req.body?.inviteeIds;
    const rawPhones: unknown = req.body?.phoneNumbers;
    // phoneInviteeIds: chat user IDs the caller wants to reach via the
    // user's saved cell number instead of an in-app push. We look up the
    // phone server-side so the client never has to read or transmit it.
    const rawPhoneInvitees: unknown = req.body?.phoneInviteeIds;
    // smsInviteeIds: chat users who receive a join-link SMS (NOT a SIP dial).
    // Recipient taps link, SSO logs in, joins LiveKit room as themselves.
    const rawSmsInvitees: unknown = req.body?.smsInviteeIds;
    // smsPhoneNumbers: external raw phone numbers that receive join-link SMS.
    const rawSmsPhones: unknown = req.body?.smsPhoneNumbers;
    const inviteeIds: number[] = Array.isArray(rawInvitees)
      ? Array.from(
          new Set(
            (rawInvitees as unknown[])
              .map((x) => Number(x))
              .filter((n) => Number.isFinite(n) && n > 0 && n !== u.id),
          ),
        )
      : [];
    const phoneInviteeIds: number[] = Array.isArray(rawPhoneInvitees)
      ? Array.from(
          new Set(
            (rawPhoneInvitees as unknown[])
              .map((x) => Number(x))
              .filter((n) => Number.isFinite(n) && n > 0 && n !== u.id),
          ),
        )
      : [];
    const smsInviteeIds: number[] = Array.isArray(rawSmsInvitees)
      ? Array.from(
          new Set(
            (rawSmsInvitees as unknown[])
              .map((x) => Number(x))
              .filter((n) => Number.isFinite(n) && n > 0 && n !== u.id),
          ),
        )
      : [];
    const smsPhoneNumbers: string[] = Array.isArray(rawSmsPhones)
      ? Array.from(
          new Set(
            (rawSmsPhones as unknown[])
              .map((x) => String(x).trim())
              .filter((s) => s.length > 0)
              .map((raw) =>
                raw.startsWith("+")
                  ? "+" + raw.slice(1).replace(/\D/g, "")
                  : "+1" + raw.replace(/\D/g, ""),
              )
              .filter((p) => /^\+\d{8,15}$/.test(p)),
          ),
        )
      : [];
    // Normalize raw phone numbers to E.164. Default to US (+1) when no
    // leading +. Drop anything shorter than 8 digits as obvious garbage.
    const phoneNumbers: string[] = Array.isArray(rawPhones)
      ? Array.from(
          new Set(
            (rawPhones as unknown[])
              .map((x) => String(x).trim())
              .filter((s) => s.length > 0)
              .map((raw) =>
                raw.startsWith("+")
                  ? "+" + raw.slice(1).replace(/\D/g, "")
                  : "+1" + raw.replace(/\D/g, ""),
              )
              .filter((p) => /^\+\d{8,15}$/.test(p)),
          ),
        )
      : [];
    if (
      inviteeIds.length === 0 &&
      phoneNumbers.length === 0 &&
      phoneInviteeIds.length === 0 &&
      smsInviteeIds.length === 0 &&
      smsPhoneNumbers.length === 0
    ) {
      return res.status(400).json({ message: "inviteeIds[], phoneInviteeIds[], smsInviteeIds[], phoneNumbers[], or smsPhoneNumbers[] required" });
    }

    const access = userCanAccessChannel(u.id, u.orgId, channelId);
    if (!access) return res.status(404).json({ message: "Channel not found" });

    if (!livekitConfigured()) {
      return res.status(503).json({ message: "Calling unavailable: LiveKit not configured" });
    }

    // One shared LiveKit room for the whole group call. We tie it to the
    // channel id + epoch so back-to-back group calls don't collide.
    const groupRoomName = `group-channel-${channelId}-${Date.now()}`;

    // Validate invitees and filter to same-org, non-deactivated users.
    // It's OK if this list is empty as long as phoneNumbers is non-empty
    // (call still goes out via Twilio SIP).
    const validInvitees = inviteeIds
      .map((id) => ({ id, user: storage.getUser(id) }))
      .filter((x) => x.user && x.user.orgId === u.orgId && !x.user.deactivated)
      .map((x) => x.id);
    // Resolve phoneInviteeIds -> {userId, name, phone} for the SIP bridge.
    // Same org-scope filter as app invitees. Drops users with no phone on
    // file and surfaces that as a warning so the caller knows it didn't
    // ring instead of silently dropping.
    const phoneInviteeRecords = phoneInviteeIds
      .map((id) => ({ id, user: storage.getUser(id) }))
      .filter((x) => x.user && x.user.orgId === u.orgId && !x.user.deactivated)
      .map((x) => ({ id: x.id, name: x.user!.name, phone: (x.user as { phone?: string | null }).phone ?? null }));

    if (validInvitees.length === 0 && phoneNumbers.length === 0 && phoneInviteeRecords.filter((r) => r.phone).length === 0) {
      return res.status(400).json({ message: "No reachable invitees" });
    }

    // Create one direct_call row per invitee, all sharing the same room.
    for (const calleeId of validInvitees) {
      const row = storage.createDirectCall({
        orgId: u.orgId, callerId: u.id, calleeId, roomName: groupRoomName, kind,
      });
      storage.updateDirectCallStatus(row.id, "ringing");
      // Patch room_name in case createDirectCall ignored it (defensive —
      // mirrors what /api/calls/start does for the 1:1 path).
      try {
        (await import("./db")).rawDb
          .prepare(`UPDATE direct_calls SET room_name = ? WHERE id = ?`)
          .run(groupRoomName, row.id);
      } catch {
        /* best-effort */
      }

      const payload: CallEventPayload = {
        callId: row.id,
        callerId: u.id,
        calleeId,
        callerName: u.name,
        callerHue: u.hue,
        kind,
        roomName: groupRoomName,
      };
      emitCallIncoming(payload);

      // Auto-miss after 60s if no answer. Group calls get a slightly longer
      // window than 1:1 since people may be ringing in a noisy environment.
      setTimeout(() => {
        const current = storage.getDirectCall(row.id);
        if (current && current.status === "ringing") {
          storage.updateDirectCallStatus(row.id, "missed", { endedAt: new Date() });
          emitCallEnded({ ...payload, reason: "missed" });
        }
      }, 60_000);
    }

    // Fire a single batched push to all invitees with the group-call label.
    if (validInvitees.length > 0) {
      void sendNotificationToUsers(validInvitees, {
        title: `\ud83d\udcde ${u.name} is calling`,
        body:
          kind === "video"
            ? `Group video call — ${access.channel?.name ? "#" + access.channel.name : "channel"}`
            : `Group voice call — ${access.channel?.name ? "#" + access.channel.name : "channel"}`,
        url: `/#/call/group/${encodeURIComponent(groupRoomName)}`,
        tag: `group-call-${groupRoomName}`,
      });
    }

    // Phone-bridge any raw numbers the caller typed in, AND any chat users
    // the caller chose to reach 'via Phone'. dialPhoneIntoRoom brands the
    // SIP From as "Bulldog · #channel" so the recipient knows it's the app
    // calling, not an unknown number.
    const dialedPhones: string[] = [];
    const dialedUserIds: number[] = [];
    const dialWarnings: string[] = [];
    const channelLabel = access.channel?.name ? `#${access.channel.name}` : "call";

    // Resolve chat-user -> saved phone first so we can fail fast if SIP
    // isn't configured but the caller picked 'via Phone' for someone.
    if (phoneInviteeRecords.length > 0) {
      if (!sipConfigured()) {
        dialWarnings.push("SIP not configured — chat users picked 'via Phone' were not dialed");
      } else {
        for (const rec of phoneInviteeRecords) {
          if (!rec.phone) {
            dialWarnings.push(`${rec.name}: no phone on file`);
            continue;
          }
          try {
            const ident = await dialPhoneIntoRoom({
              phone: rec.phone,
              roomName: groupRoomName,
              displayName: rec.name,
              channelLabel,
            });
            if (ident) {
              dialedUserIds.push(rec.id);
              dialedPhones.push(rec.phone);
            } else {
              dialWarnings.push(`dial ${rec.name}: SIP trunk unavailable`);
            }
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? "failed";
            dialWarnings.push(`dial ${rec.name}: ${msg}`);
          }
        }
      }
    }

    if (phoneNumbers.length > 0) {
      if (!sipConfigured()) {
        dialWarnings.push("SIP not configured — phone numbers were not dialed");
      } else {
        for (const phone of phoneNumbers) {
          try {
            const ident = await dialPhoneIntoRoom({
              phone, roomName: groupRoomName, displayName: phone, channelLabel,
            });
            if (ident) {
              dialedPhones.push(phone);
            } else {
              dialWarnings.push(`dial ${phone}: SIP trunk unavailable`);
            }
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? "failed";
            dialWarnings.push(`dial ${phone}: ${msg}`);
          }
        }
      }
    }

    // ─── SMS-link invites (hybrid: ring cell + send video join URL) ───────
    // For each smsInviteeId, look up phone, mint a join token, send SMS.
    // For each smsPhoneNumber, mint a guest token under the organizer's
    // namespace (no chat user known yet — they'll resolve via SSO login).
    const smsResults: Array<{ userId?: number; phone: string; ok: boolean; error?: string }> = [];
    if (smsAvailable() && (smsInviteeIds.length > 0 || smsPhoneNumbers.length > 0)) {
      const channelLabelForSms = access.channel?.name ? `#${access.channel.name}` : "call";
      // Resolve smsInviteeIds -> {userId, name, phone}
      const smsInviteeRecords = smsInviteeIds
        .map((id) => ({ id, user: storage.getUser(id) }))
        .filter((x) => x.user && x.user.orgId === u.orgId && !x.user.deactivated)
        .map((x) => ({
          id: x.id,
          name: x.user!.name,
          phone: (x.user as { phone?: string | null }).phone ?? null,
        }));
      for (const rec of smsInviteeRecords) {
        if (!rec.phone) {
          smsResults.push({ userId: rec.id, phone: "", ok: false, error: "no phone on file" });
          continue;
        }
        // Normalize phone to E.164
        const e164 = rec.phone.startsWith("+")
          ? "+" + rec.phone.slice(1).replace(/\D/g, "")
          : "+1" + rec.phone.replace(/\D/g, "");
        if (!/^\+\d{8,15}$/.test(e164)) {
          smsResults.push({ userId: rec.id, phone: rec.phone, ok: false, error: "invalid phone" });
          continue;
        }
        const joinToken = signCallJoinToken({
          userId: rec.id,
          roomName: groupRoomName,
          callerName: u.name,
          kind,
        });
        const baseUrl = process.env.CHAT_BASE_URL || "https://chat.bulldogops.com";
        const joinUrl = `${baseUrl}/call-join?t=${encodeURIComponent(joinToken)}`;
        const body = buildCallInviteSmsBody({
          callerName: u.name,
          channelLabel: channelLabelForSms,
          joinUrl,
          kind,
        });
        try {
          const r = await sendSms({ to: e164, body });
          smsResults.push({ userId: rec.id, phone: e164, ok: r.ok, error: r.ok ? undefined : r.error });
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "send failed";
          smsResults.push({ userId: rec.id, phone: e164, ok: false, error: msg });
        }
      }
      // External phone numbers — no userId; bound to organizer for guest-ish access.
      for (const phone of smsPhoneNumbers) {
        const joinToken = signCallJoinToken({
          userId: u.id,
          roomName: groupRoomName,
          callerName: u.name,
          kind,
        });
        const baseUrl = process.env.CHAT_BASE_URL || "https://chat.bulldogops.com";
        const joinUrl = `${baseUrl}/call-join?t=${encodeURIComponent(joinToken)}`;
        const body = buildCallInviteSmsBody({
          callerName: u.name,
          channelLabel: channelLabelForSms,
          joinUrl,
          kind,
        });
        try {
          const r = await sendSms({ to: phone, body });
          smsResults.push({ phone, ok: r.ok, error: r.ok ? undefined : r.error });
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "send failed";
          smsResults.push({ phone, ok: false, error: msg });
        }
      }
    } else if (smsInviteeIds.length > 0 || smsPhoneNumbers.length > 0) {
      dialWarnings.push("SMS not configured — join-link invites were not sent");
    }

    // Mint the caller's token for the shared room and return.
    const token = await generateLivekitToken({
      userId: u.id, userName: u.name, roomName: groupRoomName, canPublish: true,
    });
    res.json({
      roomName: groupRoomName,
      token,
      ws_url: process.env.LIVEKIT_WS_URL,
      invitedUserIds: validInvitees,
      dialedUserIds,
      dialedPhones,
      dialWarnings,
      smsResults,
      kind,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Invite more people into an ALREADY-RUNNING call. Mirrors
  // group-call/start but joins the existing room (1:1 "direct-<callId>"
  // OR a previously-started "group-channel-<id>-<ts>") instead of
  // creating a new one. Used by the "Add" button on the active-call
  // overlay to pull additional members or phone numbers into the live
  // LiveKit room without forcing everyone to drop and re-join.
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/api/calls/active/invite", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const roomName = String(req.body?.roomName ?? "").trim();
    const kind = (req.body?.kind === "video" ? "video" : "voice") as "voice" | "video";
    if (!roomName) return res.status(400).json({ message: "roomName required" });
    // Sanity-check the room name shape. We only allow rooms minted by
    // this server (direct-<n>, group-channel-<n>-<ts>, vector-<n>-channel-<n>)
    // so a malicious client can't poke users into arbitrary rooms.
    if (!/^(direct-\d+|group-channel-\d+-\d+|vector-\d+-channel-\d+)$/.test(roomName)) {
      return res.status(400).json({ message: "invalid roomName" });
    }

    const rawInvitees: unknown = req.body?.inviteeIds;
    const rawPhoneInvitees: unknown = req.body?.phoneInviteeIds;
    const rawPhones: unknown = req.body?.phoneNumbers;
    const inviteeIds: number[] = Array.isArray(rawInvitees)
      ? Array.from(
          new Set(
            (rawInvitees as unknown[])
              .map((x) => Number(x))
              .filter((n) => Number.isFinite(n) && n > 0 && n !== u.id),
          ),
        )
      : [];
    const phoneInviteeIds: number[] = Array.isArray(rawPhoneInvitees)
      ? Array.from(
          new Set(
            (rawPhoneInvitees as unknown[])
              .map((x) => Number(x))
              .filter((n) => Number.isFinite(n) && n > 0 && n !== u.id),
          ),
        )
      : [];
    const phoneNumbers: string[] = Array.isArray(rawPhones)
      ? Array.from(
          new Set(
            (rawPhones as unknown[])
              .map((x) => String(x).trim())
              .filter((s) => s.length > 0)
              .map((raw) =>
                raw.startsWith("+")
                  ? "+" + raw.slice(1).replace(/\D/g, "")
                  : "+1" + raw.replace(/\D/g, ""),
              )
              .filter((p) => /^\+\d{8,15}$/.test(p)),
          ),
        )
      : [];
    if (inviteeIds.length === 0 && phoneNumbers.length === 0 && phoneInviteeIds.length === 0) {
      return res.status(400).json({ message: "inviteeIds[], phoneInviteeIds[], or phoneNumbers[] required" });
    }

    if (!livekitConfigured()) {
      return res.status(503).json({ message: "Calling unavailable: LiveKit not configured" });
    }

    // Org-scope filter for app invitees.
    const validInvitees = inviteeIds
      .map((id) => ({ id, user: storage.getUser(id) }))
      .filter((x) => x.user && x.user.orgId === u.orgId && !x.user.deactivated)
      .map((x) => x.id);
    const phoneInviteeRecords = phoneInviteeIds
      .map((id) => ({ id, user: storage.getUser(id) }))
      .filter((x) => x.user && x.user.orgId === u.orgId && !x.user.deactivated)
      .map((x) => ({ id: x.id, name: x.user!.name, phone: (x.user as { phone?: string | null }).phone ?? null }));

    if (validInvitees.length === 0 && phoneNumbers.length === 0 && phoneInviteeRecords.filter((r) => r.phone).length === 0) {
      return res.status(400).json({ message: "No reachable invitees" });
    }

    // Best-effort label for SIP From-display. Use the channel name when
    // the room is a channel-bound group room; otherwise fall back to the
    // caller's name (so the recipient sees "Bulldog · Josh Bieler").
    let channelLabel = `${u.name}`;
    const chanMatch = roomName.match(/(?:group-channel-|vector-\d+-channel-)(\d+)/);
    if (chanMatch) {
      const chId = Number(chanMatch[1]);
      const ch = storage.getChannel(chId);
      if (ch) channelLabel = `#${ch.name}`;
    }

    // Create per-invitee ringing rows (so the standard incoming-call UI
    // fires on each invitee's device). All rows share the existing room.
    for (const calleeId of validInvitees) {
      const row = storage.createDirectCall({
        orgId: u.orgId, callerId: u.id, calleeId, roomName, kind,
      });
      storage.updateDirectCallStatus(row.id, "ringing");
      try {
        (await import("./db")).rawDb
          .prepare(`UPDATE direct_calls SET room_name = ? WHERE id = ?`)
          .run(roomName, row.id);
      } catch {
        /* best-effort */
      }
      const payload: CallEventPayload = {
        callId: row.id, callerId: u.id, calleeId,
        callerName: u.name, callerHue: u.hue,
        kind, roomName,
      };
      emitCallIncoming(payload);
      setTimeout(() => {
        const current = storage.getDirectCall(row.id);
        if (current && current.status === "ringing") {
          storage.updateDirectCallStatus(row.id, "missed", { endedAt: new Date() });
          emitCallEnded({ ...payload, reason: "missed" });
        }
      }, 60_000);
    }

    if (validInvitees.length > 0) {
      void sendNotificationToUsers(validInvitees, {
        title: `\ud83d\udcde ${u.name} is calling`,
        body: kind === "video" ? `Adding you to a video call — ${channelLabel}` : `Adding you to a voice call — ${channelLabel}`,
        url: `/#/call/group/${encodeURIComponent(roomName)}`,
        tag: `call-add-${roomName}`,
      });
    }

    // Phone-bridge.
    const dialedPhones: string[] = [];
    const dialedUserIds: number[] = [];
    const dialWarnings: string[] = [];
    if (phoneInviteeRecords.length > 0) {
      if (!sipConfigured()) {
        dialWarnings.push("SIP not configured — chat users picked 'via Phone' were not dialed");
      } else {
        for (const rec of phoneInviteeRecords) {
          if (!rec.phone) {
            dialWarnings.push(`${rec.name}: no phone on file`);
            continue;
          }
          try {
            const ident = await dialPhoneIntoRoom({
              phone: rec.phone, roomName, displayName: rec.name, channelLabel,
            });
            if (ident) {
              dialedUserIds.push(rec.id);
              dialedPhones.push(rec.phone);
            } else {
              dialWarnings.push(`dial ${rec.name}: SIP trunk unavailable`);
            }
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? "failed";
            dialWarnings.push(`dial ${rec.name}: ${msg}`);
          }
        }
      }
    }
    if (phoneNumbers.length > 0) {
      if (!sipConfigured()) {
        dialWarnings.push("SIP not configured — phone numbers were not dialed");
      } else {
        for (const phone of phoneNumbers) {
          try {
            const ident = await dialPhoneIntoRoom({
              phone, roomName, displayName: phone, channelLabel,
            });
            if (ident) dialedPhones.push(phone);
            else dialWarnings.push(`dial ${phone}: SIP trunk unavailable`);
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? "failed";
            dialWarnings.push(`dial ${phone}: ${msg}`);
          }
        }
      }
    }

    res.json({ roomName, invitedUserIds: validInvitees, dialedUserIds, dialedPhones, dialWarnings, kind });
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
