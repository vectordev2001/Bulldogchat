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
  `);
}
