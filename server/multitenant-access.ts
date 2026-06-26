/**
 * Multi-tenant access plumbing (Option A).
 *
 * Two responsibilities:
 *
 *   1. mirrorUserGrants — invoked from the SSO bridge on every request that
 *      carries a fresh bulldog-auth JWT. Translates the JWT's `grants[]`
 *      array into chat-side `user_project_regions` rows, transactionally
 *      replacing the previous set so revocations land immediately.
 *
 *   2. computeAccess — pure read against `user_project_regions` that
 *      returns a snapshot of which projects/regions the caller can reach.
 *      Used by `req.access` middleware (see auth.ts) and the storage
 *      visibility helpers (canSeeChannel, channelIdsForAccess, etc.).
 *
 * Access semantics:
 *
 *   - super_admin (global) sees everything; computeAccess returns
 *     { isSuperAdmin: true } and downstream helpers short-circuit.
 *   - For everyone else: a row in user_project_regions with regionId=NULL
 *     grants the whole project (all regions + company-wide channels). A
 *     row with regionId=R grants exactly that region's channels + the
 *     project's company-wide channels (regionId IS NULL).
 *   - No row → no access. Deny-by-default.
 */

import { rawDb } from "./db";

// ---------- Types ----------

export interface AuthGrant {
  companyId: string;
  locationId: string | null;
}

export interface AccessSnapshot {
  /** Global super_admin bypasses every visibility check. */
  isSuperAdmin: boolean;
  /** Projects the user can see at all (any grant row, any region). */
  projectIds: Set<number>;
  /**
   * Per-project, the set of region ids the user is scoped to. A value of
   * `null` in the set means a whole-project grant (sees every region +
   * company-wide channels). For mixed grants, the set contains both
   * `null` and specific region ids; whichever is broadest wins per
   * channel.
   */
  regionsByProject: Map<number, Set<number | null>>;
}

// ---------- Mirror auth grants → chat rows ----------

interface ResolvedGrant {
  projectId: number;
  /** null = whole-project grant (auth side locationId was NULL). */
  regionId: number | null;
}

/**
 * Translate the JWT grants[] into chat (projectId, regionId | null) tuples
 * by looking up project_auth_company and regions. Grants for unknown
 * companies/locations are silently dropped — the seed must run before SSO
 * can wire up access, and a missing row simply means "no chat grant yet".
 */
function resolveGrants(grants: AuthGrant[]): ResolvedGrant[] {
  if (grants.length === 0) return [];

  const projectByAuthCompany = new Map<string, number>();
  for (const row of rawDb
    .prepare(`SELECT project_id, auth_company_id FROM project_auth_company`)
    .all() as Array<{ project_id: number; auth_company_id: string }>) {
    projectByAuthCompany.set(row.auth_company_id, row.project_id);
  }

  // (projectId, authLocationId) → regionId
  const regionByProjectAndAuthLoc = new Map<string, number>();
  for (const row of rawDb
    .prepare(`SELECT id, project_id, auth_location_id FROM regions WHERE auth_location_id IS NOT NULL`)
    .all() as Array<{ id: number; project_id: number; auth_location_id: string }>) {
    regionByProjectAndAuthLoc.set(`${row.project_id}:${row.auth_location_id}`, row.id);
  }

  const resolved: ResolvedGrant[] = [];
  for (const g of grants) {
    const projectId = projectByAuthCompany.get(g.companyId);
    if (!projectId) continue; // unknown company — silently drop
    if (g.locationId === null) {
      resolved.push({ projectId, regionId: null });
    } else {
      const regionId = regionByProjectAndAuthLoc.get(`${projectId}:${g.locationId}`);
      if (regionId !== undefined) {
        resolved.push({ projectId, regionId });
      }
      // Unknown location — drop. Don't fall back to "whole project" since
      // that would silently promote a scoped grant.
    }
  }
  return resolved;
}

/**
 * Replace the user's full user_project_regions set with the resolved grants
 * in a single transaction. Idempotent — calling it twice with the same
 * input is a no-op.
 *
 * Also auto-adds project_members rows for every newly granted project so
 * the existing project-membership-gated UI (sidebar, listProjectsForUser)
 * keeps working without a separate sync path. Stale memberships from a
 * revoked project are NOT removed here; that's handled lazily by the
 * access middleware (a channel/project read with no live grant just 404s).
 */
export function mirrorUserGrants(userId: number, grants: AuthGrant[]): void {
  const resolved = resolveGrants(grants);

  const tx = rawDb.transaction(() => {
    rawDb.prepare(`DELETE FROM user_project_regions WHERE user_id = ?`).run(userId);
    if (resolved.length === 0) return;
    const ins = rawDb.prepare(
      `INSERT INTO user_project_regions (user_id, project_id, region_id, granted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, project_id, region_id) DO NOTHING`,
    );
    const now = Math.floor(Date.now() / 1000);
    for (const g of resolved) {
      ins.run(userId, g.projectId, g.regionId, now);
    }
  });
  tx();

  // Maintain project_members in lockstep so listProjectsForUser et al.
  // continue to work. We add but never delete here.
  const newProjectIds = new Set(resolved.map((r) => r.projectId));
  if (newProjectIds.size === 0) return;
  const ensureMember = rawDb.prepare(
    `INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')`,
  );
  for (const pid of newProjectIds) ensureMember.run(pid, userId);
}

// ---------- Compute snapshot ----------

/**
 * Read the user's current grant snapshot. Cheap (≤2 indexed queries).
 * Call this once per request and stash on req.access; downstream helpers
 * can then make O(1) checks.
 *
 * Pass `globalRole` from the JWT (or the chat user row's role) so we can
 * short-circuit for super_admin without a DB read.
 */
