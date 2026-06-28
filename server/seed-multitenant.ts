/**
 * Multi-tenant Option A seed for Bulldogchat.
 *
 * Establishes the Bulldog Suite shape on the chat side:
 *
 *   1 chat organization   "Bulldog Suite"
 *     ├─ 4 projects        (one per bulldog-auth company — VFD / Vector
 *     │                     Services / Vector Talent Solutions / TDIS).
 *     │                     Each project row is tagged in
 *     │                     project_auth_company.authCompanyId so SSO
 *     │                     grants can resolve to chat ids.
 *     ├─ 24 regions        (6 regions per project: PNW, W, SW, C, SE, NE).
 *     │                     Each region row is tagged with the matching
 *     │                     bulldog-auth global locationId.
 *     └─ per region        #general, #random (regionId = R)
 *     └─ per project       #announcements    (regionId = NULL → company-wide)
 *
 * Auth-side IDs are resolved at boot via two new internal endpoints on
 * bulldog-auth, both protected by SUITE_INTERNAL_SECRET (the same shared
 * service token already used by /api/internal/users).
 *
 * The seed is idempotent — every insert is guarded by a name/id lookup
 * first. Safe to run on every boot once enabled.
 *
 * Enable by setting MULTITENANT_MODE=1 in the Render service env. While
 * MULTITENANT_MODE=1 the legacy single-tenant runSeed() is skipped.
 */

import { storage } from "./storage";
import { hashPassword } from "./auth";
import { rawDb } from "./db";

// ---------- Canonical names ----------
// Must match bulldog-auth/server/seed-multitenant.ts EXACTLY so name-based
// joins resolve. If you rename one side, rename the other in the same PR.
const CHAT_PROJECTS: Array<{
  authCompanyName: string; // join key — must match auth companies.name
  slug: string;            // canonical slug going forward (kept short for sidebar)
  aliases: string[];       // any legacy slug we should treat as same-tenant during cleanup
  short: string;
  hue: number;
  description: string;
}> = [
  {
    authCompanyName: "Vector Force Development",
    slug: "vfd",
    aliases: ["vector-force-development"],
    short: "VFD",
    hue: 232,
    description: "Vector Force Development — utility construction & infrastructure.",
  },
  {
    authCompanyName: "Vector Services",
    slug: "vs",
    aliases: ["vector-services"],
    short: "VS",
    hue: 218,
    description: "Vector Services — field operations & maintenance.",
  },
  {
    authCompanyName: "Vector Talent Solutions",
    slug: "vts",
    aliases: ["vector-talent-solutions"],
    short: "VTS",
    hue: 28,
    description: "Vector Talent Solutions — staffing & placement.",
  },
  {
    authCompanyName: "TDIS",
    slug: "tdis",
    aliases: [],
    short: "TDIS",
    hue: 207,
    description: "TDIS — telecom and dark-fiber installation services.",
  },
];

// Region code ⇄ auth location name. The chat-side `regions` table uses a
// short code for sidebar display + a long name for tooltips/labels.
const REGION_DEFS: Array<{
  code: string;
  name: string;
  authLocationName: string; // join key — must match auth locations.name
  position: number;
}> = [
  { code: "PNW", name: "Pacific Northwest", authLocationName: "Pacific Northwest", position: 0 },
  { code: "W",   name: "West",              authLocationName: "West",              position: 1 },
  { code: "SW",  name: "Southwest",         authLocationName: "Southwest",         position: 2 },
  { code: "C",   name: "Central",           authLocationName: "Central",           position: 3 },
  { code: "SE",  name: "Southeast",         authLocationName: "Southeast",         position: 4 },
  { code: "NE",  name: "Northeast",         authLocationName: "Northeast",         position: 5 },
];

// Channels every region gets out of the box.
const PER_REGION_CHANNELS: Array<{ name: string; topic: string }> = [
  { name: "general", topic: "Regional chatter — keep it civil, keep it brief." },
  { name: "random",  topic: "Off-topic, banter, memes (PPE-compliant memes only)." },
];

