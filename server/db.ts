import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function resolveDbPath(): string {
  // DATABASE_URL accepts:
  //   - "file:/absolute/path/to.db"
  //   - "file:./relative/path.db"
  //   - "./relative.db" or "/absolute.db"
  const raw = process.env.DATABASE_URL ?? "./data/vector.db";
  return raw.startsWith("file:") ? raw.slice(5) : raw;
}

const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);
export const rawDb = sqlite;