export function computeAccess(
  userId: number,
  globalRole: string | null | undefined,
): AccessSnapshot {
  if (globalRole === "super_admin") {
    return {
      isSuperAdmin: true,
      projectIds: new Set(), // unused when isSuperAdmin
      regionsByProject: new Map(),
    };
  }

  const rows = rawDb
    .prepare(
      `SELECT project_id, region_id FROM user_project_regions WHERE user_id = ?`,
    )
    .all(userId) as Array<{ project_id: number; region_id: number | null }>;

  const projectIds = new Set<number>();
  const regionsByProject = new Map<number, Set<number | null>>();
  for (const r of rows) {
    projectIds.add(r.project_id);
    let s = regionsByProject.get(r.project_id);
    if (!s) {
      s = new Set();
      regionsByProject.set(r.project_id, s);
    }
    s.add(r.region_id);
  }
  return { isSuperAdmin: false, projectIds, regionsByProject };
}

// ---------- Visibility predicates ----------

/**
 * Can the caller see a given channel? Returns true if:
 *   - they're super_admin, OR
 *   - they have a whole-project grant on the channel's project, OR
 *   - the channel is company-wide (regionId IS NULL) and they have ANY
 *     grant on the project (region-scoped users still see company-wide
 *     channels — that's the announcement use case), OR
 *   - they have a region-scoped grant matching the channel's region.
 *
 * Pass the channel's projectId + regionId (regionId may be null).
 */
export function canSeeChannel(
  access: AccessSnapshot,
  channelProjectId: number,
  channelRegionId: number | null,
): boolean {
  if (access.isSuperAdmin) return true;
  const regions = access.regionsByProject.get(channelProjectId);
  if (!regions || regions.size === 0) return false;
  // Whole-project grant — covers everything in this project.
  if (regions.has(null)) return true;
  // Company-wide channel — any project grant suffices.
  if (channelRegionId === null) return true;
  // Region-scoped channel — need a matching region grant.
  return regions.has(channelRegionId);
}

/** Can the caller see anything in this project? */
export function canSeeProject(access: AccessSnapshot, projectId: number): boolean {
  if (access.isSuperAdmin) return true;
  return access.projectIds.has(projectId);
}

/**
 * Build the SQL fragment that filters channels.id down to what the caller
 * can see. Returns null when the caller has no access at all (caller
 * should 404 / return empty array). Returns "1=1" for super_admins.
 *
 * The returned predicate references the `channels` table and assumes
 * `channels.project_id` and `channels.region_id` are reachable. Combine
 * with AND in your query's WHERE clause.
 */
export function channelAccessSqlFragment(access: AccessSnapshot): {
  sql: string;
  params: Array<number | null>;
} | null {
  if (access.isSuperAdmin) return { sql: "1=1", params: [] };
  if (access.projectIds.size === 0) return null;

  const clauses: string[] = [];
  const params: Array<number | null> = [];

  for (const [projectId, regions] of access.regionsByProject) {
    if (regions.has(null)) {
      // Whole-project grant — all channels in this project.
      clauses.push(`channels.project_id = ?`);
      params.push(projectId);
    } else {
      // Region-scoped: company-wide channels for this project + matching regions.
      const regionIds = [...regions].filter((r): r is number => r !== null);
      if (regionIds.length === 0) continue;
      const placeholders = regionIds.map(() => "?").join(",");
      clauses.push(
        `(channels.project_id = ? AND (channels.region_id IS NULL OR channels.region_id IN (${placeholders})))`,
      );
      params.push(projectId, ...regionIds);
    }
  }
  if (clauses.length === 0) return null;
  return { sql: `(${clauses.join(" OR ")})`, params };
}

/**
 * Compute the full set of channel ids the caller can see right now. Used
 * by routes that need a hard list rather than a SQL fragment (e.g. push
 * fan-out, mention autocomplete). Returns null = no access.
 */
export function channelIdsForAccess(access: AccessSnapshot): Set<number> | null {
  if (access.isSuperAdmin) {
    const rows = rawDb.prepare(`SELECT id FROM channels`).all() as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }
  const frag = channelAccessSqlFragment(access);
  if (!frag) return null;
  const rows = rawDb
    .prepare(`SELECT channels.id AS id FROM channels WHERE ${frag.sql}`)
    .all(...frag.params) as Array<{ id: number }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Project ids the caller can see. Super admin → every project in the org.
 */
export function projectIdsForAccess(access: AccessSnapshot, orgId: number): Set<number> {
  if (access.isSuperAdmin) {
    const rows = rawDb
      .prepare(`SELECT id FROM projects WHERE org_id = ?`)
      .all(orgId) as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }
  return new Set(access.projectIds);
}

/**
 * One-shot route gate. Given the caller's snapshot and a channel id, return
 * the channel row when the caller can see it, or null when they can't (or
 * the channel doesn't exist). Use this from routes that don't go through
 * the legacy userCanAccessChannel helper.
 */
export function gateChannelById(
  access: AccessSnapshot,
  channelId: number,
): { id: number; project_id: number; region_id: number | null } | null {
  const row = rawDb
    .prepare(
      `SELECT id, project_id, region_id FROM channels WHERE id = ? LIMIT 1`,
    )
    .get(channelId) as { id: number; project_id: number; region_id: number | null } | undefined;
  if (!row) return null;
  if (!canSeeChannel(access, row.project_id, row.region_id)) return null;
  return row;
}

/**
 * One-shot project gate. Returns true iff the caller can see the project at
 * all (any grant). Mirrors gateChannelById for project-scoped routes.
 */
export function gateProjectById(access: AccessSnapshot, projectId: number): boolean {
  return canSeeProject(access, projectId);
}
