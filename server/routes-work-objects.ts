/* Work Objects routes — Phase 1 of the post-call-polish roadmap.
 *
 * A work_object is a domain entity (job_site, work_project, change_order,
 * safety_incident) that lives alongside chat. Channels can link to one or
 * more work_objects, and the right-rail panel surfaces them in-context.
 *
 * Routes:
 *   GET    /api/work-objects                  list (filter by kind, status, ref)
 *   POST   /api/work-objects                  create
 *   GET    /api/work-objects/:id              detail (incl. activity, channels)
 *   PATCH  /api/work-objects/:id              update (title, status, owner, attributes)
 *   POST   /api/work-objects/:id/close        close
 *   POST   /api/work-objects/:id/reopen       reopen
 *
 *   GET    /api/channels/:id/work-objects     list linked objects
 *   POST   /api/channels/:id/work-objects     link an existing object by id or ref
 *   DELETE /api/channels/:id/work-objects/:woId  unlink
 *
 *   GET    /api/work-objects/resolve/:ref     resolve a bare ref (used by /object)
 *
 * Authorization model: must be a member of the user's org for read; admin or
 * foreman can create/update/close. Channel-link mutations require the user to
 * have access to the channel via the existing userCanSeeChannel pipeline.
 */
import type { Express, Request, Response } from "express";
import { storage, sanitize } from "./storage";
import { requireAuth, requireRole, AuthedRequest } from "./auth";
import {
  workObjectCreateSchema,
  workObjectUpdateSchema,
  workObjectKinds,
  jobSiteAttributesSchema,
  workProjectAttributesSchema,
  changeOrderAttributesSchema,
  safetyIncidentAttributesSchema,
  type WorkObject,
  type WorkObjectKind,
  type WorkObjectStatus,
} from "@shared/schema";

// Per-kind attribute validators keyed by kind. Used on create + update so
// we never persist a typo'd field. .strict() in each schema means unknown
// keys are rejected.
function validateAttributesForKind(kind: WorkObjectKind, raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (raw == null) return { ok: true, value: {} };
  const schema =
    kind === "job_site" ? jobSiteAttributesSchema :
    kind === "work_project" ? workProjectAttributesSchema :
    kind === "change_order" ? changeOrderAttributesSchema :
    /* safety_incident */ safetyIncidentAttributesSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `attributes.${issue.path.join(".")}: ${issue.message}` };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}

// Hydrate a work object for the API response — parses JSON attributes,
// strips internal columns we don't want to leak, and adds derived fields.
function publicWorkObject(wo: WorkObject) {
  let attributes: Record<string, unknown> = {};
  if (wo.attributes) {
    try { attributes = JSON.parse(wo.attributes); } catch { /* ignore parse errors */ }
  }
  return {
    id: wo.id,
    kind: wo.kind,
    ref: wo.ref,
    title: wo.title,
    status: wo.status,
    description: wo.description,
    parentId: wo.parentId,
    ownerUserId: wo.ownerUserId,
    attributes,
    createdByUserId: wo.createdByUserId,
    createdAt: wo.createdAt,
    updatedAt: wo.updatedAt,
    closedAt: wo.closedAt,
  };
}

// Confirm the requested object belongs to the caller's org. Returns the
// object on success, sends a 404 + returns null otherwise.
function loadOwned(req: Request, res: Response, id: number): WorkObject | null {
  const u = (req as AuthedRequest).user;
  const wo = storage.getWorkObject(id);
  if (!wo || wo.orgId !== u.orgId) {
    res.status(404).json({ message: "Work object not found" });
    return null;
  }
  return wo;
}

