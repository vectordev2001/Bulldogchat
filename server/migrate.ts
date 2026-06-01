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
}
