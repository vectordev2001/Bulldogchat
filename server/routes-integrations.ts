// Cross-suite integration endpoints.
//
// These are NOT user-authenticated — they're called by other Bulldog suite
// apps (contracts, ops) over a shared secret (SUITE_INTERNAL_SECRET). The
// caller must include the secret in the `x-suite-secret` header. Same
// pattern that bulldog-auth uses for inter-app web-push fan-out.
//
// Phase 1.9 ships exactly one bridge:
//   POST /api/integrations/contracts/create-meeting
//     body: { contractRef, contractTitle, contractUrl?, orgId? }
//     creates: a job (work_object kind=contract, ref=CONTRACT-<contractRef>)
//              + a channel nested under it, named for the contract ref.
//     returns: { jobId, channelId, deepLink: "/?channel=<id>" }
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
      const channelName = sanitizeChannelName(`contract-${refSafe}`);
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
}
