// Cross-suite integration endpoints.
//
// These are NOT user-authenticated — they're called by other Bulldog suite
// apps (contracts, ops) over a shared secret (SUITE_INTERNAL_SECRET). The
// caller must include the secret in the `x-suite-secret` header. Same
// pattern that bulldog-auth uses for inter-app web-push fan-out.
//
// Phase 1.9 ships two bridges:
//   POST /api/integrations/contracts/create-meeting
//     body: { contractRef, contractTitle, contractUrl?, orgId? }
//     creates: a job (work_object kind=contract, ref=CONTRACT-<contractRef>)
//              + a channel nested under it, named for the contract ref.
//     returns: { jobId, channelId, deepLink: "/?channel=<id>" }
//
//   POST /api/integrations/contracts/create-channel  (Phase 1.9.3)
//     body: { orgId?, projectId, attachedByUserId, channelName?, scope,
//             memberIds?, linkedContract: { contractId, title, ref, appUrl, pdfUrl } }
//     creates: a channel with the linkedContract metadata cached + posts a
//              system message announcing the attachment. NOT idempotent —
//              always creates a new channel (one channel per attach).
//     returns: { channelId, projectId, deepLink }
//
// The deepLink points at chat.bulldogops.com — the caller prepends its own
// host or uses it as-is depending on context. Idempotent: if a job with
// the same ref already exists, we reuse it (and find/create one channel).
import type { Express } from "express";
import { storage } from "./storage";

const DEFAULT_ORG_ID = 1; // single-org install (see bulldog-sso.ts)

function requireSuiteSecret(req: import("express").Request, res: import("express").Response): boolean {
  const expected = process.env.SUITE_INTERNAL_SECRET;
  if (!expected) {
    res.status(503).json({ message: "SUITE_INTERNAL_SECRET not configured" });
    return false;
  }
  const given = req.header("x-suite-secret");
  if (!given || given !== expected) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

function sanitizeRefSegment(input: string): string {
  // Keep alphanumerics, dash, underscore. Collapse whitespace to dash.
  return input.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 60);
}

function sanitizeChannelName(input: string): string {
  // Channel names: lowercase, alphanumerics + dashes, 80 chars max.
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "contract-meeting";
}

// Phase 1.9.3 — restricted channel scopes allowed via the bridge. Mirrors
// shared/schema.ts channelScopes but excludes "private" handling differs.
const ALLOWED_BRIDGE_SCOPES = new Set(["global", "private"]);

