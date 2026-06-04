import { rawDb } from "./db";

// Idempotent schema. We use a plain create-if-not-exists migration since the
// Drizzle types are simple. drizzle-kit generated migrations are not bundled.
export function runMigrations() {
  rawDb.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'starter',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT,
    avatar_url TEXT,
    hue INTEGER NOT NULL DEFAULT 220,
    role TEXT NOT NULL DEFAULT 'field',
    status TEXT NOT NULL DEFAULT 'online',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS users_org_idx ON users(org_id);

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    short TEXT NOT NULL,
    hue INTEGER NOT NULL DEFAULT 220,
    description TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(org_id);

  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS channels_proj_idx ON channels(project_id);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    attachments TEXT,
    reply_to_message_id INTEGER,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages(reply_to_message_id);

  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS read_receipts (
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    last_read_message_id INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    device_label TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    project_id INTEGER REFERENCES projects(id),
    email TEXT,
    role TEXT NOT NULL DEFAULT 'field',
    token TEXT NOT NULL UNIQUE,
    invited_by_user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS livekit_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    room_name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL
  );

  -- v2: attachments
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id),
    uploader_user_id INTEGER NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_key TEXT NOT NULL,
    thumbnail_key TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachments_msg_idx ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS attachments_uploader_idx ON attachments(uploader_user_id);

  -- v2: message mentions
  CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    mentioned_user_id INTEGER REFERENCES users(id),
    type TEXT NOT NULL DEFAULT 'user',
    PRIMARY KEY (message_id, mentioned_user_id, type)
  );
  CREATE INDEX IF NOT EXISTS mentions_msg_idx ON message_mentions(message_id);
  CREATE INDEX IF NOT EXISTS mentions_user_idx ON message_mentions(mentioned_user_id);

  -- v2: recordings
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    started_by_user_id INTEGER NOT NULL REFERENCES users(id),
    egress_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    duration_seconds INTEGER,
    storage_url TEXT,
    storage_key TEXT,
    file_size_bytes INTEGER,
    status TEXT NOT NULL DEFAULT 'recording'
  );
  CREATE INDEX IF NOT EXISTS recordings_channel_idx ON recordings(channel_id);

  -- v2: expo push tokens
  CREATE TABLE IF NOT EXISTS expo_push_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token TEXT NOT NULL UNIQUE,
    device_label TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS expo_tokens_user_idx ON expo_push_tokens(user_id);

  -- v3: direct (1:1) calls — ringing, accepted, ended, missed.
  -- One row per call attempt. roomName is the LiveKit room both peers join.
  CREATE TABLE IF NOT EXISTS direct_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    caller_id INTEGER NOT NULL REFERENCES users(id),
    callee_id INTEGER NOT NULL REFERENCES users(id),
    room_name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'voice',
    status TEXT NOT NULL DEFAULT 'ringing',
    started_at INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS direct_calls_caller_idx ON direct_calls(caller_id);
  CREATE INDEX IF NOT EXISTS direct_calls_callee_idx ON direct_calls(callee_id);
  CREATE INDEX IF NOT EXISTS direct_calls_status_idx ON direct_calls(status);

  -- v2: org settings (deactivated users)
  -- Add 'deactivated' column to users via ALTER if it doesn't exist
  `);

  // Idempotent column add for users.deactivated
  try {
    const cols = rawDb.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    if (!cols.find(c => c.name === "deactivated")) {
      rawDb.exec(`ALTER TABLE users ADD COLUMN deactivated INTEGER NOT NULL DEFAULT 0;`);
      console.log("[migrate] Added users.deactivated column");
    }
  } catch (e) {
    console.warn("[migrate] users.deactivated add skipped:", e);
  }

  // v4: channel scopes — global / entity / team / private.
  // Idempotent column adds + channel_members table.
  try {
    const cols = rawDb.prepare(`PRAGMA table_info(channels)`).all() as Array<{ name: string }>;
    const have = new Set(cols.map(c => c.name));
    if (!have.has("scope")) {
      rawDb.exec(`ALTER TABLE channels ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';`);
      console.log("[migrate] Added channels.scope column");
    }
    if (!have.has("entity_id")) {
      rawDb.exec(`ALTER TABLE channels ADD COLUMN entity_id TEXT;`);
      console.log("[migrate] Added channels.entity_id column");
    }
    if (!have.has("team_role")) {
      rawDb.exec(`ALTER TABLE channels ADD COLUMN team_role TEXT;`);
      console.log("[migrate] Added channels.team_role column");
    }
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS channel_members_user_idx ON channel_members(user_id);
    `);
  } catch (e) {
    console.warn("[migrate] channel scopes setup skipped:", e);
  }

  // FTS5 for messages — virtual table + sync triggers
  try {
    rawDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        message_id UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `);
    // Triggers: keep FTS in sync with messages
    rawDb.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, message_id) VALUES (new.id, new.content, new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.id;
        INSERT INTO messages_fts(rowid, content, message_id) VALUES (new.id, new.content, new.id);
      END;
    `);
    // Backfill FTS once if empty
    const ftsCount = (rawDb.prepare(`SELECT count(*) AS c FROM messages_fts`).get() as { c: number })?.c ?? 0;
    const msgCount = (rawDb.prepare(`SELECT count(*) AS c FROM messages`).get() as { c: number })?.c ?? 0;
    if (ftsCount === 0 && msgCount > 0) {
      rawDb.exec(`INSERT INTO messages_fts(rowid, content, message_id) SELECT id, content, id FROM messages;`);
      console.log(`[migrate] Backfilled ${msgCount} messages into FTS`);
    }
  } catch (e) {
    console.warn("[migrate] FTS5 setup skipped:", e);
  }

  // v5: phone column on users — for Twilio SIP dial-out invites. Synced
  // from bulldog-auth during the SSO bridge.
  try {
    const cols = rawDb.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    const have = new Set(cols.map(c => c.name));
    if (!have.has("phone")) {
      rawDb.exec(`ALTER TABLE users ADD COLUMN phone TEXT;`);
      console.log("[migrate] Added users.phone column");
    }
  } catch (e) {
    console.warn("[migrate] users.phone add skipped:", e);
  }

  // v6: Work Objects (Phase 1 of the post-call-polish roadmap). Idempotent.
  // We index (org_id, kind, ref) so /object BOE-FIBER-01 lookups are fast,
  // and (org_id, kind, status) so the right-rail "active by kind" queries
  // don't full-scan. Closed objects stay queryable but drop out of default
  // lists via WHERE status != 'closed'.
  rawDb.exec(`
  CREATE TABLE IF NOT EXISTS work_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    description TEXT,
    parent_id INTEGER,
    owner_user_id INTEGER REFERENCES users(id),
    attributes TEXT,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS work_objects_org_kind_ref_idx
    ON work_objects(org_id, kind, ref);
  CREATE INDEX IF NOT EXISTS work_objects_org_kind_status_idx
    ON work_objects(org_id, kind, status);
  CREATE INDEX IF NOT EXISTS work_objects_parent_idx
    ON work_objects(parent_id);

  CREATE TABLE IF NOT EXISTS work_object_channel_links (
    work_object_id INTEGER NOT NULL REFERENCES work_objects(id),
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    link_type TEXT NOT NULL DEFAULT 'primary',
    linked_at INTEGER NOT NULL,
    linked_by_user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (work_object_id, channel_id)
  );
  CREATE INDEX IF NOT EXISTS wocl_channel_idx ON work_object_channel_links(channel_id);
  CREATE INDEX IF NOT EXISTS wocl_obj_idx ON work_object_channel_links(work_object_id);

  CREATE TABLE IF NOT EXISTS work_object_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_object_id INTEGER NOT NULL REFERENCES work_objects(id),
    type TEXT NOT NULL,
    actor_user_id INTEGER REFERENCES users(id),
    payload TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS woa_obj_idx ON work_object_activity(work_object_id, created_at);
  `);

  // v7: messages.meta JSON column for system messages (work-object events,
  // call summaries, channel-creation banners, etc). Null for normal user
  // messages — the frontend treats meta.system=true as a render switch.
  try {
    const cols = rawDb.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    const have = new Set(cols.map(c => c.name));
    if (!have.has("meta")) {
      rawDb.exec(`ALTER TABLE messages ADD COLUMN meta TEXT;`);
      console.log("[migrate] Added messages.meta column");
    }
  } catch (e) {
    console.warn("[migrate] messages.meta add skipped:", e);
  }

  // v8: Companies model — repurpose the existing `projects` table as
  // "companies" (Path B from the Phase 1.8 design). Add nullable columns
  // that nest channels under jobs and scope jobs to a company. Seed the
  // three companies (VFD / VS / VTS) idempotently and backfill ownership
  // of existing rows to VFD.
  try {
    // Channels: optional work_object_id so we can nest channels under a job.
    const chCols = rawDb.prepare(`PRAGMA table_info(channels)`).all() as Array<{ name: string }>;
    if (!chCols.find(c => c.name === "work_object_id")) {
      rawDb.exec(`ALTER TABLE channels ADD COLUMN work_object_id INTEGER;`);
      rawDb.exec(`CREATE INDEX IF NOT EXISTS channels_work_object_idx ON channels(work_object_id);`);
      console.log("[migrate] Added channels.work_object_id column");
    }
    // Work objects: project_id (= company id). Nullable for backward compat,
    // backfilled to VFD below. Indexed for the company-scoped Jobs list.
    const woCols = rawDb.prepare(`PRAGMA table_info(work_objects)`).all() as Array<{ name: string }>;
    if (!woCols.find(c => c.name === "project_id")) {
      rawDb.exec(`ALTER TABLE work_objects ADD COLUMN project_id INTEGER;`);
      rawDb.exec(`CREATE INDEX IF NOT EXISTS work_objects_project_idx ON work_objects(project_id);`);
      console.log("[migrate] Added work_objects.project_id column");
    }
  } catch (e) {
    console.warn("[migrate] v8 column adds skipped:", e);
  }

  // v8: Seed companies + backfill ownership. Idempotent.
  // Naming map: there are several legacy seed names — we pick the first project
  // for the org and rename it VFD. Then ensure VS and VTS exist alongside it.
  try {
    const orgs = rawDb.prepare(`SELECT id FROM organizations ORDER BY id`).all() as Array<{ id: number }>;
    for (const org of orgs) {
      // Look up the three target companies by slug.
      const findBySlug = (slug: string) =>
        rawDb.prepare(`SELECT id, name FROM projects WHERE org_id = ? AND slug = ?`).get(org.id, slug) as { id: number; name: string } | undefined;

      let vfd = findBySlug("vfd");
      let vs = findBySlug("vs");
      let vts = findBySlug("vts");

      // If VFD isn't present yet, promote the lowest-id existing project to VFD
      // so all existing channels (which point at that project_id) stay linked.
      if (!vfd) {
        const existing = rawDb.prepare(`SELECT id, name FROM projects WHERE org_id = ? ORDER BY id ASC LIMIT 1`).get(org.id) as { id: number; name: string } | undefined;
        if (existing) {
          rawDb.prepare(`UPDATE projects SET name = ?, slug = ?, short = ?, hue = ?, description = ? WHERE id = ?`).run(
            "Vector Force Development", "vfd", "VFD", 212,
            "Utility construction — CCTV, hydrovac, traffic control.", existing.id,
          );
          vfd = { id: existing.id, name: "Vector Force Development" };
          console.log(`[migrate] Renamed project ${existing.id} (${existing.name}) → Vector Force Development (VFD)`);
        } else {
          // Brand-new org with no projects yet — create VFD from scratch.
          const now = Date.now();
          rawDb.prepare(`INSERT INTO projects (org_id, name, slug, short, hue, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            org.id, "Vector Force Development", "vfd", "VFD", 212,
            "Utility construction — CCTV, hydrovac, traffic control.", now,
          );
          vfd = findBySlug("vfd")!;
          console.log(`[migrate] Created VFD company for org ${org.id}`);
        }
      }

      const now = Date.now();
      if (!vs) {
        rawDb.prepare(`INSERT INTO projects (org_id, name, slug, short, hue, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          org.id, "Vector Services", "vs", "VS", 2,
          "Service company — fleet, dispatch, response.", now,
        );
        vs = findBySlug("vs")!;
        console.log(`[migrate] Created VS company for org ${org.id}`);
      }
      if (!vts) {
        rawDb.prepare(`INSERT INTO projects (org_id, name, slug, short, hue, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          org.id, "Vector Talent Solutions", "vts", "VTS", 175,
          "Talent and staffing — sourcing, placement, training.", now,
        );
        vts = findBySlug("vts")!;
        console.log(`[migrate] Created VTS company for org ${org.id}`);
      }

      // Remove any stale extra projects (legacy seed data: lakewood-substation,
      // i-405-fiber, etc.) by re-homing their channels to VFD and dropping the
      // project. We delete project_members rows for the stale projects first.
      const stale = rawDb.prepare(`SELECT id, slug FROM projects WHERE org_id = ? AND slug NOT IN ('vfd','vs','vts')`).all(org.id) as Array<{ id: number; slug: string }>;
      for (const s of stale) {
        rawDb.prepare(`UPDATE channels SET project_id = ? WHERE project_id = ?`).run(vfd.id, s.id);
        rawDb.prepare(`DELETE FROM project_members WHERE project_id = ?`).run(s.id);
        rawDb.prepare(`DELETE FROM invites WHERE project_id = ?`).run(s.id);
        rawDb.prepare(`DELETE FROM projects WHERE id = ?`).run(s.id);
        console.log(`[migrate] Re-homed channels from stale project ${s.slug} (${s.id}) → VFD, then deleted.`);
      }

      // Backfill: every existing work_object in the org gets pinned to VFD.
      rawDb.prepare(`UPDATE work_objects SET project_id = ? WHERE org_id = ? AND project_id IS NULL`).run(vfd.id, org.id);

      // Membership: ALL users in the org are members of all three companies
      // by default. Per user direction: Cade and Holli are VFD-only; everyone
      // else (admins) gets all three. Idempotent inserts — OR IGNORE on PK.
      const orgUsers = rawDb.prepare(`SELECT id, email, role FROM users WHERE org_id = ?`).all(org.id) as Array<{ id: number; email: string; role: string }>;
      const VFD_ONLY_EMAILS = new Set(["cade@vectorfd.com", "holli@vectorfd.com"]);
      const memInsert = rawDb.prepare(`INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`);
      for (const u of orgUsers) {
        // Everyone is in VFD.
        memInsert.run(vfd.id, u.id, "member");
        // Admins and foremen also get VS + VTS (unless explicitly VFD-only).
        const vfdOnly = VFD_ONLY_EMAILS.has(u.email.toLowerCase());
        if (!vfdOnly && (u.role === "admin" || u.role === "foreman")) {
          memInsert.run(vs.id, u.id, "member");
          memInsert.run(vts.id, u.id, "member");
        }
      }
      console.log(`[migrate] Seeded company memberships for ${orgUsers.length} users in org ${org.id}`);
    }
  } catch (e) {
    console.warn("[migrate] v8 company seed skipped:", e);
  }

  // Admin email rebrand: if prod has the old email, migrate it.
  try {
    const oldRow = rawDb.prepare(`SELECT id FROM users WHERE email = ?`).get("admin@vectorservicesus.com") as { id: number } | undefined;
    const newRow = rawDb.prepare(`SELECT id FROM users WHERE email = ?`).get("chat@bulldogops.com") as { id: number } | undefined;
    if (oldRow && !newRow) {
      rawDb.prepare(`UPDATE users SET email = ? WHERE id = ?`).run("chat@bulldogops.com", oldRow.id);
      console.log(`[migrate] Migrated admin email: admin@vectorservicesus.com → chat@bulldogops.com (user id=${oldRow.id})`);
    }
  } catch (e) {
    console.warn("[migrate] admin email rebrand skipped:", e);
  }

  // v9: Dedupe channels per company. The v8 backfill re-homed channels from
  // legacy seed projects (lakewood-substation, i-405-fiber, hq-all-hands,
  // etc.) into VFD without deduping, so VFD now shows 8x #general, 8x
  // #announcements, 4x #field-ops. For each (project_id, name, work_object_id)
  // group with multiple rows, we keep the lowest-id channel as canonical and
  // re-point all FK refs from the duplicates to it, then delete the dupes.
  //
  // Only collapse GLOBAL channels (work_object_id IS NULL) — channels nested
  // under a specific job are legitimately scoped and shouldn't merge with
  // unrelated globals. Idempotent: re-running finds no dupes and is a no-op.
  try {
    const dupeGroups = rawDb.prepare(`
      SELECT project_id, name, COUNT(*) as cnt, MIN(id) as keeper
      FROM channels
      WHERE work_object_id IS NULL
      GROUP BY project_id, name
      HAVING COUNT(*) > 1
    `).all() as Array<{ project_id: number; name: string; cnt: number; keeper: number }>;

    if (dupeGroups.length > 0) {
      const tx = rawDb.transaction(() => {
        for (const g of dupeGroups) {
          const dupes = rawDb.prepare(`
            SELECT id FROM channels
            WHERE project_id = ? AND name = ? AND work_object_id IS NULL AND id != ?
          `).all(g.project_id, g.name, g.keeper) as Array<{ id: number }>;

          // Per-statement try/catch so a missing optional table (older DB)
          // doesn't sink the whole dedupe. Required tables: messages,
          // read_receipts, channel_members, channels. Optional: recordings,
          // livekit_rooms, work_object_channel_links.
          const safeRun = (sql: string, ...params: any[]) => {
            try { rawDb.prepare(sql).run(...params); } catch (e: any) {
              if (!/no such table/i.test(String(e?.message))) throw e;
            }
          };
          for (const d of dupes) {
            rawDb.prepare(`UPDATE messages SET channel_id = ? WHERE channel_id = ?`).run(g.keeper, d.id);
            rawDb.prepare(`UPDATE read_receipts SET channel_id = ? WHERE channel_id = ?`).run(g.keeper, d.id);
            safeRun(`UPDATE recordings SET channel_id = ? WHERE channel_id = ?`, g.keeper, d.id);
            safeRun(`UPDATE livekit_rooms SET channel_id = ? WHERE channel_id = ?`, g.keeper, d.id);

            // channel_members has (channel_id, user_id) as composite PK.
            rawDb.prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id) SELECT ?, user_id FROM channel_members WHERE channel_id = ?`).run(g.keeper, d.id);
            rawDb.prepare(`DELETE FROM channel_members WHERE channel_id = ?`).run(d.id);

            // work_object_channel_links: composite (work_object_id, channel_id) PK.
            safeRun(`INSERT OR IGNORE INTO work_object_channel_links (work_object_id, channel_id) SELECT work_object_id, ? FROM work_object_channel_links WHERE channel_id = ?`, g.keeper, d.id);
            safeRun(`DELETE FROM work_object_channel_links WHERE channel_id = ?`, d.id);

            // Finally, drop the duplicate channel.
            rawDb.prepare(`DELETE FROM channels WHERE id = ?`).run(d.id);
          }
          console.log(`[migrate] v9 deduped #${g.name} in project ${g.project_id}: kept id=${g.keeper}, removed ${dupes.length} duplicate(s)`);
        }
      });
      tx();
      console.log(`[migrate] v9 channel dedupe: collapsed ${dupeGroups.length} duplicate group(s)`);
    }
  } catch (e) {
    console.warn("[migrate] v9 channel dedupe skipped:", e);
  }

  // v10: Seed demo jobs + nested channels for VFD so the Company → Job →
  // Channel hierarchy is visible. Only runs if VFD has zero jobs (so it
  // never clobbers real customer data). Idempotent.
  try {
    const orgs = rawDb.prepare(`SELECT id FROM organizations ORDER BY id`).all() as Array<{ id: number }>;
    for (const org of orgs) {
      const vfd = rawDb.prepare(`SELECT id FROM projects WHERE org_id = ? AND slug = 'vfd'`).get(org.id) as { id: number } | undefined;
      if (!vfd) continue;

      // Guard: only seed demo jobs if VFD has no jobs that already host
      // nested channels. We want the Company → Job → Channel hierarchy to
      // be visible, and a real job with no nested channels still leaves
      // the sidebar looking flat. This is idempotent: once any job has a
      // nested channel (demo or real), this block stops running.
      const nestedJobCount = (rawDb.prepare(`
        SELECT COUNT(DISTINCT wo.id) as n
        FROM work_objects wo
        JOIN channels c ON c.work_object_id = wo.id
        WHERE wo.project_id = ?
      `).get(vfd.id) as { n: number }).n;
      if (nestedJobCount > 0) continue;

      // Pick an admin user as creator. Falls back to first user in org.
      const admin = rawDb.prepare(`SELECT id FROM users WHERE org_id = ? AND role = 'admin' ORDER BY id LIMIT 1`).get(org.id) as { id: number } | undefined
        ?? rawDb.prepare(`SELECT id FROM users WHERE org_id = ? ORDER BY id LIMIT 1`).get(org.id) as { id: number } | undefined;
      if (!admin) continue;

      const now = Date.now();
      const demoJobs = [
        { ref: "DEMO-LAKEWOOD-01", title: "Lakewood Substation Rebuild", kind: "job_site", channels: ["site-updates", "safety-tailgate"] },
        { ref: "DEMO-I405-02",     title: "I-405 Fiber Pull",            kind: "job_site", channels: ["crew-coord", "locates"] },
        { ref: "DEMO-BOE-03",      title: "Boeing Field Hydrovac",       kind: "job_site", channels: ["day-of", "equipment"] },
      ];

      const insertJob = rawDb.prepare(`
        INSERT INTO work_objects (org_id, project_id, kind, ref, title, status, attributes, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `);
      // Channel position offset: put nested channels after the existing 10 globals.
      let posCounter = 100;
      const insertChannel = rawDb.prepare(`
        INSERT INTO channels (project_id, work_object_id, name, type, topic, position, scope, created_at)
        VALUES (?, ?, ?, 'text', ?, ?, 'global', ?)
      `);

      for (const j of demoJobs) {
        const jobRes = insertJob.run(org.id, vfd.id, j.kind, j.ref, j.title, "{}", admin.id, now, now);
        const jobId = Number(jobRes.lastInsertRowid);
        for (const chName of j.channels) {
          insertChannel.run(vfd.id, jobId, chName, `${j.title} — ${chName}`, posCounter++, now);
        }
        console.log(`[migrate] v10 seeded demo job ${j.ref} (id=${jobId}) with ${j.channels.length} nested channels`);
      }
      console.log(`[migrate] v10 demo data seeded for VFD (project ${vfd.id})`);
    }
  } catch (e) {
    console.warn("[migrate] v10 demo seed skipped:", e);
  }

  // v11: Retroactive "Bulldog - " prefix on existing user.name. Phase 1.9 ships
  // the prefix at create time (storage.createUser), but pre-existing rows still
  // show as bare "Josh Bieler" / "Cade Bieler" etc. One-shot UPDATE that skips
  // rows already prefixed so it's idempotent across redeploys.
  try {
    const info = rawDb.prepare(
      "UPDATE users SET name = 'Bulldog - ' || name WHERE name NOT LIKE 'Bulldog - %'",
    ).run();
    if (info.changes && info.changes > 0) {
      console.log(`[migrate] v11 prefixed ${info.changes} existing user.name rows with "Bulldog - "`);
    }
  } catch (e) {
    console.warn("[migrate] v11 user name prefix skipped:", e);
  }

  // v12: Presence column on users. Phase 1.9 adds an explicit presence state
  // (online/away/busy/offline) separate from the legacy "status" string so we
  // can drive the top-bar status dot and DND push gating. Default 'online' for
  // existing rows.
  try {
    const cols = rawDb.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const hasPresence = cols.some(c => c.name === "presence");
    if (!hasPresence) {
      rawDb.exec("ALTER TABLE users ADD COLUMN presence TEXT NOT NULL DEFAULT 'online'");
      console.log("[migrate] v12 added users.presence column (default 'online')");
    }
  } catch (e) {
    console.warn("[migrate] v12 presence column skipped:", e);
  }

  // v13: Strip the "Bulldog - " display prefix Phase 1.9 baked into every
  // user.name row. Phase 1.9.1 walks it back — the Bulldog brand now only
  // shows on outbound SIP caller-id, not in front of every in-app user.
  // Idempotent: only touches rows that still have the prefix.
  try {
    const info = rawDb.prepare(
      "UPDATE users SET name = substr(name, 11) WHERE name LIKE 'Bulldog - %'",
    ).run();
    if (info.changes && info.changes > 0) {
      console.log(`[migrate] v13 stripped "Bulldog - " prefix from ${info.changes} user.name rows`);
    }
  } catch (e) {
    console.warn("[migrate] v13 user name unprefix skipped:", e);
  }

  // v14: Soft-delete columns on messages. Phase 1.9.1 lets authors (and
  // admins) delete messages, leaving a "Message deleted" tombstone in place
  // so reply threading and audit history stay intact. Idempotent.
  try {
    const cols = rawDb.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    const hasDeletedAt = cols.some(c => c.name === "deleted_at");
    const hasDeletedBy = cols.some(c => c.name === "deleted_by_user_id");
    if (!hasDeletedAt) {
      rawDb.exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
      console.log("[migrate] v14 added messages.deleted_at column");
    }
    if (!hasDeletedBy) {
      rawDb.exec("ALTER TABLE messages ADD COLUMN deleted_by_user_id INTEGER");
      console.log("[migrate] v14 added messages.deleted_by_user_id column");
    }
  } catch (e) {
    console.warn("[migrate] v14 message soft-delete columns skipped:", e);
  }

  // v15: Scheduled calls. Phase 1.9.1 introduces calendar-style call
  // scheduling with SMS + ICS invites and RSVP tracking. Two tables —
  // scheduled_calls (one row per meeting) and scheduled_call_invitees
  // (one row per invitee, carrying RSVP state). Idempotent: skip if
  // tables already exist.
  try {
    const rows = rawDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scheduled_calls','scheduled_call_invitees')",
    ).all() as Array<{ name: string }>;
    const have = new Set(rows.map((r) => r.name));
    if (!have.has("scheduled_calls")) {
      rawDb.exec(`
        CREATE TABLE scheduled_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id INTEGER NOT NULL REFERENCES organizations(id),
          channel_id INTEGER REFERENCES channels(id),
          organizer_id INTEGER NOT NULL REFERENCES users(id),
          title TEXT NOT NULL,
          notes TEXT,
          kind TEXT NOT NULL DEFAULT 'video',
          start_at INTEGER NOT NULL,
          end_at INTEGER NOT NULL,
          room_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled',
          reminder_sent_at INTEGER,
          ics_sequence INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      rawDb.exec("CREATE INDEX idx_scheduled_calls_org_start ON scheduled_calls(org_id, start_at)");
      rawDb.exec("CREATE INDEX idx_scheduled_calls_status_start ON scheduled_calls(status, start_at)");
      console.log("[migrate] v15 created scheduled_calls table");
    }
    if (!have.has("scheduled_call_invitees")) {
      rawDb.exec(`
        CREATE TABLE scheduled_call_invitees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scheduled_call_id INTEGER NOT NULL REFERENCES scheduled_calls(id),
          user_id INTEGER REFERENCES users(id),
          external_phone TEXT,
          external_email TEXT,
          rsvp_code TEXT NOT NULL,
          response TEXT NOT NULL DEFAULT 'pending',
          responded_at INTEGER,
          response_channel TEXT,
          invite_sent_at INTEGER,
          invite_error TEXT,
          reminder_sent_at INTEGER
        )
      `);
      rawDb.exec("CREATE INDEX idx_sci_call ON scheduled_call_invitees(scheduled_call_id)");
      rawDb.exec("CREATE INDEX idx_sci_code ON scheduled_call_invitees(rsvp_code)");
      rawDb.exec("CREATE INDEX idx_sci_user ON scheduled_call_invitees(user_id)");
      console.log("[migrate] v15 created scheduled_call_invitees table");
    }
  } catch (e) {
    console.warn("[migrate] v15 scheduled-calls tables skipped:", e);
  }

  // v16 (Phase 1.9.3) — add channels.linked_contract for the
  // contract-linked-channel feature. Stored as JSON text. Nullable so all
  // existing channels remain valid.
  try {
    const chCols = rawDb.prepare(`PRAGMA table_info(channels)`).all() as Array<{ name: string }>;
    if (!chCols.find(c => c.name === "linked_contract")) {
      rawDb.exec(`ALTER TABLE channels ADD COLUMN linked_contract TEXT;`);
      console.log("[migrate] v16 added channels.linked_contract column");
    }
  } catch (e) {
    console.warn("[migrate] v16 channels.linked_contract add skipped:", e);
  }

  // v17 (Phase 1.9.4) — AI clerk meeting notes. One row per clerk session.
  // Lifecycle: 'recording' → 'transcribing' → 'summarizing' → 'uploaded' /
  // 'failed'. Transcript is appended-to as Deepgram streams deltas. PDF is
  // rendered once at the end and pushed to Synology.
  try {
    const tables = rawDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='meeting_notes'"
    ).all() as Array<{ name: string }>;
    if (tables.length === 0) {
      rawDb.exec(`
        CREATE TABLE meeting_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          started_by_user_id INTEGER NOT NULL REFERENCES users(id),
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          status TEXT NOT NULL DEFAULT 'recording',
          title TEXT,
          transcript_text TEXT NOT NULL DEFAULT '',
          summary_text TEXT,
          attendees_json TEXT,
          synology_remote_path TEXT,
          synology_status TEXT,
          synology_reason TEXT,
          pdf_size_bytes INTEGER,
          duration_seconds INTEGER,
          deepgram_session_id TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );
      `);
      rawDb.exec("CREATE INDEX idx_meeting_notes_channel ON meeting_notes(channel_id)");
      rawDb.exec("CREATE INDEX idx_meeting_notes_status ON meeting_notes(status)");
      console.log("[migrate] v17 created meeting_notes table");
    }
  } catch (e) {
    console.warn("[migrate] v17 meeting_notes skipped:", e);
  }

  // v18 (Phase 1.9.5) — two new per-invitee reminder columns for 15-min and
  // at-start push notifications. Keep existing reminder_sent_at for back-compat
  // (external-phone-only invitees still use it for the legacy SMS reminder).
  try {
    const sciCols = rawDb.prepare(`PRAGMA table_info(scheduled_call_invitees)`).all() as Array<{ name: string }>;
    if (!sciCols.find(c => c.name === "reminder_15_at")) {
      rawDb.exec(`ALTER TABLE scheduled_call_invitees ADD COLUMN reminder_15_at INTEGER;`);
      console.log("[migrate] v18 added scheduled_call_invitees.reminder_15_at");
    }
    if (!sciCols.find(c => c.name === "reminder_start_at")) {
      rawDb.exec(`ALTER TABLE scheduled_call_invitees ADD COLUMN reminder_start_at INTEGER;`);
      console.log("[migrate] v18 added scheduled_call_invitees.reminder_start_at");
    }
  } catch (e) {
    console.warn("[migrate] v18 reminder columns skipped:", e);
  }

  // v19 (Phase 1.9.7) — clean orphan scheduled-call cards. When a scheduled
  // call is deleted, its in-channel system-message cards should be removed too
  // (see scheduled-calls.ts DELETE handler), but older rows / failed deletes
  // can leave cards whose meta.scheduledCallId no longer resolves to a live
  // scheduled_calls row. Sweep them on startup. Idempotent: once cleaned, the
  // SELECT returns nothing and this is a no-op.
  try {
    const orphans = rawDb.prepare(
      `SELECT id FROM messages
       WHERE meta LIKE '%"scheduledCallId":%'
         AND CAST(json_extract(meta, '$.scheduledCallId') AS INTEGER)
             NOT IN (SELECT id FROM scheduled_calls)`,
    ).all() as Array<{ id: number }>;
    if (orphans.length > 0) {
      const ids = orphans.map((o) => o.id);
      const tx = rawDb.transaction(() => {
        const placeholders = ids.map(() => "?").join(",");
        rawDb.prepare(`DELETE FROM message_mentions WHERE message_id IN (${placeholders})`).run(...ids);
        rawDb.prepare(`DELETE FROM reactions WHERE message_id IN (${placeholders})`).run(...ids);
        rawDb.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
      });
      tx();
    }
    console.log(`[migrate v19] cleaned ${orphans.length} orphan scheduled-call cards`);
  } catch (e) {
    console.warn("[migrate] v19 orphan card cleanup skipped:", e);
  }

  // v20 (Phase 1.9.8) — broaden the orphan-card sweep. v19 only removed cards
  // whose scheduled_calls row is gone. This also removes cards that point at a
  // call which still exists but is cancelled/deleted (stale cards left when an
  // older delete path only flipped status instead of removing the card).
  // Idempotent: once cleaned the SELECT returns nothing.
  try {
    const stale = rawDb.prepare(
      `SELECT id FROM messages
       WHERE meta LIKE '%"scheduledCallId":%'
         AND CAST(json_extract(meta, '$.scheduledCallId') AS INTEGER) IN (
           SELECT id FROM scheduled_calls WHERE status IN ('cancelled','deleted')
         )`,
    ).all() as Array<{ id: number }>;
    // Also re-sweep true orphans (missing row), same as v19 — covers anything
    // created between v19 running and now.
    const orphaned = rawDb.prepare(
      `SELECT id FROM messages
       WHERE meta LIKE '%"scheduledCallId":%'
         AND CAST(json_extract(meta, '$.scheduledCallId') AS INTEGER)
             NOT IN (SELECT id FROM scheduled_calls)`,
    ).all() as Array<{ id: number }>;
    const ids = Array.from(new Set([...stale, ...orphaned].map((o) => o.id)));
    if (ids.length > 0) {
      const tx = rawDb.transaction(() => {
        const placeholders = ids.map(() => "?").join(",");
        rawDb.prepare(`DELETE FROM message_mentions WHERE message_id IN (${placeholders})`).run(...ids);
        rawDb.prepare(`DELETE FROM reactions WHERE message_id IN (${placeholders})`).run(...ids);
        rawDb.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
      });
      tx();
    }
    console.log(`[migrate v20] cleaned ${ids.length} stale/orphan scheduled-call cards`);
  } catch (e) {
    console.warn("[migrate] v20 stale card cleanup skipped:", e);
  }

  // v21 (Phase 1.9.10) — contracts subdomain rename. The old
  // contracts.bulldogops.com host never existed in DNS (NXDOMAIN); the real
  // prod host is vectorcontracts.bulldogops.com. Rewrite every stored URL.
  // Idempotent: once rewritten the LIKE filter matches nothing.
  try {
    const newHost = "vectorcontracts.bulldogops.com";
    // Match contracts.bulldogops.com only when NOT already prefixed by
    // "vector" — without this guard, rewriting an already-correct
    // vectorcontracts.bulldogops.com would produce vectorvectorcontracts...
    // The negative lookbehind keeps the migration idempotent.
    const re = /(?<!vector)contracts\.bulldogops\.com/g;

    // 1. channels.linked_contract (JSON string) — replace inside the JSON blob.
    const channelsToFix = rawDb.prepare(
      "SELECT id, linked_contract FROM channels WHERE linked_contract IS NOT NULL AND linked_contract LIKE ?"
    ).all(`%contracts.bulldogops.com%`) as Array<{ id: number; linked_contract: string }>;
    let channelsUpdated = 0;
    for (const ch of channelsToFix) {
      const newLc = ch.linked_contract.replace(re, newHost);
      if (newLc === ch.linked_contract) continue; // only vectorcontracts already — skip
      rawDb.prepare("UPDATE channels SET linked_contract = ? WHERE id = ?").run(newLc, ch.id);
      channelsUpdated++;
    }

    // 2. messages.meta — contract system cards store appUrl/pdfUrl in meta.
    const messagesToFix = rawDb.prepare(
      "SELECT id, meta FROM messages WHERE meta IS NOT NULL AND meta LIKE ?"
    ).all(`%contracts.bulldogops.com%`) as Array<{ id: number; meta: string }>;
    let messagesUpdated = 0;
    for (const m of messagesToFix) {
      const newMeta = m.meta.replace(re, newHost);
      if (newMeta === m.meta) continue; // only vectorcontracts already — skip
      rawDb.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(newMeta, m.id);
      messagesUpdated++;
    }

    console.log(`[migrate v21] contracts URL backfill: channels=${channelsUpdated} messages=${messagesUpdated}`);
  } catch (e: any) {
    console.warn("[migrate v21] error:", e?.message);
  }

  // v23 (Phase 1.9.23) — meeting_notes: add room_name and participant_user_ids_json
  // columns so the clerk can track actual call participants rather than channel
  // roster. room_name ties the note to a LiveKit room; participant_user_ids_json
  // is a JSON array of user IDs polled during the call.
  try {
    const mnCols = rawDb.prepare(`PRAGMA table_info(meeting_notes)`).all() as Array<{ name: string }>;
    const mnHave = new Set(mnCols.map(c => c.name));
    if (!mnHave.has("room_name")) {
      rawDb.exec(`ALTER TABLE meeting_notes ADD COLUMN room_name TEXT;`);
      console.log("[migrate] v23 added meeting_notes.room_name column");
    }
    if (!mnHave.has("participant_user_ids_json")) {
      rawDb.exec(`ALTER TABLE meeting_notes ADD COLUMN participant_user_ids_json TEXT;`);
      console.log("[migrate] v23 added meeting_notes.participant_user_ids_json column");
    }
  } catch (e) {
    console.warn("[migrate] v23 meeting_notes columns skipped:", e);
  }

  // v22 (Phase 1.9.13) — the contracts SPA uses hash-based routing
  // (wouter useHashLocation), so real deep links are
  // https://vectorcontracts.bulldogops.com/#/contracts/N. Chat previously
  // stored the bare /contracts/N form, which boots the SPA at empty hash and
  // renders the wrong route. Rewrite stored URLs to the hash form.
  // Idempotent: the negative lookbehind preserves an already-rewritten
  // /#/contracts/ and only touches a bare /contracts/ after the domain.
  try {
    // Only rewrite within the vectorcontracts host; the lookbehind ensures
    // /#/contracts/ is left intact so re-running v22 cannot double-apply.
    const re = /(?<!\/#)\/contracts\//g;
    const rewrite = (s: string): string => {
      if (!s.includes("vectorcontracts.bulldogops.com")) return s;
      return s.replace(re, "/#/contracts/");
    };

    // 1. channels.linked_contract (JSON string).
    const channelsToFix = rawDb.prepare(
      "SELECT id, linked_contract FROM channels WHERE linked_contract IS NOT NULL AND linked_contract LIKE ?"
    ).all(`%vectorcontracts.bulldogops.com/contracts/%`) as Array<{ id: number; linked_contract: string }>;
    let channelsUpdated = 0;
    for (const ch of channelsToFix) {
      const next = rewrite(ch.linked_contract);
      if (next === ch.linked_contract) continue;
      rawDb.prepare("UPDATE channels SET linked_contract = ? WHERE id = ?").run(next, ch.id);
      channelsUpdated++;
    }
    console.log(`[migrate v22] channels.linked_contract rows updated: ${channelsUpdated}`);

    // 2. messages.meta — contract system cards store appUrl in meta.
    const messagesToFix = rawDb.prepare(
      "SELECT id, meta FROM messages WHERE meta IS NOT NULL AND meta LIKE ?"
    ).all(`%vectorcontracts.bulldogops.com/contracts/%`) as Array<{ id: number; meta: string }>;
    let messagesUpdated = 0;
    for (const m of messagesToFix) {
      const next = rewrite(m.meta);
      if (next === m.meta) continue;
      rawDb.prepare("UPDATE messages SET meta = ? WHERE id = ?").run(next, m.id);
      messagesUpdated++;
    }
    console.log(`[migrate v22] messages.meta rows updated: ${messagesUpdated}`);
  } catch (e: any) {
    console.warn("[migrate v22] error:", e?.message);
  }
}