export function registerWorkObjectRoutes(app: Express) {
  /* ─── list ─── */
  app.get("/api/work-objects", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const { kind, status, includeClosed, limit } = req.query;
    const opts: { kind?: WorkObjectKind; status?: WorkObjectStatus; includeClosed?: boolean; limit?: number } = {};
    if (typeof kind === "string" && (workObjectKinds as readonly string[]).includes(kind)) {
      opts.kind = kind as WorkObjectKind;
    }
    if (typeof status === "string") opts.status = status as WorkObjectStatus;
    if (includeClosed === "1" || includeClosed === "true") opts.includeClosed = true;
    if (typeof limit === "string") {
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0 && n <= 500) opts.limit = Math.floor(n);
    }
    const rows = storage.listWorkObjectsByOrg(u.orgId, opts).map(publicWorkObject);
    res.json(rows);
  });

  /* ─── create ─── */
  app.post("/api/work-objects", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const parsed = workObjectCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const input = parsed.data;
    // (org_id, kind, ref) is uniquely indexed — pre-check for a friendly 409.
    const existing = storage.getWorkObjectByRef(u.orgId, input.kind, input.ref);
    if (existing) {
      return res.status(409).json({ message: `A ${input.kind} with ref "${input.ref}" already exists`, existing: publicWorkObject(existing) });
    }
    // Validate attributes against the kind's strict schema.
    const attrCheck = validateAttributesForKind(input.kind, input.attributes ?? null);
    if (!attrCheck.ok) return res.status(400).json({ message: attrCheck.message });

    // Optional parent must be in the same org and a sensible kind.
    if (input.parentId != null) {
      const parent = storage.getWorkObject(input.parentId);
      if (!parent || parent.orgId !== u.orgId) {
        return res.status(400).json({ message: "parentId references an unknown work object" });
      }
    }

    const created = storage.createWorkObject({
      orgId: u.orgId,
      kind: input.kind,
      ref: input.ref,
      title: input.title,
      status: input.status,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      attributes: JSON.stringify(attrCheck.value),
      createdByUserId: u.id,
    });
    storage.appendWorkObjectActivity({
      workObjectId: created.id,
      type: "created",
      actorUserId: u.id,
      payload: JSON.stringify({ kind: created.kind, ref: created.ref, title: created.title }),
    });
    res.json(publicWorkObject(created));
  });

  /* ─── detail (incl. activity + linked channels) ─── */
  app.get("/api/work-objects/:id", requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const wo = loadOwned(req, res, id);
    if (!wo) return;
    const activity = storage.listWorkObjectActivity(wo.id, { limit: 50 });
    const channels = storage.listChannelsForWorkObject(wo.id);
    res.json({
      ...publicWorkObject(wo),
      activity,
      channels: channels.map(c => ({ id: c.id, name: c.name, projectId: c.projectId, type: c.type })),
    });
  });

  /* ─── update ─── */
  app.patch("/api/work-objects/:id", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const wo = loadOwned(req, res, id);
    if (!wo) return;
    const parsed = workObjectUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid input" });
    const patch = parsed.data;

    const updates: Partial<Pick<WorkObject, "title" | "status" | "description" | "ownerUserId" | "parentId" | "attributes" | "closedAt">> = {};
    const activityEvents: Array<{ type: any; payload: any }> = [];

    if (patch.title !== undefined && patch.title !== wo.title) {
      updates.title = patch.title;
      activityEvents.push({ type: "updated", payload: { field: "title", from: wo.title, to: patch.title } });
    }
    if (patch.status !== undefined && patch.status !== wo.status) {
      updates.status = patch.status;
      activityEvents.push({ type: "status_changed", payload: { from: wo.status, to: patch.status } });
      if (patch.status === "closed" && !wo.closedAt) updates.closedAt = new Date();
      if (patch.status !== "closed" && wo.closedAt) updates.closedAt = null;
    }
    if (patch.description !== undefined && patch.description !== wo.description) {
      updates.description = patch.description ?? null;
      activityEvents.push({ type: "updated", payload: { field: "description" } });
    }
    if (patch.ownerUserId !== undefined && patch.ownerUserId !== wo.ownerUserId) {
      updates.ownerUserId = patch.ownerUserId ?? null;
      activityEvents.push({ type: "owner_changed", payload: { from: wo.ownerUserId, to: patch.ownerUserId } });
    }
    if (patch.parentId !== undefined && patch.parentId !== wo.parentId) {
      if (patch.parentId != null) {
        const parent = storage.getWorkObject(patch.parentId);
        if (!parent || parent.orgId !== u.orgId) {
          return res.status(400).json({ message: "parentId references an unknown work object" });
        }
      }
      updates.parentId = patch.parentId ?? null;
      activityEvents.push({ type: "updated", payload: { field: "parent", from: wo.parentId, to: patch.parentId } });
    }
    if (patch.attributes !== undefined) {
      const attrCheck = validateAttributesForKind(wo.kind, patch.attributes);
      if (!attrCheck.ok) return res.status(400).json({ message: attrCheck.message });
      updates.attributes = JSON.stringify(attrCheck.value);
      activityEvents.push({ type: "updated", payload: { field: "attributes" } });
    }

    const updated = storage.updateWorkObject(wo.id, updates) ?? wo;
    for (const ev of activityEvents) {
      storage.appendWorkObjectActivity({
        workObjectId: wo.id,
        type: ev.type,
        actorUserId: u.id,
        payload: JSON.stringify(ev.payload),
      });
    }
    res.json(publicWorkObject(updated));
  });

  /* ─── close / reopen ─── */
  app.post("/api/work-objects/:id/close", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const wo = loadOwned(req, res, id);
    if (!wo) return;
    if (wo.status === "closed") return res.json(publicWorkObject(wo));
    const updated = storage.updateWorkObject(wo.id, { status: "closed", closedAt: new Date() });
    storage.appendWorkObjectActivity({
      workObjectId: wo.id,
      type: "closed",
      actorUserId: u.id,
      payload: JSON.stringify({ from: wo.status }),
    });
    res.json(publicWorkObject(updated ?? wo));
  });

  app.post("/api/work-objects/:id/reopen", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const id = Number(req.params.id);
    const wo = loadOwned(req, res, id);
    if (!wo) return;
    if (wo.status !== "closed") return res.json(publicWorkObject(wo));
    const updated = storage.updateWorkObject(wo.id, { status: "active", closedAt: null });
    storage.appendWorkObjectActivity({
      workObjectId: wo.id,
      type: "reopened",
      actorUserId: u.id,
      payload: null,
    });
    res.json(publicWorkObject(updated ?? wo));
  });

  /* ─── resolve a bare ref (used by /object slash command) ─── */
  app.get("/api/work-objects/resolve/:ref", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const ref = req.params.ref;
    const wo = storage.findWorkObjectByRefAcrossKinds(u.orgId, ref);
    if (!wo) return res.status(404).json({ message: `No work object with ref "${ref}"` });
    res.json(publicWorkObject(wo));
  });

  /* ─── channel ↔ work object links ─── */

  // List linked objects on a channel. Used by the right-rail panel.
  app.get("/api/channels/:id/work-objects", requireAuth, (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const project = storage.getProject(channel.projectId);
    if (!project || project.orgId !== u.orgId) return res.status(404).json({ message: "Channel not found" });
    if (!storage.isProjectMember(project.id, u.id)) return res.status(403).json({ message: "Not a project member" });
    const user = storage.getUser(u.id);
    if (!user || !storage.userCanSeeChannel(channel, user)) return res.status(403).json({ message: "Not allowed" });

    const objects = storage.listWorkObjectsForChannel(channelId);
    res.json(objects.map(publicWorkObject));
  });

  // Link an existing work object to a channel. Accepts either { workObjectId }
  // or { ref } in the body. ref-based linking is what /object uses.
  app.post("/api/channels/:id/work-objects", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const project = storage.getProject(channel.projectId);
    if (!project || project.orgId !== u.orgId) return res.status(404).json({ message: "Channel not found" });
    if (!storage.isProjectMember(project.id, u.id)) return res.status(403).json({ message: "Not a project member" });

    const { workObjectId, ref, linkType } = (req.body ?? {}) as { workObjectId?: number; ref?: string; linkType?: "primary" | "secondary" };
    let wo: WorkObject | undefined;
    if (typeof workObjectId === "number") {
      wo = storage.getWorkObject(workObjectId);
    } else if (typeof ref === "string" && ref.length > 0) {
      wo = storage.findWorkObjectByRefAcrossKinds(u.orgId, ref);
    } else {
      return res.status(400).json({ message: "Provide workObjectId or ref" });
    }
    if (!wo || wo.orgId !== u.orgId) return res.status(404).json({ message: "Work object not found" });

    storage.linkWorkObjectToChannel({
      workObjectId: wo.id,
      channelId,
      linkType: linkType ?? "primary",
      linkedByUserId: u.id,
    });
    storage.appendWorkObjectActivity({
      workObjectId: wo.id,
      type: "linked",
      actorUserId: u.id,
      payload: JSON.stringify({ channelId, channelName: channel.name }),
    });
    res.json(publicWorkObject(wo));
  });

  app.delete("/api/channels/:id/work-objects/:woId", requireAuth, requireRole(["admin", "foreman"]), (req, res) => {
    const u = (req as AuthedRequest).user;
    const channelId = Number(req.params.id);
    const woId = Number(req.params.woId);
    const channel = storage.getChannel(channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const project = storage.getProject(channel.projectId);
    if (!project || project.orgId !== u.orgId) return res.status(404).json({ message: "Channel not found" });
    const wo = storage.getWorkObject(woId);
    if (!wo || wo.orgId !== u.orgId) return res.status(404).json({ message: "Work object not found" });
    storage.unlinkWorkObjectFromChannel(woId, channelId);
    storage.appendWorkObjectActivity({
      workObjectId: woId,
      type: "unlinked",
      actorUserId: u.id,
      payload: JSON.stringify({ channelId, channelName: channel.name }),
    });
    res.json({ ok: true });
  });
}
