import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { nanoid } from "nanoid";
import { storage, sanitize } from "./storage";
import {
  signupSchema, loginSchema, acceptInviteSchema, sendMessageSchema, reactionSchema,
  insertProjectSchema, insertChannelSchema, insertInviteSchema, channelCreateSchema, linkedContractAttachSchema,
} from "@shared/schema";
import { hashPassword, verifyPassword, signJwt, requireAuth, requireRole, requireCap, setAuthCookie, clearAuthCookie, AuthedRequest, AUTH_COOKIE } from "./auth";
import { can } from "@shared/permissions";
import { addSubscriber, removeSubscriber, emitMessageNew, emitMessageDelete, emitMessageUpdate, emitReactionChange, emitChannelDelete, emitDmUpdated, emitDmCreated, emitCallIncoming, emitCallAccepted, emitCallEnded, emitPresenceChange, type CallEventPayload, WireMessage } from "./events";
import { generateLivekitToken, livekitConfigured, listRoomParticipantIdentities } from "./livekit";
import { setupWebPush, pushConfigured, getPublicVapidKey, sendNotificationToUsers } from "./push";
import { runMigrations } from "./migrate";
import { runSeed } from "./seed";
import { runMultiTenantSeed } from "./seed-multitenant";
import { canSeeChannel as mtCanSeeChannel, type AccessSnapshot } from "./multitenant-access";
import { rawDb } from "./db";
import { registerV2Routes, parseMentions } from "./routes-v2";
import { registerWorkObjectRoutes } from "./routes-work-objects";
import { registerIntegrationRoutes } from "./routes-integrations";
import { bulldogSsoBridge } from "./bulldog-sso";
import { dialPhoneIntoRoom, sipConfigured } from "./sip";
import { signCallJoinToken, verifyCallJoinToken, sendSms, smsAvailable, buildCallInviteSmsBody } from "./sms";
import { checkSmsConsent } from "./auth-consent";
import { mintShortLink, resolveShortLink, bumpShortLinkUses } from "./short-links";
import { sendEmail, isEmailConfigured } from "./email";
import { emitOpsNotifications } from "./notify-ops";
import { firePhotoBridgeToOps } from "./suite-photo-bridge";
import {
  promoteMessageToChangeOrder,
  buildChangeOrderPromotedSystemMessage,
  resolveContractForChannel,
  resolveJobIdForChannel,
} from "./suite-change-orders-outbound";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
import { registerScheduledCallRoutes, startReminderLoop } from "./scheduled-calls";
import { registerMeetingRoutes } from "./routes-meetings";
import { registerTeamsLobbyRoutes } from "./routes-teams-lobby";
import { registerBogeyChatRoutes } from "./bogey-chat-routes";
import { createMeeting as createMeetingRow, linkExistingCallToMeeting, getMeetingById, getActiveHuddleForChannel, type CreateMeetingInput } from "./storage/meetings";
import { syncDeactivatedFromAuth } from "./users-sync";
import {
  startClerk,
  stopClerk,
  ingestAudioChunk,
  listNotesForChannel,
  deleteNote,
  getNote,
  publicNoteShape,
  getClerkConfigSummary,
  getSummaryRecipientCandidates,
  sendSummaryEmails,
  skipSummaryEmails,
} from "./meeting-clerk";
import express from "express";

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

// Unified meetings model — create a meeting row for an already-allocated legacy
// call/room and link the legacy row to it. Best-effort and synchronous-safe:
// any failure is logged and swallowed so the underlying call path is unaffected.
// Returns the new meeting id (or null on failure) for callers that want to
// surface the join code.
type LinkableCallTable = "direct_calls" | "scheduled_calls" | "livekit_rooms";
function linkCallToMeeting(
  table: LinkableCallTable,
  rowId: number,
  input: CreateMeetingInput,
): string | null {
  try {
    const meeting = createMeetingRow(input);
    // rowId < 0 means there is no legacy row to back-link (e.g. group calls
    // don't pre-create a livekit_rooms row); just mint the meeting.
    if (rowId >= 0) linkExistingCallToMeeting(table, rowId, meeting.id);
    return meeting.id;
  } catch (e) {
    console.warn(`[meetings] linkCallToMeeting(${table}#${rowId}) failed:`, (e as { message?: string })?.message ?? e);
    return null;
  }
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
function userCanAccessProject(userId: number, orgId: number, projectId: number, access?: AccessSnapshot): boolean {
  const project = storage.getProject(projectId);
  if (!project || project.orgId !== orgId) return false;
  if (!storage.isProjectMember(projectId, userId)) return false;
  // Multi-tenant Option A: in addition to the project_members check, the
  // caller must hold a live grant on this project. project_members rows
  // are populated by mirrorUserGrants, so this is usually a no-op, but it
  // catches stale memberships and the legacy demo data path.
  if (access && !access.isSuperAdmin && !access.projectIds.has(projectId)) return false;
  return true;
}
function userCanAccessChannel(userId: number, orgId: number, channelId: number, access?: AccessSnapshot): { channel: ReturnType<typeof storage.getChannel>; project: ReturnType<typeof storage.getProject> } | null {
  const channel = storage.getChannel(channelId);
  if (!channel) return null;
  const project = storage.getProject(channel.projectId);
  if (!project || project.orgId !== orgId) return null;
  if (!storage.isProjectMember(project.id, userId)) return null;
  const user = storage.getUser(userId);
  if (!user) return null;
  if (!storage.userCanSeeChannel(channel, user)) return null;
  // Multi-tenant Option A: enforce region-scoped visibility. mtCanSeeChannel
  // also short-circuits to true for super_admin and for company-wide
  // channels (regionId=NULL).
  if (access && !mtCanSeeChannel(access, channel.projectId, channel.regionId ?? null)) return null;
  return { channel, project };
}

// ─────────────────────────────────────────────────────────────────────────
// POST /api/channels/:id/group-call/join
//
// Extracted to a stand-alone registrar so unit tests can mount JUST this
// endpoint against a bare Express app, without booting the full route tree
// (which runs migrations + seeds and hangs a Node test worker).
//
// See the comment above the `registerGroupCallJoinRoute(app)` call inside
// `registerRoutes` for the semantic contract. Behaviour is intentionally
// paranoid: reject unknown room shapes, mismatched channelIds embedded in
// the room name, and any channel the caller can't see. When LiveKit isn't
// configured we return 503 rather than a fake token, mirroring the other
// call endpoints.
// ─────────────────────────────────────────────────────────────────────────
export function registerGroupCallJoinRoute(app: Express) {
  app.post("/api/channels/:id/group-call/join", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return res.status(400).json({ message: "invalid channelId" });
    }
    const roomName = typeof req.body?.roomName === "string" ? req.body.roomName : "";
    // Whitelist the room-name shapes we mint elsewhere. Anything else is
    // either a client bug or an attempt to grab a token for an unrelated
    // room, so 400 rather than trying to "be helpful."
    const ROOM_RE = /^(direct-\d+|group-channel-\d+-\d+|vector-\d+-channel-\d+|bdc-[a-hj-km-np-z2-9]{3}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{3}|sched-\d+-\d+)$/;
    if (!ROOM_RE.test(roomName)) {
      return res.status(400).json({ message: "invalid roomName" });
    }
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(403).json({ message: "forbidden" });
    if (!livekitConfigured()) {
      return res.status(503).json({
        message: "LiveKit not configured — preview mode only. Add LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_WS_URL to environment.",
      });
    }
    // If the room name embeds a channelId (`group-channel-<id>-<ts>`), it
    // MUST match the URL param. Prevents a caller with access to channel A
    // from being handed a token to channel B's live room by manipulating
    // the body.
    const groupChannelMatch = roomName.match(/^group-channel-(\d+)-\d+$/);
    if (groupChannelMatch && Number(groupChannelMatch[1]) !== channelId) {
      return res.status(403).json({ message: "room does not belong to this channel" });
    }
    const token = await generateLivekitToken({
      userId: u.id, userName: u.name, roomName, canPublish: true,
    });
    const kind: "video" | "audio" = "video";
    res.json({
      roomName,
      token,
      ws_url: process.env.LIVEKIT_WS_URL,
      kind,
      channelId,
      channelName: access.channel!.name,
    });
  });
}