// Channels every project gets at the company-wide level (regionId = NULL).
const PER_PROJECT_CHANNELS: Array<{ name: string; topic: string }> = [
  { name: "announcements", topic: "Company-wide announcements. Pinned by leadership." },
];

const SUPER_ADMIN = {
  email: "jbieler@vectorfd.com",
  name: "Jordan Bieler",
  // role is mapped through SSO bridge; this local role is only used when
  // SSO is unavailable and the user logs in with email+password directly.
  role: "admin" as const,
  title: "Founder",
  hue: 2,
  // Local password is a fallback; SSO is the canonical path.
  password: "Vector2026!",
};

// ---------- Auth-side resolver ----------
interface AuthCompany { id: string; name: string }
interface AuthLocation { id: string; name: string }

async function fetchJson<T>(url: string, secret: string): Promise<T> {
  const r = await fetch(url, { headers: { "x-suite-secret": secret } });
  if (!r.ok) throw new Error(`${url} → ${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

async function resolveAuthIds(): Promise<{
  companiesByName: Map<string, AuthCompany>;
  locationsByName: Map<string, AuthLocation>;
}> {
  const base = process.env.BULLDOG_AUTH_URL?.replace(/\/$/, "");
  const secret = process.env.SUITE_INTERNAL_SECRET;
  if (!base || !secret) {
    throw new Error(
      "[seed-mt] BULLDOG_AUTH_URL + SUITE_INTERNAL_SECRET must be set to seed multi-tenant",
    );
  }
  const [companies, locations] = await Promise.all([
    fetchJson<{ companies: AuthCompany[] }>(`${base}/api/internal/companies`, secret),
    fetchJson<{ locations: AuthLocation[] }>(`${base}/api/internal/locations`, secret),
  ]);
  return {
    companiesByName: new Map(companies.companies.map((c) => [c.name, c])),
    locationsByName: new Map(locations.locations.map((l) => [l.name, l])),
  };
}

// ---------- Idempotent helpers (raw DB) ----------
function getOrgByName(name: string) {
  return rawDb
    .prepare(`SELECT id FROM organizations WHERE name = ? LIMIT 1`)
    .get(name) as { id: number } | undefined;
}

function getProjectBySlug(slug: string) {
  return rawDb
    .prepare(`SELECT id FROM projects WHERE slug = ? LIMIT 1`)
    .get(slug) as { id: number } | undefined;
}

function getProjectAuthLink(projectId: number) {
  return rawDb
    .prepare(`SELECT auth_company_id FROM project_auth_company WHERE project_id = ?`)
    .get(projectId) as { auth_company_id: string } | undefined;
}

function upsertProjectAuthLink(projectId: number, authCompanyId: string) {
  rawDb
    .prepare(
      `INSERT INTO project_auth_company (project_id, auth_company_id)
       VALUES (?, ?)
       ON CONFLICT(project_id) DO UPDATE SET auth_company_id = excluded.auth_company_id`,
    )
    .run(projectId, authCompanyId);
}

function getRegion(projectId: number, code: string) {
  return rawDb
    .prepare(`SELECT id, auth_location_id FROM regions WHERE project_id = ? AND code = ?`)
    .get(projectId, code) as { id: number; auth_location_id: string | null } | undefined;
}

function getChannelByName(projectId: number, name: string, regionId: number | null) {
  const sql =
    regionId === null
      ? `SELECT id FROM channels WHERE project_id = ? AND name = ? AND region_id IS NULL LIMIT 1`
      : `SELECT id FROM channels WHERE project_id = ? AND name = ? AND region_id = ? LIMIT 1`;
  const stmt = rawDb.prepare(sql);
  return (regionId === null
    ? stmt.get(projectId, name)
    : stmt.get(projectId, name, regionId)) as { id: number } | undefined;
}

function getUserByEmail(email: string) {
  return rawDb
    .prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`)
    .get(email) as { id: number } | undefined;
}

