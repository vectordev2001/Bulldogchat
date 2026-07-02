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
    // Phase 1.9.3+: prefer email-based attacher resolution — numeric ids are
    // NOT consistent across the contracts and chat DBs (each app holds its
    // own primary keys). Email is the only stable cross-app handle.
    const attachedByEmail = typeof body.attachedByEmail === "string"
      ? body.attachedByEmail.trim().toLowerCase()
      : "";
    const attachedByName = typeof body.attachedByName === "string"
      ? body.attachedByName.trim()
      : "";
    const attachedByUserIdRaw = Number(body.attachedByUserId);
    const scopeRaw = typeof body.scope === "string" ? body.scope : "global";
    const scope = ALLOWED_BRIDGE_SCOPES.has(scopeRaw) ? scopeRaw : "global";
    const memberIds = Array.isArray(body.memberIds)
      ? (body.memberIds as unknown[]).map(n => Number(n)).filter(n => Number.isFinite(n) && n > 0)
      : [];
    // Phase 1.9.3+ — the contracts UI picks members by email (canonical roster
    // lives in bulldog-auth). Any email that doesn't yet have a chat row gets
    // shadow-provisioned here, mirroring bulldog-sso's first-login behaviour.
    const memberEmails = Array.isArray(body.memberEmails)
      ? (body.memberEmails as unknown[])
          .map(e => (typeof e === "string" ? e.trim().toLowerCase() : ""))
          .filter(e => e.length > 0 && e.includes("@"))
      : [];
    const channelNameOverride = typeof body.channelName === "string" ? body.channelName.trim() : "";
    const lc = body.linkedContract as Record<string, unknown> | undefined;

    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ message: "projectId required" });
    }
    if (!attachedByEmail && !(Number.isFinite(attachedByUserIdRaw) && attachedByUserIdRaw > 0)) {
      return res.status(400).json({ message: "attachedByEmail or attachedByUserId required" });
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

    // Resolve attacher: prefer email (cross-app stable). If only a numeric
    // id was supplied, fall back to it. Shadow-provision the attacher row
    // if the email is new to chat (e.g. user has been working in contracts
    // but hasn't logged into chat yet).
    let attacher: ReturnType<typeof storage.getUser>;
    if (attachedByEmail) {
      attacher = storage.getUserByEmail(attachedByEmail);
      if (!attacher) {
        try {
          attacher = storage.createUser({
            orgId,
            email: attachedByEmail,
            passwordHash: "",
            name: attachedByName || attachedByEmail,
            role: "user", // real role syncs on first SSO bridge
          });
          try {
            const orgProjects = storage.listProjectsByOrg(orgId);
            for (const p of orgProjects) {
              try { storage.addProjectMember(p.id, attacher.id, "member"); }
              catch { /* duplicate is fine */ }
            }
          } catch (e) {
            console.warn("[bridge create-channel] attacher project seed failed:", (e as Error).message);
          }
        } catch (e) {
          console.warn("[bridge create-channel] attacher shadow provision failed:", (e as Error).message);
          return res.status(400).json({ message: "Could not resolve attacher in chat org" });
        }
      }
    } else {
      attacher = storage.getUser(attachedByUserIdRaw);
    }
    if (!attacher || attacher.orgId !== orgId) {
      return res.status(400).json({ message: "attacher not in org" });
    }
    const attachedByUserId = attacher.id;

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

    // Resolve email-based members: look up existing chat rows, shadow-
    // provision missing ones, and seed them into the org's projects so the
    // sidebar isn't empty when they first log in. Mirrors bulldog-sso.
    const resolvedFromEmails: number[] = [];
    for (const email of memberEmails) {
      let local = storage.getUserByEmail(email);
      if (!local) {
        try {
          local = storage.createUser({
            orgId,
            email,
            passwordHash: "",
            name: email,
            role: "user", // default; real role syncs on first SSO bridge
          });
          // Seed into every project in the org — same behaviour as bulldog-sso
          // first-login so they immediately see global channels.
          try {
            const orgProjects = storage.listProjectsByOrg(orgId);
            for (const p of orgProjects) {
              try { storage.addProjectMember(p.id, local.id, "member"); }
              catch { /* duplicate is fine */ }
            }
          } catch (e) {
            console.warn("[bridge create-channel] shadow project seed failed:", (e as Error).message);
          }
        } catch (e) {
          console.warn("[bridge create-channel] shadow provision failed for", email, (e as Error).message);
          continue;
        }
      }
      if (local && local.orgId === orgId) resolvedFromEmails.push(local.id);
    }

    // Seed private membership when scope=private. Always include the
    // attacher so they don't lock themselves out.
    if (scope === "private") {
      const ids = new Set<number>(memberIds);
      for (const id of resolvedFromEmails) ids.add(id);
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

  // ---------------------------------------------------------------------------
  // Phase 2.1 — Bulldog Ops → Chat "open job channel".
  //
  // Called by bulldog-ops server/suite-jobs.ts right after it creates a job
  // row from a signed contract. Mirrors contracts/create-meeting closely:
  //   - Creates a work_object (kind="work_project", ref=`JOB-<jobNumber>`)
  //     if one doesn't already exist for this jobId.
  //   - Creates one channel under that work_object under the org's first
  //     project (or `projectId` if the caller supplies one).
  //   - Idempotent on (orgId, jobNumber): second POST reuses both.
  //   - Posts a system message announcing the job.
  // ---------------------------------------------------------------------------
  app.post("/api/integrations/jobs/create-channel", (req, res) => {
    if (!requireSuiteSecret(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const orgId = Number.isFinite(Number(body.orgId)) && Number(body.orgId) > 0
      ? Number(body.orgId)
      : DEFAULT_ORG_ID;

    const attachedByEmail = typeof body.attachedByEmail === "string"
      ? body.attachedByEmail.trim().toLowerCase()
      : "";
    const attachedByName = typeof body.attachedByName === "string"
      ? body.attachedByName.trim()
      : "";

    const lj = body.linkedJob as Record<string, unknown> | undefined;
    if (!lj || typeof lj !== "object") {
      return res.status(400).json({ message: "linkedJob required" });
    }
    const jobId = Number(lj.jobId);
    const jobNumber = typeof lj.jobNumber === "string" ? lj.jobNumber.trim() : "";
    const title = typeof lj.title === "string" ? lj.title.trim() : "";
    const appUrl = typeof lj.appUrl === "string" ? lj.appUrl.trim() : "";
    const contractId = Number(lj.contractId);
    const contractNumber = typeof lj.contractNumber === "string" ? lj.contractNumber.trim() : "";
    const contractUrl = typeof lj.contractUrl === "string" ? lj.contractUrl.trim() : "";

    if (!Number.isFinite(jobId) || jobId <= 0)
      return res.status(400).json({ message: "linkedJob.jobId required" });
    if (!jobNumber) return res.status(400).json({ message: "linkedJob.jobNumber required" });
    if (!title) return res.status(400).json({ message: "linkedJob.title required" });
    if (!attachedByEmail) return res.status(400).json({ message: "attachedByEmail required" });

    const refSafe = sanitizeRefSegment(jobNumber);
    if (!refSafe) return res.status(400).json({ message: "jobNumber has no usable characters" });
    const jobRef = `JOB-${refSafe}`;

    // Resolve target project: caller can pin one, else first project in org.
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

    // Resolve / shadow-provision the attacher (same pattern as create-channel).
    let attacher = storage.getUserByEmail(attachedByEmail);
    if (!attacher) {
      try {
        attacher = storage.createUser({
          orgId,
          email: attachedByEmail,
          passwordHash: "",
          name: attachedByName || attachedByEmail,
          role: "user",
        });
        try {
          const orgProjects = storage.listProjectsByOrg(orgId);
          for (const p of orgProjects) {
            try { storage.addProjectMember(p.id, attacher.id, "member"); }
            catch { /* duplicate is fine */ }
          }
        } catch (e) {
          console.warn("[bridge jobs/create-channel] project seed failed:", (e as Error).message);
        }
      } catch (e) {
        console.warn("[bridge jobs/create-channel] attacher shadow provision failed:", (e as Error).message);
        return res.status(400).json({ message: "Could not resolve attacher in chat org" });
      }
    }
    if (!attacher || attacher.orgId !== orgId) {
      return res.status(400).json({ message: "attacher not in org" });
    }

    // 1. Find or create the job work_object (idempotent on jobRef).
    const JOB_KIND = "work_project" as const;
    let job = storage.getWorkObjectByRef(orgId, JOB_KIND, jobRef);
    if (!job) {
      job = storage.createWorkObject({
        orgId,
        projectId,
        kind: JOB_KIND,
        ref: jobRef,
        title: title.slice(0, 200),
        status: "open",
        description: contractUrl
          ? `Source contract: ${contractUrl}`
          : (contractNumber ? `Source contract ref: ${contractNumber}` : `Job ${jobNumber}`),
        parentId: null,
        ownerUserId: null,
        attributes: JSON.stringify({
          jobId,
          jobNumber,
          contractId: Number.isFinite(contractId) ? contractId : null,
          contractNumber: contractNumber || null,
          opsAppUrl: appUrl || null,
          contractUrl: contractUrl || null,
          source: "ops-bridge",
        }),
        createdByUserId: attacher.id,
      });
      try {
        storage.appendWorkObjectActivity({
          workObjectId: job.id,
          type: "created",
          actorUserId: attacher.id,
          payload: JSON.stringify({
            source: "ops-bridge",
            jobId,
            jobNumber,
            contractId: Number.isFinite(contractId) ? contractId : null,
            contractNumber: contractNumber || null,
          }),
        });
      } catch (e) {
        console.warn("[bridge jobs/create-channel] activity log failed:", (e as Error).message);
      }
    }

    // 2. Find or create the job's channel (dedupe on projectId).
    const existingChannels = storage.listChannelsForWorkObject(job.id);
    let channel = existingChannels.find(c => c.projectId === projectId) ?? null;
    if (!channel) {
      const titleSlug = sanitizeChannelName(title);
      const channelName = titleSlug && titleSlug !== "job"
        ? titleSlug
        : sanitizeChannelName(`job-${refSafe}`);
      const allInProject = storage.listChannelsByProject(projectId);
      channel = storage.createChannel({
        projectId,
        workObjectId: job.id,
        position: allInProject.length,
        name: channelName,
        type: "text",
        topic: `Job ${jobNumber} — ${title.slice(0, 380)}`,
        scope: "global",
        entityId: null,
        teamRole: null,
      });

      // System message announcing the job.
      try {
        storage.createMessage({
          channelId: channel.id,
          userId: attacher.id,
          content: `📄 Job opened from contract ${contractNumber || "(no number)"}: ${title}`,
          meta: JSON.stringify({
            system: true,
            kind: "job_opened",
            jobId,
            jobNumber,
            contractId: Number.isFinite(contractId) ? contractId : null,
            contractNumber: contractNumber || null,
            opsAppUrl: appUrl || null,
            contractUrl: contractUrl || null,
          }),
        });
      } catch (e) {
        console.warn("[bridge jobs/create-channel] system message skipped:", (e as Error).message);
      }
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