// ─────────────────── ROUTES ───────────────────
export async function registerRoutes(_httpServer: Server, app: Express) {
  runMigrations();
  // Multi-tenant Option A mode — gated by MULTITENANT_MODE=1. When set, we
  // run the Bulldog Suite seed (4 companies × 6 regions) instead of the
  // legacy single-tenant Vector Services demo. The legacy seed is bypassed
  // entirely so it can't race against the multi-tenant tree.
  if (process.env.MULTITENANT_MODE === "1") {
    try {
      await runMultiTenantSeed();
    } catch (e: any) {
      console.error("[boot] multi-tenant seed failed:", e?.message ?? e);
      throw e;
    }
  } else {
    await runSeed();
  }
  setupWebPush();

  // Bulldog SSO bridge — if request has bulldog_access JWT cookie but no
  // vc_token, mint a vc_token for the matching local user.
  app.use(bulldogSsoBridge());

  registerV2Routes(app);
  registerWorkObjectRoutes(app);
  registerIntegrationRoutes(app);
  registerTeamsLobbyRoutes(app);
  registerScheduledCallRoutes(app);
  registerMeetingRoutes(app);
  registerBogeyChatRoutes(app, requireAuth);

  // Clean public meeting URLs → SPA hash routes. The app uses wouter's
  // useHashLocation, so a bare https://chat.bulldogops.com/m/<code> would boot
  // the SPA at an empty hash and miss the route. Rewrite the three public
  // meeting paths to their /#/ equivalents. These are GET navigations only and
  // sit before the SPA catch-all; /api routes are untouched.
  const cleanMeetingUrl = /^\/(m|r|end)\/([^/]+)\/?$/;
  app.get(cleanMeetingUrl, (req, res) => {
    const m = req.path.match(cleanMeetingUrl);
    if (!m) return res.status(404).end();
    const [, seg, code] = m;
    res.redirect(302, `/#/${seg}/${encodeURIComponent(code)}`);
  });

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

  // ── APPLE APP SITE ASSOCIATION (Universal Links) ──
  // Apple's swcd fetcher pulls this from each entitled domain on app install
  // to learn which paths the app claims. It MUST be served as
  // application/json, with NO redirect (302s break it on iOS < 14) and NO
  // auth. The shipping iOS app (Capacitor, bundle com.teamdelta.bulldogops,
  // Team CB3H59S2F9) is already entitled for applinks:chat.bulldogops.com —
  // this route is the missing server half. Registered before the SPA
  // catch-all so it isn't swallowed. Values are stable (not env-dependent).
  app.get("/.well-known/apple-app-site-association", (_req, res) => {
    const aasa = `{
  "applinks": {
    "details": [
      {
        "appIDs": ["CB3H59S2F9.com.teamdelta.bulldogops"],
        "components": [
          { "/": "/j/*", "comment": "Short-link meeting joins open the app" },
          { "/": "/meeting/*", "comment": "Direct meeting room URLs open the app" },
          { "/": "/call/*", "comment": "Direct call URLs open the app" }
        ]
      }
    ]
  }
}`;
    res.status(200).type("application/json").send(aasa);
  });

  // ── SHORT LINK REDIRECT ──
  // SMS bodies carry https://chat.bulldogops.com/j/<token> instead of the full
  // ~280-char signed-JWT join URL, shrinking scheduled invites from ~5 Twilio
  // segments to one. The token 302-redirects to the long join URL, which every
  // client (real Safari, Android, desktop, the native iOS app via the in-app
  // browser banner) already handles. Registered before the SPA catch-all.
  app.get("/j/:token", (req, res) => {
    const token = req.params.token;
    const row = resolveShortLink(token);
    if (!row) {
      return res.status(410).send("This meeting link has expired.");
    }
    bumpShortLinkUses(token);
    res.redirect(302, row.long_url);
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
        channelId: payload.channelId ?? null,
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

    // Opportunistic sync from bulldog-auth: when an admin with a live
    // bulldog_access cookie loads the roster, backfill phones and soft-
    // deactivate ghost users. Forwarding the caller's cookie is the only
    // way to reach auth's admin API (it 403s otherwise). The background
    // job in index.ts cannot do this (no cookie), so this admin-driven
    // path is still the most reliable refresh trigger.
    const me = storage.getUser(u.id);
    if (me?.role === "admin") {
      const cookieHeader = req.headers.cookie || "";
      if (/(?:^|;\s*)bulldog_access=/.test(cookieHeader)) {
        try {
          await syncDeactivatedFromAuth({ cookieHeader, callerUserId: u.id });
        } catch (e) {
          console.warn("[org/members] auth sync failed:", e);
        }
      }
    }

    // Only return active users — deactivated rows (deleted/disabled in auth)
    // must not appear in the sidebar/roster. This is the user-visible fix:
    // previously the full list (including deactivated) was returned.
    const list = storage
      .listUsersByOrg(u.orgId)
      .filter((m) => !m.deactivated)
      .map(sanitize);

    res.json(list);
  });

  // Manually trigger a roster sync from bulldog-auth. Admin-only. Forwards the
  // caller's bulldog_access cookie so we can reach auth's admin API. Returns
  // the {checked, deactivated, reactivated, source} counts.
  app.post("/api/admin/sync-users", requireAuth, requireRole(["admin"]), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const result = await syncDeactivatedFromAuth({
      cookieHeader: req.headers.cookie || "",
      callerUserId: u.id,
      orgId: u.orgId,
    });
    res.json(result);
  });

  // ── PHASE 3 CLEANUP: ADMIN DELETE PROJECTS ──
  // Cascade-delete one or more projects (and ALL of their channels, regions,
  // jobs, messages, members, MT grants, auth-company links). Admin-only and
  // scoped to the caller's org. Body: { projectIds: number[] }.
  // Returns per-project ok/error.
  app.post("/api/admin/delete-projects", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = req.body ?? {};
    const ids: number[] = Array.isArray(body.projectIds)
      ? body.projectIds.map((n: unknown) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    if (ids.length === 0) return res.status(400).json({ message: "projectIds[] required" });
    const results: Array<{ id: number; ok: boolean; error?: string }> = [];
    for (const id of ids) {
      const project = storage.getProject(id);
      if (!project || project.orgId !== u.orgId) {
        results.push({ id, ok: false, error: "not-in-org" });
        continue;
      }
      try {
        storage.deleteProjectCascade(id);
        results.push({ id, ok: true });
      } catch (err: any) {
        console.error("[delete-project]", id, err);
        results.push({ id, ok: false, error: String(err?.message ?? err) });
      }
    }
    res.json({ results });
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
    // Phase 3: attach authCompanyId so the UI / test harness can map
    // chat-project ↔ bulldog-auth company without an extra round-trip.
    const links = rawDb.prepare("SELECT project_id, auth_company_id FROM project_auth_company").all() as { project_id: number; auth_company_id: string }[];
    const linkMap = new Map(links.map(l => [l.project_id, l.auth_company_id]));
    res.json(projects.map(p => ({ ...p, authCompanyId: linkMap.get(p.id) ?? null })));
  });

  app.post("/api/projects", requireAuth, requireCap(can.chat.createProject), (req, res) => {
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
    if (!userCanAccessProject(u.id, u.orgId, id, (req as AuthedRequest).access)) return res.status(404).json({ message: "Not found" });
    res.json(storage.getProject(id));
  });

  app.get("/api/projects/:id/members", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id, (req as AuthedRequest).access)) return res.status(404).json({ message: "Not found" });
    res.json(storage.listProjectMembers(id).map(sanitize));
  });

  app.get("/api/projects/:id/channels", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const access = (req as AuthedRequest).access;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id, access)) return res.status(404).json({ message: "Not found" });
    // Scope-aware list: admins see everything; others only see channels they
    // are permitted by scope (global / matching entity / matching team-role /
    // private membership). Then layer multi-tenant region filtering on top.
    let list = storage.listChannelsForUserInProject(id, u.id);
    if (access) {
      list = list.filter(c => mtCanSeeChannel(access, c.projectId, c.regionId ?? null));
    }
    res.json(list);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/me/unread
  //
  // Per-company unread rollup that powers the star badge on the left
  // sidebar's company rail. Aggregates two signals:
  //
  //   1. Chat: any channel message with id > read_receipts.last_read_message_id
  //      (or ANY message when no receipt row exists yet), filtered to channels
  //      the caller can actually see.
  //   2. Calls: missed direct_calls where I'm the callee, whose room name
  //      embeds a channelId we can map back to a project. 1:1 direct calls
  //      (no channel context) currently aren't attributed to a company — they
  //      surface elsewhere in the UI.
  //
  // Returns byChannelId (raw chat counts) and byProjectId ({chat, calls,
  // hasUnread}). Kept intentionally cheap: two aggregate SQL statements +
  // one channel-list read; runs in a few ms on a hot cache.
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/api/me/unread", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const access = (req as AuthedRequest).access;

    // 1. Enumerate the channels the caller can see across every company they
    //    belong to. We can't just SELECT COUNT() from messages joined on
    //    read_receipts because it'd leak counts from channels the user has
    //    no access to (e.g. private channels they're not a member of).
    //
    //    We ALSO fold in the caller's DM channels (scope='dm'). DMs are
    //    channel rows in the same table, so a message with id >
    //    last_read_message_id is unread the same way. Their `projectId`
    //    slots into the same per-company rollup that powers the sidebar
    //    star, so opening a DM (and marking it read) will clear its parent
    //    company's count just like a regular channel.
    const projects = storage.listProjectsForUserInOrg(u.id, u.orgId);
    const visibleChannels: { id: number; projectId: number }[] = [];
    for (const p of projects) {
      let list = storage.listChannelsForUserInProject(p.id, u.id);
      if (access) {
        list = list.filter(c => mtCanSeeChannel(access, c.projectId, c.regionId ?? null));
      }
      for (const c of list) visibleChannels.push({ id: c.id, projectId: c.projectId });
    }
    const dmChannels = storage.listDmChannelsForUser(u.id);
    const projectIds = new Set(projects.map(p => p.id));
    for (const c of dmChannels) {
      // Only count DMs whose parent project is one the caller belongs to,
      // so the org boundary is preserved.
      if (c.projectId != null && projectIds.has(c.projectId)) {
        visibleChannels.push({ id: c.id, projectId: c.projectId });
      }
    }

    const byChannelId: Record<number, number> = {};
    const byProjectId: Record<number, { chat: number; calls: number; hasUnread: boolean }> = {};
    for (const p of projects) byProjectId[p.id] = { chat: 0, calls: 0, hasUnread: false };

    if (visibleChannels.length > 0) {
      // Batch the count query so we don't fire N statements. We COUNT() per
      // channel where message.id > COALESCE(last_read_message_id, 0), and
      // exclude the caller's own messages (a user's own send should never
      // light up their sidebar).
      const channelIds = visibleChannels.map(c => c.id);
      const placeholders = channelIds.map(() => "?").join(",");
      const rows = rawDb
        .prepare(
          `SELECT m.channel_id AS channelId, COUNT(*) AS n
             FROM messages m
             LEFT JOIN read_receipts r
               ON r.channel_id = m.channel_id AND r.user_id = ?
            WHERE m.channel_id IN (${placeholders})
              AND m.user_id != ?
              AND m.deleted_at IS NULL
              AND m.id > COALESCE(r.last_read_message_id, 0)
            GROUP BY m.channel_id`
        )
        .all(u.id, ...channelIds, u.id) as { channelId: number; n: number }[];
      const chanToProject = new Map(visibleChannels.map(c => [c.id, c.projectId]));
      for (const row of rows) {
        byChannelId[row.channelId] = row.n;
        const pid = chanToProject.get(row.channelId);
        if (pid !== undefined) byProjectId[pid].chat += row.n;
      }
    }

    // 2. Missed direct_calls where I'm the callee. Map the room name back to
    //    a channelId (group-channel-<id>-<ts> or vector-<n>-channel-<id>) and
    //    roll up to that channel's projectId. Rows without a resolvable
    //    channelId are dropped — they'll show elsewhere in the UI.
    //
    //    Window: 24h. Older misses stop cluttering the sidebar and can be
    //    reviewed from the calls history page instead.
    const missedRows = rawDb
      .prepare(
        `SELECT room_name AS roomName
           FROM direct_calls
          WHERE callee_id = ?
            AND status = 'missed'
            AND started_at > (strftime('%s','now') - 24*3600)`
      )
      .all(u.id) as { roomName: string }[];
    const chanToProjectAll = new Map(visibleChannels.map(c => [c.id, c.projectId]));
    for (const row of missedRows) {
      const m = row.roomName?.match(/(?:group-channel-|vector-\d+-channel-)(\d+)/);
      if (!m) continue;
      const cid = Number(m[1]);
      const pid = chanToProjectAll.get(cid);
      if (pid === undefined) continue;
      byProjectId[pid].calls += 1;
    }

    for (const pid of Object.keys(byProjectId)) {
      const b = byProjectId[Number(pid)];
      b.hasUnread = b.chat > 0 || b.calls > 0;
    }

    res.json({ byChannelId, byProjectId, updatedAt: Date.now() });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/channels/:id/read
  //
  // Advance the caller's read receipt to the given message id (or, when
  // omitted, to the latest message in the channel). Clears the star badge
  // for this channel in the caller's sidebar. Best-effort: never rejects a
  // stale message id, since receipts only move forward.
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/api/channels/:id/read", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return res.status(400).json({ message: "invalid channelId" });
    }
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(403).json({ message: "forbidden" });

    // Prefer the body's messageId; otherwise use the current tip of the
    // channel. `MAX(id)` is fine here because messages.id is monotonic and
    // we only ever move receipts forward.
    let messageId = Number(req.body?.messageId);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      const tip = rawDb
        .prepare(`SELECT MAX(id) AS tip FROM messages WHERE channel_id = ?`)
        .get(channelId) as { tip: number | null } | undefined;
      messageId = tip?.tip ?? 0;
    }
    if (messageId > 0) {
      // Existing storage helper does an upsert. Idempotent even if the caller
      // is already ahead of the requested id — the SET moves the timestamp
      // forward but the observable behaviour is unchanged.
      const existing = rawDb
        .prepare(`SELECT last_read_message_id AS m FROM read_receipts WHERE channel_id = ? AND user_id = ?`)
        .get(channelId, u.id) as { m: number | null } | undefined;
      const target = Math.max(messageId, existing?.m ?? 0);
      storage.setReadReceipt(channelId, u.id, target);
    }
    res.json({ ok: true, messageId });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/projects/:id/read
  //
  // Clear the sidebar star for an entire company. Advances the caller's
  // read receipt to the current tip of every visible channel + DM in the
  // project, and marks the caller's missed calls (whose room maps back to
  // any of those channels) as "seen" by rewriting them to status='ended'.
  // Best-effort per row; a single failure doesn't fail the batch.
  // ──────────────────────────────────────────────────────────────────────
  app.post("/api/projects/:id/read", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const access = (req as AuthedRequest).access;
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "invalid projectId" });
    }
    if (!userCanAccessProject(u.id, u.orgId, projectId, access)) {
      return res.status(404).json({ message: "Not found" });
    }

    // Collect every channel this user can see under the project, including
    // DMs (they're channel rows with scope='dm').
    let list = storage.listChannelsForUserInProject(projectId, u.id);
    if (access) {
      list = list.filter(c => mtCanSeeChannel(access, c.projectId, c.regionId ?? null));
    }
    const projectChannelIds = new Set<number>(list.map(c => c.id));
    const dmChannels = storage.listDmChannelsForUser(u.id);
    for (const c of dmChannels) {
      if (c.projectId === projectId) projectChannelIds.add(c.id);
    }

    let advanced = 0;
    for (const cid of Array.from(projectChannelIds)) {
      try {
        const tip = rawDb
          .prepare(`SELECT MAX(id) AS tip FROM messages WHERE channel_id = ?`)
          .get(cid) as { tip: number | null } | undefined;
        const tipId = tip?.tip ?? 0;
        if (tipId <= 0) continue;
        const existing = rawDb
          .prepare(`SELECT last_read_message_id AS m FROM read_receipts WHERE channel_id = ? AND user_id = ?`)
          .get(cid, u.id) as { m: number | null } | undefined;
        const target = Math.max(tipId, existing?.m ?? 0);
        storage.setReadReceipt(cid, u.id, target);
        advanced += 1;
      } catch {
        /* per-channel best-effort */
      }
    }

    // Ack missed calls that map back to a channel in this project.
    let missedAcked = 0;
    try {
      const missed = rawDb
        .prepare(
          `SELECT id, room_name AS roomName FROM direct_calls
            WHERE callee_id = ? AND status = 'missed'
              AND started_at > (strftime('%s','now') - 24*3600)`
        )
        .all(u.id) as Array<{ id: number; roomName: string }>;
      for (const row of missed) {
        const m = row.roomName?.match(/(?:group-channel-|vector-\d+-channel-)(\d+)/);
        if (!m) continue;
        const cid = Number(m[1]);
        if (!projectChannelIds.has(cid)) continue;
        rawDb.prepare(`UPDATE direct_calls SET status = 'ended' WHERE id = ?`).run(row.id);
        missedAcked += 1;
      }
    } catch {
      /* best-effort */
    }

    res.json({ ok: true, channelsAdvanced: advanced, missedCallsAcked: missedAcked });
  });

  // Multi-tenant: list regions for a project. Returns only regions the user
  // has at least one grant for (whole-project grant returns all regions).
  // Used by the sidebar to render the "Company → Region" tree.
  app.get("/api/projects/:id/regions", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const access = (req as AuthedRequest).access;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id, access)) return res.status(404).json({ message: "Not found" });
    const all = rawDb
      .prepare(`SELECT id, project_id AS projectId, code, name, position, auth_location_id AS authLocationId FROM regions WHERE project_id = ? ORDER BY position ASC, id ASC`)
      .all(id) as Array<{ id: number; projectId: number; code: string; name: string; position: number; authLocationId: string | null }>;
    if (!access || access.isSuperAdmin) return res.json(all);
    const regionsForProject = access.regionsByProject.get(id);
    // Whole-project grant (set contains null) -> see all regions.
    if (regionsForProject?.has(null as any)) return res.json(all);
    const allowed = regionsForProject ?? new Set<number>();
    res.json(all.filter(r => allowed.has(r.id)));
  });

  app.post("/api/projects/:id/channels", requireAuth, requireCap(can.chat.createChannel), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    if (!userCanAccessProject(u.id, u.orgId, id, (req as AuthedRequest).access)) return res.status(404).json({ message: "Not found" });
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
    // Multi-tenant: validate the optional region belongs to this project,
    // and that the caller has access to it. NULL = company-wide channel.
    let regionId: number | null = null;
    if (parsed.data.regionId != null) {
      const region = rawDb
        .prepare(`SELECT id, project_id AS projectId FROM regions WHERE id = ?`)
        .get(parsed.data.regionId) as { id: number; projectId: number } | undefined;
      if (!region || region.projectId !== id) {
        return res.status(400).json({ message: "Region does not belong to this company" });
      }
      const access = (req as AuthedRequest).access;
      if (access && !mtCanSeeChannel(access, id, region.id)) {
        return res.status(404).json({ message: "Not found" });
      }
      regionId = region.id;
    }
    const existing = storage.listChannelsByProject(id);
    // Phase 1.9.3 — if the caller is attaching a contract at creation, the
    // linkedContract payload carries the cached metadata. Validated by the
    // schema; we add the audit fields (who/when) server-side.
    const linkedContract = parsed.data.linkedContract
      ? {
          contractId: parsed.data.linkedContract.contractId,
          title: parsed.data.linkedContract.title,
          ref: parsed.data.linkedContract.ref ?? null,
          appUrl: parsed.data.linkedContract.appUrl,
          pdfUrl: parsed.data.linkedContract.pdfUrl ?? null,
          attachedByUserId: u.id,
          attachedAt: Date.now(),
        }
      : null;
    const channel = storage.createChannel({
      projectId: id,
      workObjectId,
      regionId,
      position: existing.length,
      name: parsed.data.name,
      type: parsed.data.type,
      topic: parsed.data.topic ?? null,
      scope: parsed.data.scope,
      entityId: parsed.data.scope === "entity" ? parsed.data.entityId ?? null : null,
      teamRole: parsed.data.scope === "team" ? parsed.data.teamRole ?? null : null,
      linkedContract,
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
    // Phase 1.9.3 — announce the attached contract in the channel so
    // members see it inline immediately (and the message becomes searchable).
    if (linkedContract) {
      try {
        storage.createMessage({
          channelId: channel.id,
          userId: u.id,
          content: `📄 Contract attached: ${linkedContract.title}`,
          meta: JSON.stringify({ system: true, kind: "contract_attached", contractId: linkedContract.contractId, title: linkedContract.title, ref: linkedContract.ref ?? null, appUrl: linkedContract.appUrl, pdfUrl: linkedContract.pdfUrl ?? null }),
        });
      } catch (e) {
        // Non-fatal — channel is created either way.
        console.warn("[create-channel] contract-attached system message skipped:", (e as Error).message);
      }
    }
    res.json(channel);
  });

  // Phase 1.9.3 — attach (or replace) a contract on an existing channel.
  // Admin/foreman only — same role as channel create. Posts a system
  // message announcing the attachment.
  app.post("/api/channels/:id/linked-contract", requireAuth, requireCap(can.chat.createChannel), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Invalid channel id" });
    const ch = storage.getChannel(channelId);
    if (!ch) return res.status(404).json({ message: "Channel not found" });
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });
    // Empty body — detach.
    if (!req.body || Object.keys(req.body).length === 0) {
      const updated = storage.setChannelLinkedContract(channelId, null);
      return res.json(updated);
    }
    const parsed = linkedContractAttachSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input" });
    const meta = {
      contractId: parsed.data.contractId,
      title: parsed.data.title,
      ref: parsed.data.ref ?? null,
      appUrl: parsed.data.appUrl,
      pdfUrl: parsed.data.pdfUrl ?? null,
      attachedByUserId: u.id,
      attachedAt: Date.now(),
    };
    const updated = storage.setChannelLinkedContract(channelId, meta);
    try {
      storage.createMessage({
        channelId,
        userId: u.id,
        content: `📄 Contract attached: ${meta.title}`,
        meta: JSON.stringify({ system: true, kind: "contract_attached", contractId: meta.contractId, title: meta.title, ref: meta.ref, appUrl: meta.appUrl, pdfUrl: meta.pdfUrl }),
      });
    } catch (e) {
      console.warn("[attach-contract] system message skipped:", (e as Error).message);
    }
    res.json(updated);
  });

  // Phase 1.9.3 — proxy: list contracts from bulldog-contracts so the chat
  // UI can populate an "Attach contract" dropdown. Contracts is a separate
  // service with its own session, so forwarding the chat cookie 401s. Instead
  // authenticate service-to-service with SUITE_INTERNAL_SECRET and pass the
  // user's email so contracts can apply its own role/company filtering.
  app.get("/api/contracts/list", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const contractsBase = (process.env.CONTRACTS_BASE_URL || "https://vectorcontracts.bulldogops.com").replace(/\/+$/, "");
    const secret = process.env.SUITE_INTERNAL_SECRET;
    if (!secret) {
      return res.status(503).json({ message: "SUITE_INTERNAL_SECRET not configured on chat" });
    }
    const search = typeof req.query.q === "string" ? `?q=${encodeURIComponent(req.query.q)}` : "";
    try {
      const upstream = await fetch(`${contractsBase}/api/suite/contracts/list${search}`, {
        headers: {
          "x-suite-secret": secret,
          "x-bulldog-user-email": u.email,
        },
      });
      const text = await upstream.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
      if (!upstream.ok) {
        return res.status(upstream.status).json({
          message: (body && body.message) || `Contracts proxy failed (${upstream.status})`,
          upstream: body,
        });
      }
      // Pass through the list as-is; the UI only needs id/title/contractNumber.
      res.json(body);
    } catch (err) {
      console.error("[contracts proxy]", err);
      res.status(502).json({ message: "Failed to reach contracts service" });
    }
  });

  // Phase 1.9.15 — proxy a channel's linked-contract PDF through the chat
  // server. Loading the contract file directly as an <iframe>/<object> src
  // against vectorcontracts.* fails: the auth cookie is scoped to the chat
  // origin and isn't sent on a cross-origin document load, so the file
  // endpoint 401s. Here we resolve the channel's stored pdfUrl, fetch it
  // server-side authenticating with the suite shared secret (contracts has
  // its own session, so forwarding the chat cookie doesn't work), and stream
  // the bytes back same-origin so the client can render it without CORS or
  // auth headaches.
  app.get("/api/contracts-proxy/:channelId", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.channelId);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Invalid channel id" });
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });
    const ch = storage.getChannel(channelId);
    const rawPdfUrl = (ch?.linkedContract as { pdfUrl?: string | null } | null | undefined)?.pdfUrl;
    if (!rawPdfUrl) return res.status(404).json({ message: "No contract PDF linked to this channel" });

    // Earlier contract bridge writes captured a SPA hash route in pdfUrl
    // (e.g. https://vectorcontracts.../api/#/contracts/130/file). When that
    // URL is fetched server-side the fragment is stripped, the upstream sees
    // just `/api/` and returns 200 with the index.html — which is why the
    // PDF panel was rendering a blank page. Normalize by removing the `/#`
    // and any trailing slash before `#`, so we hit the real REST endpoint.
    const pdfUrl = rawPdfUrl
      .replace(/\/api\/#\/contracts\//, "/api/contracts/")
      .replace(/\/#\/contracts\//, "/contracts/");

    // Don't forward the user's chat-origin cookie/bearer — the contracts
    // server (vectorcontracts.*) has its own session on a different cookie
    // domain, so those creds 401 there. Authenticate service-to-service with
    // the suite shared secret instead, sent both as the X-Suite-Secret header
    // and a ?secret= query param so either server-side check is satisfied.
    const secret = process.env.SUITE_INTERNAL_SECRET;
    try {
      // If the stored URL is the app-route form (e.g. /contracts/130 instead
      // of /api/contracts/130/file) try to coerce it to the API form.
      let normalizedUrl = pdfUrl;
      const appRouteMatch = pdfUrl.match(/^(https?:\/\/[^/]+)\/contracts\/(\d+)(?:\/file)?$/);
      if (appRouteMatch) {
        normalizedUrl = `${appRouteMatch[1]}/api/contracts/${appRouteMatch[2]}/file`;
      }
      let upstreamUrl = normalizedUrl;
      if (secret) {
        upstreamUrl += (normalizedUrl.includes("?") ? "&" : "?") + `secret=${encodeURIComponent(secret)}`;
      }
      const upstream = await fetch(upstreamUrl, {
        headers: {
          ...(secret ? { "x-suite-secret": secret } : {}),
        },
      });
      const maskedUrl = secret
        ? upstreamUrl.replace(/secret=[^&]+/, "secret=***")
        : upstreamUrl;
      const upstreamCt = upstream.headers.get("content-type") || "";
      console.log("[contracts pdf proxy] channel=%d url=%s upstream=%d ct=%s", channelId, maskedUrl, upstream.status, upstreamCt);
      // Defensive: if the upstream handed us HTML (e.g. the SPA fallthrough),
      // surface that as a 502 instead of dumping a blank page to the user.
      if (upstreamCt.includes("text/html")) {
        return res.status(502).json({ message: "Contracts service returned HTML, expected PDF", upstreamUrl: maskedUrl });
      }
      if (!upstream.ok || !upstream.body) {
        return res.status(upstream.status || 502).json({
          message: "Upstream contracts fetch failed",
          upstreamStatus: upstream.status,
        });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/pdf");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      res.setHeader("Content-Disposition", "inline");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (err) {
      console.error("[contracts pdf proxy]", err);
      res.status(502).json({ message: "Failed to reach contracts service" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1.9.4 — AI clerk (meeting notes)
  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle: start → stream audio chunks → stop → background pipeline
  // (transcribe → summarize → PDF → Synology). FE polls GET /notes for
  // status updates. Audio chunks come in as raw binary (audio/webm-opus)
  // — we register express.raw() locally so the global JSON parser doesn't
  // try to parse them.

  app.get("/api/meeting-clerk/config", requireAuth, (_req, res) => {
    res.json(getClerkConfigSummary());
  });

  app.post("/api/channels/:id/meeting-notes/start", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Invalid channel id" });
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access || !access.channel) return res.status(404).json({ message: "Channel not found" });
    // Accept optional roomName from the client so we can poll actual call
    // participants rather than falling back to the full channel roster.
    const clerkRoomName = typeof req.body?.roomName === "string" ? req.body.roomName.trim() : undefined;
    try {
      const result = await startClerk({ channelId, startedByUserId: u.id, roomName: clerkRoomName });
      // Drop a system message into the channel so everyone knows the clerk
      // is recording. Required for two-party consent (WA is two-party).
      try {
        storage.createMessage({
          channelId,
          userId: u.id,
          content: `🤖 AI clerk started — this meeting is being transcribed and summarized.`,
          meta: JSON.stringify({
            system: true,
            kind: "clerk_started",
            noteId: result.noteId,
            startedByUserId: u.id,
          }),
        });
      } catch (e) {
        console.warn("[clerk] start system message skipped:", (e as Error).message);
      }
      res.json({ noteId: result.noteId, status: result.status, config: result.config });
    } catch (err) {
      console.error("[clerk] start failed:", err);
      res.status(500).json({ message: (err as Error).message || "Failed to start clerk" });
    }
  });

  // Raw audio chunk ingestion. Limit per chunk = 5MB which is generous for
  // a few seconds of opus. We use express.raw() inline so this single
  // route bypasses the JSON body parser.
  app.post(
    "/api/meeting-notes/:id/audio",
    requireAuth,
    express.raw({ type: "*/*", limit: "5mb" }) as any,
    (req, res) => {
      const u = (req as AuthedRequest).user;
      const noteId = Number(req.params.id);
      if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
      const note = getNote(noteId);
      if (!note) return res.status(404).json({ message: "Note not found" });
      const access = userCanAccessChannel(u.id, u.orgId, note.channel_id, (req as AuthedRequest).access);
      if (!access) return res.status(404).json({ message: "Channel not found" });
      const buf: Buffer | undefined = Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined;
      if (!buf || buf.length === 0) return res.status(400).json({ message: "No audio bytes" });
      const result = ingestAudioChunk(noteId, buf);
      if (!result.ok) return res.status(409).json({ message: result.reason || "Session closed" });
      res.json({ ok: true, bytes: buf.length });
    },
  );

  app.post("/api/meeting-notes/:id/stop", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const noteId = Number(req.params.id);
    if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
    const note = getNote(noteId);
    if (!note) return res.status(404).json({ message: "Note not found" });
    const access = userCanAccessChannel(u.id, u.orgId, note.channel_id, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });
    try {
      const result = await stopClerk(noteId);
      try {
        storage.createMessage({
          channelId: note.channel_id,
          userId: u.id,
          content: `🤖 AI clerk stopped — notes will appear shortly.`,
          meta: JSON.stringify({
            system: true,
            kind: "clerk_stopped",
            noteId,
            stoppedByUserId: u.id,
          }),
        });
      } catch (e) {
        console.warn("[clerk] stop system message skipped:", (e as Error).message);
      }
      res.json({ ok: result.ok, status: result.status });
    } catch (err) {
      res.status(500).json({ message: (err as Error).message || "Failed to stop clerk" });
    }
  });

  // List notes for a channel (for the channel header dropdown / history).
  app.get("/api/channels/:id/meeting-notes", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Invalid channel id" });
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });
    const rows = listNotesForChannel(channelId);
    res.json(rows.map(publicNoteShape));
  });

  app.get("/api/meeting-notes/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const noteId = Number(req.params.id);
    if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
    const note = getNote(noteId);
    if (!note) return res.status(404).json({ message: "Note not found" });
    const access = userCanAccessChannel(u.id, u.orgId, note.channel_id, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });
    res.json(publicNoteShape(note));
  });

  // Phase 2.3 — transcript recipient selection. The clerk lands the note in
  // 'awaiting_recipients' instead of fan-out-emailing every attendee. The FE
  // calls these two endpoints to (a) read the candidate list and (b) commit
  // a Send (subset of attendees) or Skip decision.
  app.get("/api/meeting-notes/:id/recipients", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const noteId = Number(req.params.id);
    if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
    const note = getNote(noteId);
    if (!note) return res.status(404).json({ message: "Note not found" });
    const access = userCanAccessChannel(u.id, u.orgId, note.channel_id, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });
    res.json({ candidates: getSummaryRecipientCandidates(noteId) });
  });

  // Send (or skip) the transcript email. Only the user who started the clerk
  // or an org admin may decide. Body: { recipientUserIds: number[] } to send,
  // or { skip: true } to record "don't email anyone".
  app.post("/api/meeting-notes/:id/send-summary", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const noteId = Number(req.params.id);
    if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
    const note = getNote(noteId);
    if (!note) return res.status(404).json({ message: "Note not found" });
    const access = userCanAccessChannel(u.id, u.orgId, note.channel_id, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });

    const isStarter = note.started_by_user_id === u.id;
    const isAdmin = u.role === "admin";
    if (!isStarter && !isAdmin) {
      return res.status(403).json({ message: "Only the clerk's starter or an admin can pick recipients" });
    }

    try {
      const body = (req.body ?? {}) as { recipientUserIds?: number[]; skip?: boolean };
      if (body.skip === true) {
        const result = skipSummaryEmails(noteId, u.id);
        return res.json(result);
      }
      const ids = Array.isArray(body.recipientUserIds)
        ? body.recipientUserIds.filter((n: unknown) => typeof n === "number" && Number.isFinite(n))
        : [];
      const result = await sendSummaryEmails(noteId, ids as number[], u.id);
      return res.json(result);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message || "Failed to send summary" });
    }
  });

  // Phase 1.9.20 — delete a meeting note. The author of the note (the user
  // who started the clerk) and org admins can delete. The Synology PDF (if
  // already uploaded) and the system message in the channel stay as a paper
  // trail — only the chat-side DB row is removed.
  app.delete("/api/meeting-notes/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const noteId = Number(req.params.id);
    if (!Number.isFinite(noteId)) return res.status(400).json({ message: "Invalid note id" });
    const note = getNote(noteId);
    if (!note) return res.status(404).json({ message: "Note not found" });
    const access = userCanAccessChannel(u.id, u.orgId, note.channel_id, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });
    const isAuthor = note.started_by_user_id === u.id;
    const isAdmin = u.role === "admin";
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ message: "Only the note's author or an admin can delete" });
    }
    const ok = deleteNote(noteId);
    if (!ok) return res.status(404).json({ message: "Note already deleted" });
    res.json({ ok: true });
  });

  // List members of a private channel (admin/creator visibility, but here
  // we allow any project member who can see the channel to read the roster).
  // Effective audience of the channel — i.e. everyone the chat would actually
  // reach if someone posted in it. This expands scope semantics:
  //
  //   global    -> every member of the parent project (the company workspace)
  //   entity    -> every project member whose user.title matches channel.entityId
  //   team      -> every project member whose user.role matches channel.teamRole
  //   private   -> only the explicit rows in channel_members
  //   dm        -> only the explicit rows in channel_members
  //
  // Any explicit channel_members rows are *additive grants* on top of the
  // scope-derived set (e.g. a non-team-role user can be granted access to a
  // team-scoped channel by being added explicitly), so we union them in for
  // every scope. Returns sanitized ApiUser[]. Used by ChannelCallDialog,
  // ScheduleCallDialog, and the channel members popover so they all agree
  // on "who is actually in this channel".
  app.get("/api/channels/:id/members", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access || !access.channel || !access.project) {
      return res.status(404).json({ message: "Not found" });
    }
    const channel = access.channel;
    const explicitIds = new Set(storage.listChannelMemberIds(channelId));
    const projectMembers = storage.listUsersByOrg(u.orgId).filter(
      (m) => storage.isProjectMember(access.project!.id, m.id) && m.status !== "deactivated",
    );
    const scope = (channel.scope ?? "global") as "global" | "entity" | "team" | "private" | "dm";
    const audienceIds = new Set<number>(explicitIds);
    if (scope === "global") {
      for (const m of projectMembers) audienceIds.add(m.id);
    } else if (scope === "entity" && channel.entityId) {
      const want = channel.entityId.toLowerCase();
      for (const m of projectMembers) {
        if ((m.title ?? "").toLowerCase() === want) audienceIds.add(m.id);
      }
    } else if (scope === "team" && channel.teamRole) {
      for (const m of projectMembers) {
        if (m.role === channel.teamRole) audienceIds.add(m.id);
      }
    }
    // private + dm: explicit-only (already in audienceIds via the seed above).
    res.json(storage.listUsersByIds([...audienceIds]).map(sanitize));
  });

  // Explicit-grants-only members (the rows actually in the channel_members
  // table). Used by the admin "Manage channel members" view where we need to
  // show what's been explicitly added, separate from the scope-derived
  // audience. ChannelCallDialog / ScheduleCallDialog use the audience
  // endpoint above instead.
  app.get("/api/channels/:id/explicit-members", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Not found" });
    const ids = storage.listChannelMemberIds(channelId);
    res.json(storage.listUsersByIds(ids).map(sanitize));
  });

  // Add members to a private channel. Admins only — keeps the surface
  // small. Foreman can be added later if needed.
  app.post("/api/channels/:id/members", requireAuth, requireCap(can.chat.manageChannelMembers), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access || !access.channel) return res.status(404).json({ message: "Not found" });
    // Any scope can have explicit members — they serve as extra grants on
    // top of the scope's built-in visibility (entity/team/global).
    const raw = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const wanted = raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0);
    if (wanted.length === 0) return res.status(400).json({ message: "userIds required" });
    const orgMemberIds = new Set(storage.listUsersByOrg(u.orgId).map(m => m.id));
    const filtered = wanted.filter((id: number) => orgMemberIds.has(id));
    // Only notify users who were not already members (avoid re-pinging).
    const existing = new Set(storage.listChannelMemberIds(channelId));
    const newlyAdded = filtered.filter((id: number) => !existing.has(id));
    storage.addChannelMembers(channelId, filtered);
    // Cross-app: emit channel_add to Bulldog Ops (keyed on email). Ops applies
    // its own consent gate + toggles + escalation. Fire-and-forget.
    if (newlyAdded.length > 0) {
      const channelName = access.channel.name || "a channel";
      const base = (process.env.CHAT_BASE_URL || "https://chat.bulldogops.com").replace(/\/$/, "");
      const linkUrl = `${base}/?channel=${channelId}`;
      const recipients = storage.listUsersByIds(newlyAdded)
        .filter((m) => !!m.email)
        .map((m) => ({ email: m.email }));
      emitOpsNotifications(recipients, {
        eventType: "channel_add",
        message: `Bulldog Chat: You were added to #${channelName}.`,
        linkUrl,
        payload: { channelId, channelName },
      }).catch((e) => console.warn("[channels] ops emit failed:", e));
    }
    res.json({ ok: true, memberIds: storage.listChannelMemberIds(channelId) });
  });

  // Remove a channel member. Admins can remove anyone; a non-admin can
  // only remove themself (self-leave). Scope-specific channels keep their
  // role/entity visibility — the removal only strips the explicit grant.
  app.delete("/api/channels/:id/members/:userId", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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
  app.delete("/api/channels/:id", requireAuth, requireCap(can.chat.deleteChannel), (req, res) => {
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
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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
  // `title` rides along on the spread (`...c`) since it's now a plain column
  // on the channels row — null unless the caller (or another member) set a
  // custom title via PATCH /api/dms/:id or POST /api/dms/titled.
  app.get("/api/dms", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const chs = storage.listDmChannelsForUser(u.id);
    const wire = chs.map(c => ({
      ...c,
      memberIds: storage.listChannelMemberIds(c.id),
    }));
    res.json(wire);
  });

  // Titled Chats (Phase 2.5) — always creates a NEW DM channel with a
  // required title, even if a DM with this member set already exists.
  // Distinct from POST /api/dms (which is find-or-create / participant-
  // keyed): titled chats are topic-based, so multiple titled threads with
  // the same people are allowed side by side.
  app.post("/api/dms/titled", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = req.body ?? {};
    const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
    if (rawTitle.length < 1) {
      return res.status(400).json({ message: "Title is required" });
    }
    if (rawTitle.length > 80) {
      return res.status(400).json({ message: "Title must be 80 characters or fewer" });
    }

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

    // Same org-membership validation as POST /api/dms.
    const targets = storage.listUsersByIds(memberIds);
    const okIds = new Set(targets.filter(t => t.orgId === u.orgId).map(t => t.id));
    const cleaned = memberIds.filter(id => okIds.has(id));
    if (cleaned.length === 0) {
      return res.status(400).json({ message: "No valid recipients in your organization" });
    }

    const homeProjects = storage.listProjectsForUserInOrg(u.id, u.orgId);
    const homeProject = homeProjects[0];
    if (!homeProject) return res.status(400).json({ message: "No home project — contact an admin" });

    const ch = storage.createTitledDmChannel({
      projectId: homeProject.id,
      memberIds: cleaned,
      createdByUserId: u.id,
      title: rawTitle,
    });
    const allMemberIds = storage.listChannelMemberIds(ch.id);
    emitDmCreated(u.orgId, { channelId: ch.id, title: ch.title ?? null, memberIds: allMemberIds });
    res.json({
      ...ch,
      memberIds: allMemberIds,
      created: true,
    });
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

  // Titled Chats (Phase 2.5) — set or clear a DM channel's custom title.
  // Pass `title: null` to clear it (falls back to the participant-name-list
  // label in the UI). Any member of the DM can rename it — same "no owner"
  // model as delete.
  app.patch("/api/dms/:id", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    if (!Number.isFinite(channelId)) return res.status(400).json({ message: "Invalid id" });
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "Not found" });
    if (channel.scope !== "dm") {
      return res.status(400).json({ message: "Not a DM channel" });
    }
    if (!storage.isChannelMember(channelId, u.id)) {
      return res.status(403).json({ message: "Not a member of this DM" });
    }

    const body = req.body ?? {};
    if (!("title" in body)) {
      return res.status(400).json({ message: "title is required (string or null)" });
    }
    let title: string | null;
    if (body.title === null) {
      title = null;
    } else if (typeof body.title === "string") {
      const trimmed = body.title.trim();
      if (trimmed.length > 80) {
        return res.status(400).json({ message: "Title must be 80 characters or fewer" });
      }
      // Trimming to "" is treated the same as clearing — an empty title isn't
      // useful and would render as a blank sidebar row.
      title = trimmed.length > 0 ? trimmed : null;
    } else {
      return res.status(400).json({ message: "title must be a string or null" });
    }

    const updated = storage.setDmChannelTitle(channelId, title);
    if (!updated) return res.status(404).json({ message: "Not found" });
    const memberIds = storage.listChannelMemberIds(channelId);
    emitDmUpdated(u.orgId, { channelId, title: updated.title ?? null, memberIds });
    res.json({ ...updated, memberIds, title: updated.title ?? null });
  });

  // ── MESSAGES ──
  app.get("/api/channels/:id/messages", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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

    // Feature 2.1 — photo bridge to Ops. If this channel maps to a job_site
    // work object whose attributes carry opsJobId, and the message linked at
    // least one image attachment, fire-and-forget a POST to Ops so today's
    // draft daily_log picks up the field photo. Never blocks send.
    if (parsed.data.attachmentIds && parsed.data.attachmentIds.length > 0) {
      firePhotoBridgeToOps({
        channelId,
        messageId: msg.id,
        authorUserId: u.id,
      });
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
      void sendNotificationToUsers(
        Array.from(recipientIds),
        {
          title,
          body: isDm ? parsed.data.content.slice(0, 140) : `${u.name}: ${parsed.data.content.slice(0, 140)}`,
          url: isDm ? `/#/dms/${channelId}/m/${msg.id}` : `/#/channels/${channelId}/m/${msg.id}`,
          tag: isDm ? `dm-${channelId}` : `channel-${channelId}`,
        },
        { channelId },
      );

      // Opt-in SMS mirror for DMs + @-mentions. Fires only when the recipient
      // has smsConsentStatus="granted" AND smsMasterEnabled in bulldog-auth.
      // No dedicated per-event flag yet — tracked in server/auth-consent.ts.
      // Fail-closed: any lookup failure just skips SMS. Push still lands.
      if (smsAvailable()) {
        void (async () => {
          const recipients = storage.listUsersByIds(Array.from(recipientIds));
          const preview = parsed.data.content.replace(/\s+/g, " ").trim().slice(0, 120);
          for (const r of recipients) {
            if (!r.email) continue;
            const wasMention = userMentions.has(r.id) || hasEveryone || hasHere;
            const eventKey: "chat_dm_notify" | "chat_mention_notify" =
              isDm ? "chat_dm_notify" : "chat_mention_notify";
            try {
              const consent = await checkSmsConsent(r.email, eventKey);
              if (!consent.allowed || !consent.phoneE164) continue;
              const label = isDm
                ? `${u.name}`
                : `${u.name} · #${access.channel!.name}`;
              const openUrl = isDm
                ? `https://chat.bulldogops.com/#/dms/${channelId}/m/${msg.id}`
                : `https://chat.bulldogops.com/#/channels/${channelId}/m/${msg.id}`;
              // Keep the SMS terse: sender + preview + one deep link. No
              // marketing copy — TCPA compliance is easier when the body is
              // clearly a transactional relay of an in-app event.
              const smsBody = `Bulldog: ${label}\n${preview}\n${openUrl}`;
              await sendSms({ to: consent.phoneE164, body: smsBody });
            } catch {
              /* best-effort */
              void wasMention;
            }
          }
        })();
      }
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

  // Phase 2.2 (Feature 2.2) — Promote a chat message into a Contracts
  // change-order draft. The source channel must be linked to a contract
  // (channels.linkedContract populated by the contracts create-channel
  // bridge). Contracts owns idempotency on (channelId, messageId), so
  // calling this twice returns the same coId with existing:true.
  //
  // Body: { title?, description?, quotedText? }  All optional; quotedText
  // defaults to the source message content.
  app.post("/api/messages/:msgId/promote-to-change-order", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const msgId = Number(req.params.msgId);
    if (!Number.isFinite(msgId)) return res.status(400).json({ message: "Invalid message id" });

    const src = storage.getMessage(msgId);
    if (!src) return res.status(404).json({ message: "Message not found" });
    const channelId = src.channelId;
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });

    const linked = resolveContractForChannel(channelId);
    if (!linked) return res.status(400).json({ message: "This channel isn't linked to a contract" });
    const jobId = resolveJobIdForChannel(channelId) ?? undefined;

    const bodyIn = (req.body ?? {}) as { title?: string; description?: string; quotedText?: string };
    const quotedText = (typeof bodyIn.quotedText === "string" && bodyIn.quotedText.trim().length > 0)
      ? bodyIn.quotedText
      : (src.content ?? "").trim() || "(no message text)";
    const title = typeof bodyIn.title === "string" ? bodyIn.title.slice(0, 200) : undefined;
    const description = typeof bodyIn.description === "string" ? bodyIn.description.slice(0, 20000) : undefined;

    const author = storage.getUser(u.id);
    if (!author?.email) return res.status(400).json({ message: "Caller has no email on record" });

    const result = await promoteMessageToChangeOrder({
      channelId,
      messageId: msgId,
      quotedText,
      authorEmail: author.email,
      authorUserId: u.id,
      orgId: u.orgId,
      contractId: linked.contractId,
      jobId,
      title,
      description,
    });

    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }

    // Post a system card back into the channel so everyone sees the CO
    // was promoted (or that it already existed). Best-effort; a failure
    // here doesn't fail the API call — the CO is already created upstream.
    try {
      const card = buildChangeOrderPromotedSystemMessage({
        coId: result.coId,
        coNumber: result.coNumber,
        contractId: linked.contractId,
        contractTitle: linked.contractTitle,
        deepLink: result.deepLink,
        quotedText,
        sourceMessageId: msgId,
        existing: result.existing,
      });
      const sysMsg = storage.createMessage({
        channelId,
        userId: u.id,
        content: card.content,
        meta: card.meta,
      });
      const wire = buildWireMessage(sysMsg.id);
      if (wire) emitMessageNew(u.orgId, wire);
    } catch (err) {
      console.warn("[promote-to-co] system card post failed:", (err as Error).message);
    }

    res.json({
      ok: true,
      coId: result.coId,
      coNumber: result.coNumber,
      deepLink: result.deepLink,
      existing: result.existing,
      contractId: linked.contractId,
      contractTitle: linked.contractTitle,
    });
  });

  // Phase 1.9.36 — admin-only "clear channel" bulk tombstone. Wipes every
  // non-deleted message in the channel and fans out a delete+update event
  // per id so all live clients re-render rows as tombstones. We deliberately
  // do NOT touch meeting-notes, scheduled calls, or work objects — those
  // have their own delete paths. Use double-confirm in the UI.
  app.delete("/api/channels/:id/messages", requireAuth, requireCap(can.chat.clearChannel), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Not found" });
    const { ids } = storage.tombstoneChannelMessages(channelId, u.id);
    for (const id of ids) {
      const wire = buildWireMessage(id);
      if (wire) emitMessageUpdate(u.orgId, wire);
      emitMessageDelete(u.orgId, { channelId, messageId: id });
    }
    res.json({ ok: true, clearedCount: ids.length });
  });

  // Canonical slug used for fuzzy channel-name matching: lowercase, runs of
  // non-alphanumerics collapsed to one dash, edges trimmed. Mirrors
  // storage.findChannelByName so suggestions rank by the same notion of
  // "close".
  const channelSlug = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // Score a stored channel name against the query. Higher is closer.
  // Cheap heuristic: exact slug match wins, then substring inclusion (either
  // direction), then count of shared dash-delimited word tokens.
  const channelMatchScore = (query: string, name: string): number => {
    const q = channelSlug(query);
    const n = channelSlug(name);
    if (!q || !n) return 0;
    if (q === n) return 1000;
    let score = 0;
    if (n.includes(q) || q.includes(n)) score += 100;
    const qTokens = new Set(q.split("-").filter(Boolean));
    const nTokens = n.split("-").filter(Boolean);
    for (const t of nTokens) if (qTokens.has(t)) score += 10;
    return score;
  };

  // Top-5 channels closest to `query`, by channelMatchScore. Returns [] when
  // the query is empty or nothing scores above zero.
  const suggestChannels = (query: string): Array<{ id: number; name: string }> => {
    if (!query.trim()) return [];
    return storage.listAllChannels()
      .map(c => ({ id: c.id, name: c.name, score: channelMatchScore(query, c.name) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map(({ id, name }) => ({ id, name }));
  };

  // Phase 1.9.36c — internal ops: list channels (companion to clear-channel).
  //
  // Same SUITE_INTERNAL_SECRET (X-Suite-Secret) auth as clear-channel. Used to
  // discover the exact channel name/id when a clear-channel call 404s. Returns
  // every channel across all orgs by default; pass ?orgId=N to scope to one
  // org. Security is the shared secret, not per-user membership.
  //
  //   GET /internal/admin/channels[?orgId=N]
  //   headers: X-Suite-Secret: <SUITE_INTERNAL_SECRET>
  //   returns: { channels: [{ id, orgId, name, scope, memberCount }, ...] }  // sorted by name
  app.get("/internal/admin/channels", (req, res) => {
    const expected = process.env.SUITE_INTERNAL_SECRET;
    if (!expected) {
      return res.status(503).json({ message: "SUITE_INTERNAL_SECRET not configured" });
    }
    const given = req.header("x-suite-secret");
    if (!given || given !== expected) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const orgIdRaw = req.query.orgId;
    let orgFilter: number | undefined;
    if (typeof orgIdRaw === "string" && orgIdRaw.trim() !== "") {
      const n = Number(orgIdRaw);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ message: "orgId must be a number" });
      }
      orgFilter = n;
    }

    const projectOrgId = new Map<number, number>();
    const orgIdForChannel = (projectId: number): number => {
      let cached = projectOrgId.get(projectId);
      if (cached === undefined) {
        cached = storage.getProject(projectId)?.orgId ?? 1;
        projectOrgId.set(projectId, cached);
      }
      return cached;
    };

    const channels = storage.listAllChannels()
      .map(c => ({
        id: c.id,
        orgId: orgIdForChannel(c.projectId),
        name: c.name,
        scope: c.scope,
        memberCount: storage.listChannelMemberIds(c.id).length,
      }))
      .filter(c => orgFilter === undefined || c.orgId === orgFilter)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);

    return res.json({ channels });
  });

  // Phase 1.9.36b — internal ops escape hatch for "clear channel".
  //
  // The user-facing DELETE /api/channels/:id/messages route is gated on the
  // admin `clearChannel` capability and on the caller being a member who can
  // access the channel. When that path silently fails (stale client, role
  // mismatch, dropped SSE) ops needs a way to force-clear a channel without a
  // browser. This endpoint is authenticated SOLELY by the shared
  // SUITE_INTERNAL_SECRET (X-Suite-Secret header) — the same secret the
  // contracts/ops bridges use — so it bypasses the per-user role/membership
  // checks entirely. The secret IS the authorization.
  //
  //   POST /internal/admin/clear-channel
  //   headers: X-Suite-Secret: <SUITE_INTERNAL_SECRET>
  //   body: { "channelName": "el-paso-data-center" }  OR  { "channelId": 123 }
  //   returns: { ok, channelId, channelName, clearedCount }
  //
  // channelName resolution is case/spacing/dash-insensitive (see
  // storage.findChannelByName). Events fan out per id exactly like the
  // user-facing route so any live clients re-render rows as tombstones.
  app.post("/internal/admin/clear-channel", (req, res) => {
    const expected = process.env.SUITE_INTERNAL_SECRET;
    if (!expected) {
      return res.status(503).json({ message: "SUITE_INTERNAL_SECRET not configured" });
    }
    const given = req.header("x-suite-secret");
    if (!given || given !== expected) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const body = (req.body ?? {}) as { channelId?: unknown; channelName?: unknown };
    let channel: ReturnType<typeof storage.getChannel> | undefined;
    if (typeof body.channelId === "number" || (typeof body.channelId === "string" && body.channelId.trim() !== "")) {
      const id = Number(body.channelId);
      if (Number.isFinite(id)) channel = storage.getChannel(id);
    } else if (typeof body.channelName === "string" && body.channelName.trim() !== "") {
      channel = storage.findChannelByName(body.channelName);
    } else {
      return res.status(400).json({ message: "Provide channelId (number) or channelName (string)" });
    }

    if (!channel) {
      const query = typeof body.channelName === "string" ? body.channelName : "";
      return res.status(404).json({ message: "Channel not found", suggestions: suggestChannels(query) });
    }

    // No createdByUserId column on channels; attribute the tombstone to the
    // system user (id 1), matching how seeded/system content is owned.
    const SYSTEM_USER_ID = 1;
    const org = storage.getProject(channel.projectId);
    const orgId = org?.orgId ?? 1;
    const { ids } = storage.tombstoneChannelMessages(channel.id, SYSTEM_USER_ID);
    for (const id of ids) {
      const wire = buildWireMessage(id);
      if (wire) emitMessageUpdate(orgId, wire);
      emitMessageDelete(orgId, { channelId: channel.id, messageId: id });
    }
    console.log(`[internal/clear-channel] cleared ${ids.length} message(s) in channel ${channel.id} ("${channel.name}") via suite secret`);
    return res.json({ ok: true, channelId: channel.id, channelName: channel.name, clearedCount: ids.length });
  });

  app.post("/api/messages/:id/pin", requireAuth, requireCap(can.chat.pinMessage), (req, res) => {
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
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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
  app.post("/api/channels/:id/dial-absent", requireAuth, requireCap(can.chat.createChannel), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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
  app.post("/api/channels/:id/dial-number", requireAuth, requireCap(can.chat.createChannel), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
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

    // Unified meetings model — mirror this 1:1 call into a meeting and link the
    // legacy row. The direct_call row keeps owning the ringing/missed lifecycle;
    // the meeting is the durable identity (stable code + LiveKit room). Best-
    // effort: a failure here must not break the call itself.
    linkCallToMeeting("direct_calls", row.id, {
      orgId: u.orgId, kind: "direct", hostUserId: u.id, livekitRoomName: roomName,
      title: `Call with ${callee.name}`, status: "active", startedAt: new Date(),
    });

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

    // Dual-ring: in addition to the browser/PWA ring above, dial the
    // callee's saved cell number via Twilio SIP so their phone rings at
    // the same time. Whichever leg they answer on wins; both can also
    // stay connected (phone as a companion audio device). Best-effort:
    // failures are logged and never break the call itself.
    const calleePhone = (callee as { phone?: string | null }).phone ?? null;
    if (calleePhone && sipConfigured()) {
      void (async () => {
        try {
          const ident = await dialPhoneIntoRoom({
            phone: calleePhone,
            roomName,
            displayName: callee.name,
            channelLabel: `call with ${u.name}`,
          });
          if (!ident) {
            console.warn(`[calls] SIP dial-out to ${callee.name} skipped — trunk unavailable`);
          }
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "failed";
          console.warn(`[calls] SIP dial-out to ${callee.name} failed: ${msg}`);
        }
      })();
    }

    // Auto-miss after 45s if not answered. Setinterval/timeout is fine
    // for a single-instance Render deployment; if we ever scale out
    // we'll need a job queue.
    setTimeout(() => {
      const current = storage.getDirectCall(row.id);
      if (current && current.status === "ringing") {
        storage.updateDirectCallStatus(row.id, "missed", { endedAt: new Date() });
        emitCallEnded({ ...payload, reason: "missed" });
      }
    }, 90_000);

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
    // Phase 1.9.27: solo meeting start. Previously we 400'd if no invitees
    // were supplied. Josh wants to start a meeting by himself (e.g. to use
    // the AI clerk for solo dictation), then invite people mid-call. So we
    // accept an empty target set and just mint the room + token for the
    // organizer. Per-invitee logic below already no-ops on empty arrays.
    const _solo =
      inviteeIds.length === 0 &&
      phoneNumbers.length === 0 &&
      phoneInviteeIds.length === 0 &&
      smsInviteeIds.length === 0 &&
      smsPhoneNumbers.length === 0;

    const access = userCanAccessChannel(u.id, u.orgId, channelId, (req as AuthedRequest).access);
    if (!access) return res.status(404).json({ message: "Channel not found" });

    if (!livekitConfigured()) {
      return res.status(503).json({ message: "Calling unavailable: LiveKit not configured" });
    }

    // Reuse an existing active huddle on this channel if one is open. This is
    // the dropped-then-rejoin fix: if Josh's connection blips and he re-taps
    // the huddle button, we want him back in the SAME LiveKit room as anyone
    // still on the call — not a fresh ghost room that fragments the meeting.
    // We only reuse rooms < 6h old to avoid clinging to a stale row if the
    // host never explicitly ended (e.g. browser closed mid-call).
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const existingHuddle = getActiveHuddleForChannel(channelId);
    const reuseExisting =
      !!existingHuddle &&
      Date.now() - new Date(existingHuddle.createdAt).getTime() < SIX_HOURS_MS;

    // One shared LiveKit room for the whole group call. If we're reusing an
    // existing huddle, point at its room name; otherwise tie a new one to the
    // channel id + epoch so back-to-back group calls don't collide.
    const groupRoomName = reuseExisting
      ? existingHuddle!.livekitRoomName
      : `group-channel-${channelId}-${Date.now()}`;

    // Unified meetings model — one meeting for the whole group call, bound to
    // the channel. On reuse we keep the existing meeting row (so the huddle
    // code/link stays stable). Otherwise we mint a fresh one. The per-invitee
    // direct_call rows below carry the ringing state regardless.
    const huddleMeetingId = reuseExisting
      ? existingHuddle!.id
      : linkCallToMeeting("livekit_rooms", -1, {
          orgId: u.orgId,
          kind: "channel_huddle",
          hostUserId: u.id,
          channelId,
          allowGuests: true,
          livekitRoomName: groupRoomName,
          title: access.channel?.name ? `#${access.channel.name} call` : "Channel call",
          status: "active",
          startedAt: new Date(),
        });
    // The huddle's shareable code/link, surfaced in the response so the client
    // can post a join card into the channel. Best-effort: a null meetingId
    // (createMeeting failed) just omits the link rather than failing the call.
    const huddleMeeting = huddleMeetingId ? getMeetingById(huddleMeetingId) : null;

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

    // Phase 1.9.27: don't 400 when there are no reachable invitees — the
    // caller may have intentionally started a solo meeting. The room + the
    // organizer's token below are still useful even with zero invitees.
    // We only surface this as a warning if the caller explicitly tried to
    // ring people who couldn't be reached (had IDs/phones but none valid).
    if (
      validInvitees.length === 0 &&
      phoneNumbers.length === 0 &&
      phoneInviteeRecords.filter((r) => r.phone).length === 0 &&
      (inviteeIds.length > 0 || phoneInviteeIds.length > 0)
    ) {
      // Continue — caller gets a solo room. We surface a dialWarning later.
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
        // Channel context so the callee's incoming modal shows "from #general"
        // and, on accept, the ActiveCallSession has channelId ready for the
        // MeetingClerk + in-call chat panel without regex parsing.
        channelId,
        channelName: access.channel?.name ?? null,
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
      // Deep-link into the channel with a ?call=<roomName> hint so tapping
      // the push opens the channel chat AND surfaces the join banner. The
      // client's channel view reads the hint on mount and offers a one-tap
      // "Join call" button. Falls back to the legacy group route for calls
      // that somehow have no channel bound.
      const chanName = access.channel?.name ?? null;
      const deepUrl = channelId
        ? `/#/channels/${channelId}?call=${encodeURIComponent(groupRoomName)}`
        : `/#/call/group/${encodeURIComponent(groupRoomName)}`;
      void sendNotificationToUsers(validInvitees, {
        title: `\ud83d\udcde ${u.name} is calling` + (chanName ? ` · #${chanName}` : ""),
        body:
          kind === "video"
            ? `Group video call — ${chanName ? "#" + chanName : "channel"}`
            : `Group voice call — ${chanName ? "#" + chanName : "channel"}`,
        url: deepUrl,
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

    // Dual-ring: for every app-invitee with a saved phone, also dial their
    // cell so their phone rings alongside the app. Skip invitees already in
    // phoneInviteeRecords (caller explicitly picked 'via Phone' — handled
    // above) to avoid double-dialing the same number. Best-effort.
    if (validInvitees.length > 0 && sipConfigured()) {
      const explicitlyDialedUserIds = new Set(phoneInviteeRecords.map((r) => r.id));
      const autoDialRecords = validInvitees
        .map((id) => ({ id, user: storage.getUser(id) }))
        .filter((x) => x.user && !explicitlyDialedUserIds.has(x.id))
        .map((x) => ({
          id: x.id,
          name: x.user!.name,
          phone: (x.user as { phone?: string | null }).phone ?? null,
        }))
        .filter((r) => !!r.phone) as Array<{ id: number; name: string; phone: string }>;
      for (const rec of autoDialRecords) {
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
          }
          // Silent failure for auto-dial: the app-ring already fired, so the
          // callee will still be notified. Only warn on explicit 'via Phone'
          // failures (handled above).
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "failed";
          console.warn(`[calls] auto-dial ${rec.name} failed: ${msg}`);
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
          email: x.user!.email ?? null,
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
        // Live calls don't get reminders, so mint inline with a short TTL and
        // don't persist the token. One short URL keeps the invite to 1 segment.
        const shortToken = mintShortLink(joinUrl, { ttlMs: 4 * 60 * 60 * 1000 });
        // Consent gate: bulldog-auth decides whether SMS is allowed and which
        // phone is canonical. Fail-closed. Keyed by the invitee's email.
        const consent = await checkSmsConsent(rec.email ?? "", "live_call_invite");
        if (!consent.allowed) {
          console.log(JSON.stringify({
            msg: "sms_skipped",
            event: "live_call_invite",
            userId: rec.id,
            reason: consent.reason,
          }));
          smsResults.push({ userId: rec.id, phone: e164, ok: false, error: `consent: ${consent.reason}` });
          continue;
        }
        const smsTo = consent.phoneE164 ?? e164;
        const body = buildCallInviteSmsBody({
          callerName: u.name,
          channelLabel: channelLabelForSms,
          joinUrl,
          kind,
          shortUrl: `${baseUrl}/j/${shortToken}`,
        });
        try {
          const r = await sendSms({ to: smsTo, body });
          smsResults.push({ userId: rec.id, phone: smsTo, ok: r.ok, error: r.ok ? undefined : r.error });
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "send failed";
          smsResults.push({ userId: rec.id, phone: smsTo, ok: false, error: msg });
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
        const shortToken = mintShortLink(joinUrl, { ttlMs: 4 * 60 * 60 * 1000 });
        // External phone-only invitees have no suite identity (email), so the
        // auth consent lookup cannot resolve them — fail-closed and skip.
        const consent = await checkSmsConsent("", "live_call_invite");
        if (!consent.allowed) {
          console.log(JSON.stringify({
            msg: "sms_skipped",
            event: "live_call_invite",
            phoneOnly: true,
            reason: consent.reason,
          }));
          smsResults.push({ phone, ok: false, error: `consent: ${consent.reason}` });
          continue;
        }
        const smsTo = consent.phoneE164 ?? phone;
        const body = buildCallInviteSmsBody({
          callerName: u.name,
          channelLabel: channelLabelForSms,
          joinUrl,
          kind,
          shortUrl: `${baseUrl}/j/${shortToken}`,
        });
        try {
          const r = await sendSms({ to: smsTo, body });
          smsResults.push({ phone: smsTo, ok: r.ok, error: r.ok ? undefined : r.error });
        } catch (err) {
          const msg = (err as { message?: string })?.message ?? "send failed";
          smsResults.push({ phone: smsTo, ok: false, error: msg });
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
      meetingCode: huddleMeeting?.code ?? null,
      joinUrl: huddleMeeting ? `https://chat.bulldogops.com/m/${huddleMeeting.code}` : null,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Join an EXISTING channel group call by roomName. Used by the in-channel
  // "Join call" banner that a client shows when it lands via a push-notif
  // deep link (/#/channels/<id>?call=<room>) or when another user starts a
  // call while this user is already scrolling the channel.
  //
  // Unlike /api/calls/active/invite (which invites OTHERS), this endpoint
  // mints a LiveKit token for the CALLER themselves so they can walk into
  // the room. It's a thin, purpose-built entry point so the banner doesn't
  // have to reuse group-call/start (which would spin up a fresh room) or
  // fake a 1:1 accept flow.
  //
  // Registered via `registerGroupCallJoinRoute` (exported below) so tests
  // can mount it directly without booting the full route tree.
  // ─────────────────────────────────────────────────────────────────────────
  registerGroupCallJoinRoute(app);

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
    // Sanity-check the room name shape. We only allow rooms minted by this
    // server so a malicious client can't poke users into arbitrary rooms.
    //   - direct-<n>                       1:1 ad-hoc voice/video call
    //   - group-channel-<n>-<ts>           ad-hoc channel group call
    //   - vector-<n>-channel-<n>           legacy huddle room name
    //   - bdc-<code>                       scheduled / instant meeting room
    //                                      code is xxx-yyyy-zzz (3-4-3) from
    //                                      a 31-char alphabet, see
    //                                      server/meetings/codes.ts
    //   - sched-<n>-<ts>                   legacy scheduled-call room name
    const meetingAlpha = "a-hj-km-np-z2-9";
    const validRoomName = new RegExp(
      `^(direct-\\d+|group-channel-\\d+-\\d+|vector-\\d+-channel-\\d+|bdc-[${meetingAlpha}]{3}-[${meetingAlpha}]{4}-[${meetingAlpha}]{3}|sched-\\d+-\\d+)$`,
    );
    if (!validRoomName.test(roomName)) {
      return res.status(400).json({ message: "invalid roomName" });
    }

    const rawInvitees: unknown = req.body?.inviteeIds;
    const rawPhoneInvitees: unknown = req.body?.phoneInviteeIds;
    const rawPhones: unknown = req.body?.phoneNumbers;
    const rawEmails: unknown = req.body?.emailAddresses;
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
    const emailAddresses: string[] = Array.isArray(rawEmails)
      ? Array.from(
          new Set(
            (rawEmails as unknown[])
              .map((x) => String(x).trim().toLowerCase())
              .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
          ),
        )
      : [];
    if (
      inviteeIds.length === 0 &&
      phoneNumbers.length === 0 &&
      phoneInviteeIds.length === 0 &&
      emailAddresses.length === 0
    ) {
      return res.status(400).json({ message: "inviteeIds[], phoneInviteeIds[], phoneNumbers[], or emailAddresses[] required" });
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

    // Resolve channel context from the shared room name once, hoisted above
    // the ringing loop so downstream branches (SSE payload, add-invitee
    // push notification) can share it without recomputing. Falls back to
    // (null, null) when the room isn't channel-bound.
    const activeChanMatch = roomName.match(/(?:group-channel-|vector-\d+-channel-)(\d+)/);
    const activeChanId: number | null = activeChanMatch ? Number(activeChanMatch[1]) : null;
    const activeChanName: string | null = activeChanId
      ? (storage.getChannel(activeChanId)?.name ?? null)
      : null;

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
      // `activeChanId`/`activeChanName` are hoisted above the loop so both
      // the SSE payload and the add-invitee notification below can share
      // them.
      const payload: CallEventPayload = {
        callId: row.id, callerId: u.id, calleeId,
        callerName: u.name, callerHue: u.hue,
        kind, roomName,
        channelId: activeChanId,
        channelName: activeChanName,
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
      // Prefer the channel deep link when we can resolve one from the room
      // name; otherwise fall back to the legacy group route.
      const addUrl = activeChanId
        ? `/#/channels/${activeChanId}?call=${encodeURIComponent(roomName)}`
        : `/#/call/group/${encodeURIComponent(roomName)}`;
      void sendNotificationToUsers(validInvitees, {
        title: `\ud83d\udcde ${u.name} is calling` + (activeChanName ? ` · #${activeChanName}` : ""),
        body: kind === "video" ? `Adding you to a video call — ${channelLabel}` : `Adding you to a voice call — ${channelLabel}`,
        url: addUrl,
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

    // Email the join link to any external addresses. We don't add them to
    // the LiveKit room directly — they get a one-click web join URL.
    // We also always copy the caller (u) so they have a confirmation of who
    // they scheduled/invited — deduped case-insensitively.
    const emailedAddresses: string[] = [];
    const emailWarnings: string[] = [];
    if (emailAddresses.length > 0) {
      if (!isEmailConfigured()) {
        emailWarnings.push("Email not configured — addresses were not invited");
      } else {
        const baseUrl = (process.env.PUBLIC_BASE_URL || "https://chat.bulldogops.com").replace(/\/$/, "");
        const joinUrl = `${baseUrl}/#/call/group/${encodeURIComponent(roomName)}`;
        const subject = `${u.name} invited you to a ${kind} call`;
        const text = `${u.name} is calling you into ${channelLabel} on Bulldog Chat.\n\nJoin: ${joinUrl}\n\nThis link opens the live call directly in your browser.`;
        const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;">
  <h2 style="margin:0 0 12px 0;font-size:18px;">\ud83d\udcde ${escapeHtml(u.name)} is calling</h2>
  <p style="margin:0 0 8px 0;color:#444;">You're being invited into ${escapeHtml(channelLabel)} on Bulldog Chat.</p>
  <p style="margin:16px 0;"><a href="${joinUrl}" style="display:inline-block;padding:10px 18px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Join the call</a></p>
  <p style="margin:0;color:#888;font-size:12px;">Or paste this link into your browser: ${joinUrl}</p>
</div>`;
        // Build the full recipient list: original addresses + caller (CC-style confirmation).
        // Deduped case-insensitively so the caller doesn't get duplicate mail if
        // they typed their own address into the invite list.
        const callerEmail = (u as { email?: string }).email?.trim().toLowerCase() ?? "";
        const allRecipients: string[] = [
          ...emailAddresses,
          ...(callerEmail && !emailAddresses.includes(callerEmail) ? [callerEmail] : []),
        ];
        for (const addr of allRecipients) {
          const isCallerConfirmation = addr === callerEmail && !emailAddresses.includes(callerEmail);
          const recipientSubject = isCallerConfirmation
            ? `[Confirmation] You invited people to a ${kind} call`
            : subject;
          try {
            await sendEmail({ to: addr, subject: recipientSubject, text, html });
            emailedAddresses.push(addr);
          } catch (err) {
            const msg = (err as { message?: string })?.message ?? "failed";
            emailWarnings.push(`email ${addr}: ${msg}`);
          }
        }
      }
    }

    res.json({ roomName, invitedUserIds: validInvitees, dialedUserIds, dialedPhones, emailedAddresses, dialWarnings, emailWarnings, kind });
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
      const { buildAccessForUser } = await import("./auth");
      const sub = { userId: uid, orgId: user.orgId, res, access: buildAccessForUser(user) };
      addSubscriber(sub);
      req.on("close", () => removeSubscriber(sub));
    });
  });
}