// ---------- Self-healing dupe cleanup ----------
// Historical bug: an older version of this seed (or a transient deploy
// without MULTITENANT_MODE=1) created project rows under shorter legacy
// slugs ("vfd", "vs", "vts") or, more recently, the canonical long slugs
// got duplicated mid-seed when an earlier boot failed partway through.
// Worse — prod was observed with id=12 slug="vfd" linked to the WRONG
// auth_company_id (VS) and orphan rows with corrupt +058xxx createdAt
// dates from a Unix-ms-as-seconds bug.
//
// New strategy (v3): for each canonical project (by short slug + aliases),
// find every candidate row that either (a) has a slug in {slug, ...aliases}
// OR (b) is linked via project_auth_company to the matching auth UUID.
// Among candidates, pick the keeper by MOST MESSAGES (tie-break: lowest id)
// so we never discard the row the user actually chatted into. Force the
// keeper's slug/name/description back to canonical, re-link its
// auth_company_id, then nuke every other candidate via the full cascade.
function cleanupDuplicateProjects(
  companiesByName?: Map<string, { id: string }>,
): void {
  const allProjects = rawDb
    .prepare(`SELECT id, slug, name FROM projects ORDER BY id ASC`)
    .all() as Array<{ id: number; slug: string; name: string }>;

  const toDelete = new Set<number>();
  const keepers = new Map<string, number>(); // canonical slug -> kept id
  const protectedIds = new Set<number>();    // never delete a keeper

  // Helper: count messages under all channels of a project.
  const messageCount = (projectId: number): number => {
    try {
      const row = rawDb
        .prepare(
          `SELECT COUNT(m.id) AS c FROM messages m
           JOIN channels c ON c.id = m.channel_id
           WHERE c.project_id = ?`,
        )
        .get(projectId) as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  };

  for (const cp of CHAT_PROJECTS) {
    const slugSet = new Set<string>([cp.slug, ...cp.aliases]);
    const candidates = new Map<
      number,
      { id: number; slug: string; name: string }
    >();

    // (a) slug-match candidates.
    for (const row of allProjects) {
      if (slugSet.has(row.slug)) candidates.set(row.id, row);
    }

    // (b) auth-link candidates — every project currently linked to this
    //     tenant's auth UUID, even if its slug doesn't match.
    const authId = companiesByName?.get(cp.authCompanyName)?.id;
    if (authId) {
      const linkedRows = rawDb
        .prepare(
          `SELECT p.id, p.slug, p.name FROM projects p
           JOIN project_auth_company pac ON pac.project_id = p.id
           WHERE pac.auth_company_id = ?`,
        )
        .all(authId) as Array<{ id: number; slug: string; name: string }>;
      for (const row of linkedRows) candidates.set(row.id, row);
    }

    if (candidates.size === 0) continue;

    // Pick keeper: most messages, tie-break lowest id.
    let keeper: { id: number; msgs: number } | null = null;
    for (const row of candidates.values()) {
      const msgs = messageCount(row.id);
      if (
        !keeper ||
        msgs > keeper.msgs ||
        (msgs === keeper.msgs && row.id < keeper.id)
      ) {
        keeper = { id: row.id, msgs };
      }
    }
    if (!keeper) continue;

    keepers.set(cp.slug, keeper.id);
    protectedIds.add(keeper.id);
    console.log(
      `[seed-mt] keeper ${cp.short} project_id=${keeper.id} msgs=${keeper.msgs} (candidates=${[...candidates.keys()].join(",")})`,
    );

    // Force keeper metadata back to canonical.
    try {
      rawDb
        .prepare(
          `UPDATE projects SET slug = ?, name = ?, description = ? WHERE id = ?`,
        )
        .run(cp.slug, cp.short, cp.description, keeper.id);
    } catch (e: any) {
      console.warn(
        `[seed-mt] could not normalize keeper id=${keeper.id}: ${e?.message ?? e}`,
      );
    }

    // Re-link auth_company_id on keeper (delete then insert, idempotent).
    if (authId) {
      try {
        rawDb
          .prepare(`DELETE FROM project_auth_company WHERE project_id = ?`)
          .run(keeper.id);
        rawDb
          .prepare(
            `INSERT INTO project_auth_company (project_id, auth_company_id) VALUES (?, ?)`,
          )
          .run(keeper.id, authId);
      } catch (e: any) {
        console.warn(
          `[seed-mt] could not re-link auth_company_id for keeper id=${keeper.id}: ${e?.message ?? e}`,
        );
      }
    }

    // Everyone else in candidates dies.
    for (const id of candidates.keys()) {
      if (id !== keeper.id) toDelete.add(id);
    }
  }

  // Finally, any project not protected by being a keeper is an orphan or
  // duplicate — drop it too. This catches the +058xxx-date ghost rows and
  // any stray short-slug rows we never linked to.
  for (const row of allProjects) {
    if (!protectedIds.has(row.id)) toDelete.add(row.id);
  }

  // Defensive: never delete a keeper, no matter how we got here.
  for (const id of protectedIds) toDelete.delete(id);

  if (toDelete.size === 0) {
    console.log("[seed-mt] cleanup: no duplicate/orphan project rows");
    return;
  }

  console.log(
    `[seed-mt] cleaning ${toDelete.size} duplicate/legacy project rows: ${[...toDelete].join(", ")}`,
  );

  // SQLite FK constraints can foil deleteProjectCascade when a table we
  // don't know about still points at the project. Temporarily disable FKs
  // for this teardown so the cleanup is guaranteed to complete; the data
  // we're nuking is duplicate seed scaffolding with no real user content.
  const safeRun = (sql: string, ...params: any[]) => {
    try { rawDb.prepare(sql).run(...params); } catch (e: any) {
      if (!/no such (table|column)/i.test(String(e?.message))) throw e;
    }
  };
  rawDb.pragma("foreign_keys = OFF");
  try {
    for (const id of toDelete) {
      // Try the orchestrated cascade first — it knows about every chat-
      // owned dependency. If it still throws, fall back to direct raw
      // deletes of every known referencing table, then drop the project.
      try {
        storage.deleteProjectCascade(id);
        continue;
      } catch (e: any) {
        console.warn(
          `[seed-mt] cascade failed for project id=${id}, doing raw teardown: ${e?.message ?? e}`,
        );
      }
      // Find every channel under this project, then nuke message-tier
      // rows by channel id before dropping the channels themselves.
      const chIds = rawDb
        .prepare(`SELECT id FROM channels WHERE project_id = ?`)
        .all(id) as Array<{ id: number }>;
      for (const { id: chId } of chIds) {
        const msgIds = rawDb
          .prepare(`SELECT id FROM messages WHERE channel_id = ?`)
          .all(chId) as Array<{ id: number }>;
        for (const { id: mId } of msgIds) {
          safeRun(`DELETE FROM reactions WHERE message_id = ?`, mId);
          safeRun(`DELETE FROM message_mentions WHERE message_id = ?`, mId);
          safeRun(`DELETE FROM attachments WHERE message_id = ?`, mId);
        }
        safeRun(`DELETE FROM messages WHERE channel_id = ?`, chId);
        safeRun(`DELETE FROM read_receipts WHERE channel_id = ?`, chId);
        safeRun(`DELETE FROM channel_members WHERE channel_id = ?`, chId);
        safeRun(`DELETE FROM recordings WHERE channel_id = ?`, chId);
        safeRun(`DELETE FROM livekit_rooms WHERE channel_id = ?`, chId);
        safeRun(`DELETE FROM work_object_channel_links WHERE channel_id = ?`, chId);
        safeRun(`DELETE FROM meeting_notes WHERE channel_id = ?`, chId);
        // scheduled_calls + invitees
        try {
          const callIds = rawDb
            .prepare(`SELECT id FROM scheduled_calls WHERE channel_id = ?`)
            .all(chId) as Array<{ id: number }>;
          for (const { id: cId } of callIds) {
            safeRun(
              `DELETE FROM scheduled_call_invitees WHERE scheduled_call_id = ?`,
              cId,
            );
          }
          safeRun(`DELETE FROM scheduled_calls WHERE channel_id = ?`, chId);
        } catch (e: any) {
          if (!/no such (table|column)/i.test(String(e?.message))) throw e;
        }
        safeRun(`DELETE FROM channels WHERE id = ?`, chId);
      }
      // work_objects under this project (and their activity rows).
      try {
        const woIds = rawDb
          .prepare(`SELECT id FROM work_objects WHERE project_id = ?`)
          .all(id) as Array<{ id: number }>;
        for (const { id: woId } of woIds) {
          safeRun(`DELETE FROM work_object_activity WHERE work_object_id = ?`, woId);
          safeRun(`DELETE FROM work_object_channel_links WHERE work_object_id = ?`, woId);
        }
        safeRun(`DELETE FROM work_objects WHERE project_id = ?`, id);
      } catch (e: any) {
        if (!/no such (table|column)/i.test(String(e?.message))) throw e;
      }
      // Multi-tenant + membership + invites.
      safeRun(`DELETE FROM user_project_regions WHERE project_id = ?`, id);
      safeRun(`DELETE FROM regions WHERE project_id = ?`, id);
      safeRun(`DELETE FROM project_auth_company WHERE project_id = ?`, id);
      safeRun(`DELETE FROM project_members WHERE project_id = ?`, id);
      safeRun(`DELETE FROM invites WHERE project_id = ?`, id);
      // Finally the project row itself.
      safeRun(`DELETE FROM projects WHERE id = ?`, id);
      console.log(`[seed-mt] raw-tore-down project id=${id}`);
    }
  } finally {
    rawDb.pragma("foreign_keys = ON");
  }
}

// ---------- Entry point ----------
export async function runMultiTenantSeed(): Promise<void> {
  // Resolve auth IDs first — bail loudly if the auth service is unreachable
  // so we don't seed half a tree.
  const { companiesByName, locationsByName } = await resolveAuthIds();

  // 0. Self-heal: collapse duplicate/legacy/orphan rows into the canonical 4
  //    projects. Runs AFTER resolveAuthIds() so we can pick the keeper by
  //    message count and re-link auth_company_id correctly.
  cleanupDuplicateProjects(companiesByName);

  // Sanity: every canonical name must exist auth-side.
  for (const p of CHAT_PROJECTS) {
    if (!companiesByName.has(p.authCompanyName)) {
      throw new Error(`[seed-mt] auth company missing: "${p.authCompanyName}"`);
    }
  }
  for (const r of REGION_DEFS) {
    if (!locationsByName.has(r.authLocationName)) {
      throw new Error(`[seed-mt] auth location missing: "${r.authLocationName}"`);
    }
  }

  // 1. Org
  let org = getOrgByName("Bulldog Suite");
  if (!org) {
    const created = storage.createOrg({
      name: "Bulldog Suite",
      slug: "bulldog-suite",
      plan: "starter",
    });
    org = { id: created.id };
    console.log(`[seed-mt] created org "Bulldog Suite" id=${org.id}`);
  }

  // 2. Super admin user (idempotent)
  let adminId: number;
  const existingAdmin = getUserByEmail(SUPER_ADMIN.email);
  if (existingAdmin) {
    adminId = existingAdmin.id;
  } else {
    const created = storage.createUser({
      orgId: org.id,
      email: SUPER_ADMIN.email,
      passwordHash: hashPassword(SUPER_ADMIN.password),
      name: SUPER_ADMIN.name,
      role: SUPER_ADMIN.role,
      title: SUPER_ADMIN.title,
      hue: SUPER_ADMIN.hue,
    });
    adminId = created.id;
    console.log(`[seed-mt] created super admin ${SUPER_ADMIN.email} id=${adminId}`);
  }

  // 3. Projects + auth link
  const projectIdByName = new Map<string, number>();
  for (const p of CHAT_PROJECTS) {
    let proj = getProjectBySlug(p.slug);
    if (!proj) {
      const created = storage.createProject({
        orgId: org.id,
        name: p.authCompanyName, // display name = auth company name
        slug: p.slug,
        short: p.short,
        hue: p.hue,
        description: p.description,
      });
      proj = { id: created.id };
      console.log(`[seed-mt] created project "${p.authCompanyName}" id=${proj.id}`);
    }
    projectIdByName.set(p.authCompanyName, proj.id);

    // Link to auth company.
    const link = getProjectAuthLink(proj.id);
    const authId = companiesByName.get(p.authCompanyName)!.id;
    if (!link || link.auth_company_id !== authId) {
      upsertProjectAuthLink(proj.id, authId);
      console.log(`[seed-mt] linked project ${proj.id} → auth_company_id=${authId}`);
    }

    // Make the super admin a project member so admin tooling has full reach.
    storage.addProjectMember(proj.id, adminId, "admin");
  }

  // 4. Regions (6 per project)
  const insertRegion = rawDb.prepare(
    `INSERT INTO regions (project_id, code, name, position, auth_location_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateRegionAuth = rawDb.prepare(
    `UPDATE regions SET auth_location_id = ? WHERE id = ?`,
  );
  const regionIdByProjectAndCode = new Map<string, number>(); // key = `${projectId}:${code}`

  for (const p of CHAT_PROJECTS) {
    const projectId = projectIdByName.get(p.authCompanyName)!;
    for (const r of REGION_DEFS) {
      const authLocId = locationsByName.get(r.authLocationName)!.id;
      let existing = getRegion(projectId, r.code);
      if (!existing) {
        const result = insertRegion.run(
          projectId,
          r.code,
          r.name,
          r.position,
          authLocId,
          Math.floor(Date.now() / 1000),
        );
        const id = Number(result.lastInsertRowid);
        existing = { id, auth_location_id: authLocId };
        console.log(
          `[seed-mt] created region ${p.short}/${r.code} id=${id} auth_location_id=${authLocId}`,
        );
      } else if (existing.auth_location_id !== authLocId) {
        updateRegionAuth.run(authLocId, existing.id);
        console.log(`[seed-mt] updated region ${p.short}/${r.code} auth_location_id=${authLocId}`);
      }
      regionIdByProjectAndCode.set(`${projectId}:${r.code}`, existing.id);
    }
  }

  // 5. Channels — per-region #general + #random; per-project #announcements.
  let position = 0;
  for (const p of CHAT_PROJECTS) {
    const projectId = projectIdByName.get(p.authCompanyName)!;

    // Company-wide channels first (regionId = NULL).
    for (const c of PER_PROJECT_CHANNELS) {
      if (!getChannelByName(projectId, c.name, null)) {
        storage.createChannel({
          projectId,
          regionId: null,
          name: c.name,
          type: "text",
          topic: c.topic,
          position: position++,
        });
        console.log(`[seed-mt] created channel ${p.short}/#${c.name} (company-wide)`);
      }
    }

    // Per-region channels.
    for (const r of REGION_DEFS) {
      const regionId = regionIdByProjectAndCode.get(`${projectId}:${r.code}`)!;
      for (const c of PER_REGION_CHANNELS) {
        if (!getChannelByName(projectId, c.name, regionId)) {
          storage.createChannel({
            projectId,
            regionId,
            name: c.name,
            type: "text",
            topic: c.topic,
            position: position++,
          });
          console.log(`[seed-mt] created channel ${p.short}/${r.code}/#${c.name}`);
        }
      }
    }
  }

  // 6. Super-admin user_project_regions — whole-project grants on all 4
  //    projects (regionId = NULL). The SSO bridge will refresh this from
  //    grants[] on the JWT on every bridge, but seeding the base row lets
  //    local logins work too.
  const insertGrant = rawDb.prepare(
    `INSERT INTO user_project_regions (user_id, project_id, region_id, granted_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(user_id, project_id, region_id) DO NOTHING`,
  );
  const now = Math.floor(Date.now() / 1000);
  for (const p of CHAT_PROJECTS) {
    insertGrant.run(adminId, projectIdByName.get(p.authCompanyName)!, now);
  }

  console.log(`[seed-mt] done. ${CHAT_PROJECTS.length} projects × ${REGION_DEFS.length} regions seeded.`);
}
