// v2 routes: attachments, search, threads, admin, recording, expo push, mentions.
// Mounted from registerRoutes alongside the v1 routes.

import type { Express, Request, Response } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { storage, sanitize } from "./storage";
import { getStorageBackend } from "./storage-files";
import { hashPassword, requireAuth, requireRole, requireCap, AuthedRequest } from "./auth";
import { can } from "@shared/permissions";
import { rawDb } from "./db";
import type { WireMessage } from "./events";
import { emitMessageNew } from "./events";
import { startRoomRecording, stopRecording, recordingStorageConfigured } from "./recording";
import { livekitConfigured } from "./livekit";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
});

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "file";
}

function fmtAttachment(att: ReturnType<typeof storage.getAttachment>) {
  if (!att) return null;
  const backend = getStorageBackend();
  const publicUrl = backend.publicUrl(att.storageKey);
  const thumbPublic = att.thumbnailKey ? backend.publicUrl(att.thumbnailKey) : null;
  return {
    id: att.id,
    filename: att.filename,
    contentType: att.contentType,
    sizeBytes: att.sizeBytes,
    url: publicUrl ?? `/api/files/${att.id}`,
    thumbnailUrl: thumbPublic ?? (att.thumbnailKey ? `/api/files/${att.id}?thumb=1` : null),
    createdAt: att.createdAt,
  };
}

// Parse mentions out of message content.
export function parseMentions(content: string, projectMembers: Array<{ id: number; name: string }>) {
  const mentions: Array<{ userId: number | null; type: "user" | "everyone" | "here" }> = [];
  const seenUsers = new Set<number>();
  let hasEveryone = false, hasHere = false;

  const tokens = Array.from(content.matchAll(/@([a-zA-Z0-9_.-]+)/g));
  for (const m of tokens) {
    const raw = m[1].toLowerCase();
    if (raw === "everyone" && !hasEveryone) { mentions.push({ userId: null, type: "everyone" }); hasEveryone = true; continue; }
    if (raw === "here" && !hasHere) { mentions.push({ userId: null, type: "here" }); hasHere = true; continue; }
    for (const u of projectMembers) {
      const firstName = u.name.toLowerCase().split(/\s+/)[0];
      const full = u.name.toLowerCase().replace(/\s+/g, "");
      if (firstName === raw || full === raw) {
        if (!seenUsers.has(u.id)) { mentions.push({ userId: u.id, type: "user" }); seenUsers.add(u.id); }
        break;
      }
    }
  }
  return mentions;
}

