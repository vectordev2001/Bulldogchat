// TEMPORARY ENDPOINT — REMOVE AFTER USER CONSOLIDATION
// Reassigns all user-FK columns from "old" user IDs to the "keep" user ID,
// then deletes the "old" users. Gated by MIGRATION_TOKEN env var.
//
// Strategy: introspect the SQLite schema for every FK that references the
// users table, run UPDATE on each, then DELETE FROM users WHERE id IN (...).
// Wrapped in a single transaction so we can roll back on dry run.
import type { Express } from "express";
import { rawDb } from "./db";

interface ConsolidateBody {
  keepEmail: string;          // who owns everything after consolidation
  dryRun?: boolean;
}

export function mountMigrationConsolidate(app: Express) {
  app.post("/api/_migration/consolidate-users", (req, res) => {
    const expected = process.env.MIGRATION_TOKEN;
    const provided = req.header("x-migration-token");
    if (!expected || !provided || provided !== expected) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      const body = (req.body || {}) as ConsolidateBody;
      const dryRun = !!body.dryRun;
      const keepEmail = (body.keepEmail || "").toLowerCase().trim();
      if (!keepEmail) return res.status(400).json({ error: "keepEmail required" });

      // 1. Find the keep user. For chat: the seeded admin is chat@bulldogops.com; rename it to keepEmail first if it doesn't exist yet.
      let keep = rawDb.prepare("SELECT id, email FROM users WHERE lower(email) = ?").get(keepEmail) as { id: number; email: string } | undefined;
      if (!keep) {
        // Try chat's seeded admin
        const seedAdmin = rawDb.prepare("SELECT id, email FROM users WHERE lower(email) = ?").get("chat@bulldogops.com") as { id: number; email: string } | undefined;
        if (seedAdmin) {
          if (!dryRun) rawDb.prepare("UPDATE users SET email = ? WHERE id = ?").run(keepEmail, seedAdmin.id);
          keep = { id: seedAdmin.id, email: keepEmail };
        }
      }
      if (!keep) return res.status(404).json({ error: `keep user not found: ${keepEmail}` });

      // 2. Find all users to remove
      const others = rawDb.prepare("SELECT id, email FROM users WHERE id != ?").all(keep.id) as Array<{ id: number; email: string }>;
      const oldIds = others.map((o) => o.id);

      // 3. Discover all FK columns that reference users(id)
      const tables = rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
      const fkColumns: Array<{ table: string; column: string }> = [];
      for (const t of tables) {
        if (t.name === "users") continue;
        const fks = rawDb.prepare(`PRAGMA foreign_key_list(${t.name})`).all() as Array<{ table: string; from: string; to: string }>;
        for (const fk of fks) {
          if (fk.table === "users") fkColumns.push({ table: t.name, column: fk.from });
        }
      }

      // 4. Plan: reassign each FK column, count rows affected, then delete users
      const plan: Array<{ table: string; column: string; affected: number }> = [];
      const tx = rawDb.transaction(() => {
        for (const { table, column } of fkColumns) {
          const placeholders = oldIds.map(() => "?").join(",");
          const before = rawDb.prepare(
            `SELECT COUNT(*) as c FROM ${table} WHERE ${column} IN (${placeholders})`,
          ).get(...oldIds) as { c: number };
          if (before.c > 0) {
            rawDb.prepare(
              `UPDATE ${table} SET ${column} = ? WHERE ${column} IN (${placeholders})`,
            ).run(keep.id, ...oldIds);
          }
          plan.push({ table, column, affected: before.c });
        }
        if (oldIds.length > 0) {
          const placeholders = oldIds.map(() => "?").join(",");
          rawDb.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...oldIds);
        }
        if (dryRun) {
          throw new Error("__DRY_RUN__");
        }
      });

      try {
        tx();
        res.json({ ok: true, dryRun: false, keep, removed: others, fkPlan: plan });
      } catch (e: any) {
        if (e?.message === "__DRY_RUN__") {
          res.json({ ok: true, dryRun: true, keep, would_remove: others, fkPlan: plan });
        } else {
          throw e;
        }
      }
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e), stack: e?.stack });
    }
  });
}