export function registerIntegrationRoutes(app: Express) {
  // Bulldog Contracts → Chat bridge.
  //
  // Idempotent: given the same contractRef twice, returns the same
  // jobId/channelId. The caller (contracts UI) is expected to deep-link
  // its user into the returned channel.
  app.post("/api/integrations/contracts/create-meeting", (req, res) => {
    if (!requireSuiteSecret(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const contractRef = typeof body.contractRef === "string" ? body.contractRef.trim() : "";
    const contractTitle = typeof body.contractTitle === "string" ? body.contractTitle.trim() : "";
    const contractUrl = typeof body.contractUrl === "string" ? body.contractUrl.trim() : "";
    const orgId = Number.isFinite(Number(body.orgId)) && Number(body.orgId) > 0
      ? Number(body.orgId)
      : DEFAULT_ORG_ID;

    if (!contractRef) return res.status(400).json({ message: "contractRef required" });
    if (!contractTitle) return res.status(400).json({ message: "contractTitle required" });

    const refSafe = sanitizeRefSegment(contractRef);
    if (!refSafe) return res.status(400).json({ message: "contractRef has no usable characters" });
    const jobRef = `CONTRACT-${refSafe}`;

    // Optional: pin to a single company for the org. With single-org +
    // multiple companies (projects), we attach the contract job to the
    // first project under the org. Future: contracts can pass `projectId`.
    let projectId: number | null = null;
    const pidRaw = body.projectId;
    if (pidRaw !== undefined && pidRaw !== null && pidRaw !== "") {
      const pid = Number(pidRaw);
      if (Number.isFinite(pid) && pid > 0) {
        const proj = storage.getProject(pid);
        if (proj && proj.orgId === orgId) projectId = pid;
      }
    }
    if (projectId === null) {
      const projects = storage.listProjectsByOrg(orgId);
      if (projects.length > 0) projectId = projects[0].id;
    }
    if (projectId === null) {
      return res.status(400).json({ message: "No company found for this org" });
    }

    // Resolve a `createdByUserId` — the schema requires NOT NULL. Pick the
    // first admin in the org; fall back to the first user. This row is the
    // "who created this from contracts" attribution — not the meeting owner.
    const orgUsers = storage.listUsersByOrg(orgId);
    if (orgUsers.length === 0) {
      return res.status(400).json({ message: "No users found for this org" });
    }
    const attributedAdmin = orgUsers.find(u => u.role === "admin") ?? orgUsers[0];
    const attributedUserId = attributedAdmin.id;

    // 1. Find or create the job (work_object).
    //    `workObjectKinds` in shared/schema.ts is currently:
    //      job_site | work_project | change_order | safety_incident
    //    A contract-driven kickoff is a project of work, so we use
    //    "work_project" and record the contractRef/contractUrl on
    //    `attributes` for traceability.
    const JOB_KIND = "work_project" as const;
    let job = storage.getWorkObjectByRef(orgId, JOB_KIND, jobRef);
    if (!job) {
      job = storage.createWorkObject({
        orgId,
        projectId,
        kind: JOB_KIND,
        ref: jobRef,
        title: contractTitle.slice(0, 200),
        status: "open",
        description: contractUrl ? `Source contract: ${contractUrl}` : `Source contract ref: ${contractRef}`,
        parentId: null,
        ownerUserId: null,
        attributes: JSON.stringify({
          contractRef,
          contractUrl: contractUrl || null,
          source: "contracts-bridge",
        }),
        createdByUserId: attributedUserId,
      });
      storage.appendWorkObjectActivity({
        workObjectId: job.id,
        type: "created",
        actorUserId: attributedUserId,
        payload: JSON.stringify({ source: "contracts-bridge", contractRef, contractUrl }),
      });
    }

    // 2. Find or create a channel under that job. Channel name is derived
    //    from the contract ref. We dedupe by (projectId, workObjectId).
    const existingChannels = storage.listChannelsForWorkObject(job.id);
    let channel = existingChannels.find(c => c.projectId === projectId) ?? null;
    if (!channel) {
      // Channel name: prefer the human-readable contract title so Josh can
      // tell what contract a channel belongs to at a glance. Fall back to
      // the ref if the title slugifies to empty.
      const titleSlug = sanitizeChannelName(contractTitle);
      const channelName = titleSlug && titleSlug !== "contract-meeting"
        ? titleSlug
        : sanitizeChannelName(`contract-${refSafe}`);
      const allInProject = storage.listChannelsByProject(projectId);
      channel = storage.createChannel({
        projectId,
        workObjectId: job.id,
        position: allInProject.length,
        name: channelName,
        // Unified channels (Phase 1.9): every channel does text + voice.
        // We seed as "text" — the UI exposes a Start Call button on every
        // channel regardless of stored type.
        type: "text",
        topic: `Contract: ${contractTitle.slice(0, 400)}`,
        scope: "global",
        entityId: null,
        teamRole: null,
      });
    }

    res.json({
      ok: true,
      jobId: job.id,
      jobRef: job.ref,
      channelId: channel.id,
      channelName: channel.name,
      projectId,
      deepLink: `/?channel=${channel.id}`,
    });
  });

  // Phase 1.9.3 — Bulldog Contracts → Chat "create channel with contract attached".
  //
  // This is the rich-attach flow: the contracts UI lets Josh pick the
  // company, channel name, scope (global/private), members, and which
  // contract to attach. The contracts server forwards all of that here
  // along with the verified attachedByUserId (the contracts user's id —
  // it's the same id in the chat DB since both apps shadow-provision
  // through bulldog-auth).
  app.post("/api/integrations/contracts/create-channel", (req, res) => {
    if (!requireSuiteSecret(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const orgId = Number.isFinite(Number(body.orgId)) && Number(body.orgId) > 0
      ? Number(body.orgId)
      : DEFAULT_ORG_ID;
    const projectId = Number(body.projectId);
    const attachedByUserId = Number(body.attachedByUserId);
    const scopeRaw = typeof body.scope === "string" ? body.scope : "global";
    const scope = ALLOWED_BRIDGE_SCOPES.has(scopeRaw) ? scopeRaw : "global";
    const memberIds = Array.isArray(body.memberIds)
      ? (body.memberIds as unknown[]).map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0)
      : [];
    const channelNameOverride = typeof body.channelName === "string" ? body.channelName.trim() : "";
    const lc = body.linkedContract as Record<string, unknown> | undefined;

    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "projectId required" });
    }
    if (!Number.isFinite(attachedByUserId) || attachedByUserId <= 0) {
      return res.status(400).json({ message: "attachedByUserId required" });
    }
    if (!lc || typeof lc !== "object") {
      return res.status(400).json({ message: "linkedContract required" });
    }
    const contractId = Number(lc.contractId);
    const title = typeof lc.title === "string" ? lc.title.trim() : "";
    const appUrl = typeof lc.appUrl === "string" ? lc.appUrl.trim() : "";
    const ref = typeof lc.ref === "string" ? lc.ref.trim() : null;
    const pdfUrl = typeof lc.pdfUrl === "string" ? lc.pdfUrl.trim() : null;
    if (!Number.isFinite(contractId) || contractId <= 0) {
      return res.status(400).json({ message: "linkedContract.contractId required" });
    }
    if (!title) return res.status(400).json({ message: "linkedContract.title required" });
    if (!appUrl) return res.status(400).json({ message: "linkedContract.appUrl required" });

    // Validate project belongs to org.
    const project = storage.getProject(projectId);
    if (!project || project.orgId !== orgId) {
      return res.status(400).json({ message: "projectId does not belong to org" });
    }

    // Validate attaching user exists in the org. SSO shadow-provision keeps
    // ids in sync between auth/contracts/chat, but defence-in-depth.
    const attacher = storage.getUser(attachedByUserId);
    if (!attacher || attacher.orgId !== orgId) {
      return res.status(400).json({ message: "attachedByUserId not in org" });
    }

    // Build the linkedContract meta blob with the server-side audit fields.
    const meta = {
      contractId,
      title: title.slice(0, 200),
      ref: ref || null,
      appUrl: appUrl.slice(0, 500),
      pdfUrl: pdfUrl || null,
      attachedByUserId,
      attachedAt: Date.now(),
    };

    // Channel name: caller-provided or derived from contract title.
    const nameCandidate = channelNameOverride || title;
    const channelName = sanitizeChannelName(nameCandidate);

    const existing = storage.listChannelsByProject(projectId);
    const channel = storage.createChannel({
      projectId,
      workObjectId: null,
      position: existing.length,
      name: channelName,
      type: "text",
      topic: `Contract: ${title.slice(0, 400)}`,
      scope: scope as any,
      entityId: null,
      teamRole: null,
      linkedContract: meta,
    } as any);

    // Seed private membership when scope=private. Always include the
    // attacher so they don't lock themselves out.
    if (scope === "private") {
      const ids = new Set<number>(memberIds);
      ids.add(attachedByUserId);
      const orgUserIds = new Set(storage.listUsersByOrg(orgId).map(u => u.id));
      const filtered = Array.from(ids).filter(id => orgUserIds.has(id));
      storage.addChannelMembers(channel.id, filtered);
    }

    // System message announcing the attach.
    try {
      storage.createMessage({
        channelId: channel.id,
        userId: attachedByUserId,
        content: `📄 Contract attached: ${meta.title}`,
        meta: JSON.stringify({
          system: true,
          kind: "contract_attached",
          contractId: meta.contractId,
          title: meta.title,
          ref: meta.ref,
          appUrl: meta.appUrl,
          pdfUrl: meta.pdfUrl,
        }),
      });
    } catch (e) {
      console.warn("[bridge create-channel] system message skipped:", (e as Error).message);
    }

    res.json({
      ok: true,
      channelId: channel.id,
      channelName: channel.name,
      projectId,
      deepLink: `/?channel=${channel.id}`,
    });
  });
}
