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