export function registerV2Routes(app: Express) {
  // ─────────── UPLOADS ───────────
  app.post("/api/uploads", requireAuth, upload.array("files", 4), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) return res.status(400).json({ message: "No files" });
    const backend = getStorageBackend();
    const out: any[] = [];
    for (const f of files) {
      const id = nanoid(16);
      const safeName = sanitizeFilename(f.originalname);
      const storageKey = `attachments/${u.orgId}/${id}-${safeName}`;
      await backend.upload(f.buffer, storageKey, f.mimetype);

      let thumbnailKey: string | null = null;
      if (f.mimetype.startsWith("image/")) {
        try {
          const thumbBuf = await sharp(f.buffer).rotate().resize(400, 400, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
          thumbnailKey = `attachments/${u.orgId}/thumbs/${id}.webp`;
          await backend.upload(thumbBuf, thumbnailKey, "image/webp");
        } catch (err) {
          console.warn("[uploads] thumbnail generation failed:", err);
        }
      }

      const att = storage.createAttachment({
        id,
        uploaderUserId: u.id,
        filename: f.originalname,
        contentType: f.mimetype,
        sizeBytes: f.size,
        storageKey,
        thumbnailKey,
      });
      out.push(fmtAttachment(att));
    }
    res.json(out);
  });

  // GET /api/files/:id — auth + access check; redirect to signed URL or stream
  app.get("/api/files/:id", requireAuth, async (req: Request, res: Response) => {
    const u = (req as AuthedRequest).user;
    const id = req.params.id;
    const wantThumb = String(req.query.thumb ?? "") === "1";
    const att = storage.getAttachment(id);
    if (!att) return res.status(404).json({ message: "Not found" });

    // Access: uploader OR (file referenced by a message in a channel the user can access)
    let allowed = att.uploaderUserId === u.id;
    if (!allowed && att.messageId) {
      const msg = storage.getMessage(att.messageId);
      if (msg) {
        const ch = storage.getChannel(msg.channelId);
        if (ch) {
          const proj = storage.getProject(ch.projectId);
          if (proj && proj.orgId === u.orgId && storage.isProjectMember(proj.id, u.id)) allowed = true;
        }
      }
    }
    if (!allowed) return res.status(403).json({ message: "Forbidden" });

    const key = wantThumb && att.thumbnailKey ? att.thumbnailKey : att.storageKey;
    const backend = getStorageBackend();
    res.setHeader("Content-Type", wantThumb ? "image/webp" : att.contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (!wantThumb) res.setHeader("Content-Disposition", `inline; filename="${att.filename.replace(/"/g, "")}"`);
    const ok = await backend.streamTo(key, res);
    if (!ok && !res.headersSent) res.status(404).json({ message: "Storage object missing" });
  });

  app.delete("/api/messages/:id/attachments/:attId", requireAuth, async (req, res) => {
    const u = (req as AuthedRequest).user;
    const att = storage.getAttachment(req.params.attId);
    if (!att) return res.status(404).json({ message: "Not found" });
    const msg = att.messageId ? storage.getMessage(att.messageId) : null;
    if (msg && msg.userId !== u.id && u.role !== "admin") return res.status(403).json({ message: "Forbidden" });
    const backend = getStorageBackend();
    try { await backend.delete(att.storageKey); } catch {}
    if (att.thumbnailKey) try { await backend.delete(att.thumbnailKey); } catch {}
    storage.deleteAttachment(att.id);
    res.json({ ok: true });
  });

  // ─────────── THREADS ───────────
  app.get("/api/messages/:id/replies", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const parent = storage.getMessage(id);
    if (!parent) return res.status(404).json({ message: "Not found" });
    const ch = storage.getChannel(parent.channelId);
    if (!ch) return res.status(404).json({ message: "Not found" });
    const proj = storage.getProject(ch.projectId);
    if (!proj || proj.orgId !== u.orgId || !storage.isProjectMember(proj.id, u.id)) {
      return res.status(404).json({ message: "Not found" });
    }
    const replies = storage.listReplies(id);
    const ids = replies.map(m => m.id);
    const rxns = storage.listReactions(ids);
    const groupedR = new Map<number, Map<string, { emoji: string; count: number; userIds: number[] }>>();
    for (const r of rxns) {
      if (!groupedR.has(r.messageId)) groupedR.set(r.messageId, new Map());
      const g = groupedR.get(r.messageId)!;
      const it = g.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [] };
      it.count++; it.userIds.push(r.userId);
      g.set(r.emoji, it);
    }
    const atts = storage.listAttachmentsForMessages(ids);
    const attsByMsg = new Map<number, any[]>();
    for (const a of atts) {
      const list = attsByMsg.get(a.messageId!) ?? [];
      list.push(fmtAttachment(a));
      attsByMsg.set(a.messageId!, list);
    }
    const wire = replies.map(m => {
      const author = storage.getUser(m.userId);
      const initials = author ? author.name.split(/\s+/).slice(0, 2).map(s => s[0] ?? "").join("").toUpperCase() : "?";
      return {
        ...m,
        authorName: author?.name ?? "Unknown",
        authorHue: author?.hue ?? 220,
        authorRole: author?.role ?? "field",
        authorInitials: initials,
        reactions: Array.from(groupedR.get(m.id)?.values() ?? []),
        attachmentsList: attsByMsg.get(m.id) ?? [],
      };
    });
    res.json(wire);
  });

  // ─────────── SEARCH ───────────
  app.get("/api/search", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json({ results: [] });
    const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
    const userId = req.query.user_id ? Number(req.query.user_id) : undefined;
    const fromDate = req.query.from_date ? new Date(String(req.query.from_date)) : undefined;
    const toDate = req.query.to_date ? new Date(String(req.query.to_date)) : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;

    // Channels user can access (from project memberships)
    const accessibleProjects = storage.listProjectsForUser(u.id);
    const allChannels: number[] = [];
    for (const p of accessibleProjects) {
      const chs = storage.listChannelsByProject(p.id);
      for (const c of chs) {
        if (c.type === "text") allChannels.push(c.id);
      }
    }
    let chIds = allChannels;
    if (channelId) {
      if (!allChannels.includes(channelId)) return res.json({ results: [] });
      chIds = [channelId];
    }

    const results = storage.searchMessages({ q, channelIds: chIds, userId, fromDate, toDate, limit });
    // Enrich with channel + author
    const out = results.map(m => {
      const ch = storage.getChannel(m.channelId);
      const proj = ch ? storage.getProject(ch.projectId) : null;
      const author = storage.getUser(m.userId);
      return {
        id: m.id,
        channelId: m.channelId,
        channelName: ch?.name ?? null,
        projectId: proj?.id ?? null,
        projectName: proj?.name ?? null,
        userId: m.userId,
        authorName: author?.name ?? "Unknown",
        content: m.content,
        createdAt: m.createdAt,
      };
    });
    res.json({ results: out });
  });

  // ─────────── ADMIN ───────────
  app.get("/api/admin/users", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    res.json(storage.listUsersByOrg(u.orgId).map(sanitize));
  });

  app.patch("/api/admin/users/:id", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const target = storage.getUser(id);
    if (!target || target.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    const patch: any = {};
    if (req.body?.role && ["user","manager","admin"].includes(req.body.role)) patch.role = req.body.role;
    if (req.body?.name) patch.name = String(req.body.name).slice(0, 80);
    if (req.body?.title !== undefined) patch.title = req.body.title ? String(req.body.title).slice(0, 80) : null;
    if (req.body?.status) patch.status = String(req.body.status);
    const updated = storage.updateUser(id, patch);
    if (typeof req.body?.deactivated === "boolean") {
      storage.setUserDeactivated(id, req.body.deactivated);
      if (req.body.deactivated) storage.deleteAllSessionsForUser(id);
    }
    res.json(sanitize(updated ?? target));
  });

  app.post("/api/admin/users/:id/reset-password", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const target = storage.getUser(id);
    if (!target || target.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    const tempPassword = `tmp-${nanoid(10)}`;
    storage.resetUserPassword(id, hashPassword(tempPassword));
    storage.deleteAllSessionsForUser(id);
    res.json({ tempPassword });
  });

  app.post("/api/admin/users/:id/force-logout", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const target = storage.getUser(id);
    if (!target || target.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    storage.deleteAllSessionsForUser(id);
    res.json({ ok: true });
  });

  app.delete("/api/admin/users/:id", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const target = storage.getUser(id);
    if (!target || target.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    if (target.id === u.id) return res.status(400).json({ message: "Cannot delete yourself" });
    storage.deleteUserCascade(id);
    res.json({ ok: true });
  });

  app.get("/api/admin/projects", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const projects = storage.listProjectsByOrg(u.orgId);
    res.json(projects.map(p => ({
      ...p,
      memberCount: storage.countMembersForProject(p.id),
      channelCount: storage.countChannelsForProject(p.id),
    })));
  });

  app.patch("/api/admin/projects/:id", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const p = storage.getProject(id);
    if (!p || p.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    const patch: any = {};
    if (req.body?.name) patch.name = String(req.body.name).slice(0, 120);
    if (req.body?.description !== undefined) patch.description = req.body.description ? String(req.body.description).slice(0, 500) : null;
    if (req.body?.short) patch.short = String(req.body.short).slice(0, 8);
    if (typeof req.body?.hue === "number") patch.hue = req.body.hue;
    const updated = storage.updateProject(id, patch);
    res.json(updated);
  });

  app.delete("/api/admin/projects/:id", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const p = storage.getProject(id);
    if (!p || p.orgId !== u.orgId) return res.status(404).json({ message: "Not found" });
    storage.deleteProjectCascade(id);
    res.json({ ok: true });
  });

  app.get("/api/admin/invites", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const list = storage.listInvitesByOrg(u.orgId);
    const proto = (req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http")) as string;
    const host = (req.headers["x-forwarded-host"] || req.headers.host) as string;
    res.json(list.map(i => ({ ...i, url: `${proto}://${host}/#/accept-invite/${i.token}` })));
  });

  app.delete("/api/admin/invites/:id", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const all = storage.listInvitesByOrg(u.orgId);
    if (!all.find(i => i.id === id)) return res.status(404).json({ message: "Not found" });
    storage.deleteInvite(id);
    res.json({ ok: true });
  });

  // Phase 1.9.2 — admin-issued invites that mint local users are disabled.
  // All user provisioning happens on auth.bulldogops.com so role assignment
  // can't be forged via a stolen invite link.
  app.post("/api/admin/invites", requireAuth, requireRole(["admin"]), (_req, res) => {
    return res.status(410).json({
      message: "Admin invites are disabled. Add users on auth.bulldogops.com instead.",
      redirect: "https://auth.bulldogops.com/",
      code: "admin_invites_disabled",
    });
  });

  app.get("/api/admin/org", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    res.json(storage.getOrg(u.orgId));
  });

  app.patch("/api/admin/org", requireAuth, requireRole(["admin"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const patch: any = {};
    if (req.body?.name) patch.name = String(req.body.name).slice(0, 120);
    if (req.body?.plan) patch.plan = String(req.body.plan).slice(0, 32);
    const updated = storage.updateOrg(u.orgId, patch);
    res.json(updated);
  });

  // ─────────── EXPO PUSH ───────────
  app.post("/api/push/expo-subscribe", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const token = String(req.body?.token ?? "");
    if (!token) return res.status(400).json({ message: "Missing token" });
    const sub = storage.upsertExpoPushToken({ userId: u.id, token, deviceLabel: req.body?.device_label ?? null });
    res.json(sub);
  });

  // ─────────── RECORDING ───────────
  app.post("/api/channels/:id/recording/start", requireAuth, requireCap(can.chat.createChannel), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const ch = storage.getChannel(channelId);
    if (!ch) return res.status(404).json({ message: "Not found" });
    const proj = storage.getProject(ch.projectId);
    if (!proj || proj.orgId !== u.orgId || !storage.isProjectMember(proj.id, u.id)) {
      return res.status(404).json({ message: "Not found" });
    }
    if (ch.type !== "voice") return res.status(400).json({ message: "Not a voice channel" });
    const roomName = `vector-${u.orgId}-channel-${channelId}`;
    const result = await startRoomRecording({
      channelId, channelName: ch.name, startedByUserId: u.id, roomName,
    });
    res.json({
      recording: result.recording,
      started: result.started,
      reason: (result as any).reason ?? null,
      requirements: {
        livekit: livekitConfigured(),
        storage: recordingStorageConfigured(),
      },
    });
  });

  app.post("/api/channels/:id/recording/stop", requireAuth, requireCap(can.chat.createChannel), async (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const ch = storage.getChannel(channelId);
    if (!ch) return res.status(404).json({ message: "Not found" });
    const active = storage.getActiveRecordingForChannel(channelId);
    if (!active) return res.status(404).json({ message: "No active recording" });
    const updated = await stopRecording(active.id);
    res.json(updated);
  });

  app.get("/api/channels/:id/recordings", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const ch = storage.getChannel(channelId);
    if (!ch) return res.status(404).json({ message: "Not found" });
    const proj = storage.getProject(ch.projectId);
    if (!proj || proj.orgId !== u.orgId || !storage.isProjectMember(proj.id, u.id)) {
      return res.status(404).json({ message: "Not found" });
    }
    res.json(storage.listRecordingsForChannel(channelId));
  });

  // LiveKit webhook — receives egress completion + participant lifecycle
  // events. We use the participant_* events to surface SIP dial-out failure
  // reasons in our own logs (LiveKit forwards the SIP cause code / hangup
  // reason from Twilio when a phone call drops or rejects).
  app.post("/api/livekit/webhook", async (req, res) => {
    try {
      const event = req.body;

      // ── Egress (recording) finished ──
      const egressInfo = event?.egressInfo || event?.egress_info;
      if (event?.event === "egress_ended" && egressInfo?.egressId) {
        const rec = storage.findRecordingByEgressId(egressInfo.egressId);
        if (rec) {
          const fileInfo = egressInfo?.file ?? egressInfo?.fileResults?.[0];
          const url = fileInfo?.location ?? fileInfo?.filename ?? null;
          const size = Number(fileInfo?.size ?? 0) || null;
          const duration = Number(egressInfo?.duration ?? 0) / 1e9; // ns -> s
          storage.updateRecording(rec.id, {
            status: egressInfo?.status === "EGRESS_FAILED" ? "failed" : "ready",
            storageUrl: url,
            fileSizeBytes: size,
            durationSeconds: Math.floor(duration) || null,
            endedAt: new Date(),
          });
        }
      }

      // ── SIP participant lifecycle ──
      // Our SIP dial-outs register with identity "sip_<digits>_<ts>" — we
      // log connect / disconnect events for those so failed phone calls
      // leave a readable trail (current state: a successful createSipParticipant
      // can still hang up immediately if Twilio rejects, and we'd never know).
      const part = event?.participant;
      const identity: string | undefined = part?.identity;
      if (identity && identity.startsWith("sip_")) {
        const room: string = event?.room?.name ?? "(unknown)";
        if (event?.event === "participant_joined") {
          console.log(`[sip] participant_joined ${identity} room=${room}`);
        } else if (event?.event === "participant_disconnected") {
          // disconnectReason is an enum; LiveKit also passes through a
          // human-readable string in some builds.
          const reason = part?.disconnectReason ?? part?.disconnect_reason ?? "(no reason)";
          console.warn(`[sip] participant_disconnected ${identity} room=${room} reason=${reason}`);
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.warn("[livekit webhook] error:", err);
      res.status(200).json({ ok: false });
    }
  });
}
