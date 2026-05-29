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

      // Discover all uniqueness constraints involving user-FK columns so we can dedupe BEFORE the update.
      // We collect (table, [keyCols]) for: (a) composite primary keys, (b) unique indexes on multi-column sets that include a user FK.
      const dedupeIndexes: Array<{ table: string; keyCols: string[]; userCol: string }> = [];
      for (const t of tables) {
        if (t.name === "users") continue;
        const userColsOnTable = fkColumns.filter(fc => fc.table === t.name).map(fc => fc.column);
        if (userColsOnTable.length === 0) continue;

        // (a) composite primary key
        const cols = rawDb.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string; pk: number }>;
        const pkCols = cols.filter(c => c.pk > 0).map(c => c.name);
        if (pkCols.length >= 2) {
          for (const uc of userColsOnTable) {
            if (pkCols.includes(uc)) dedupeIndexes.push({ table: t.name, keyCols: pkCols, userCol: uc });
          }
        }

        // (b) unique indexes
        const idxs = rawDb.prepare(`PRAGMA index_list(${t.name})`).all() as Array<{ name: string; unique: number }>;
        for (const idx of idxs.filter(x => x.unique === 1)) {
          const idxCols = (rawDb.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>).map(x => x.name);
          if (idxCols.length < 2) continue; // single-column uniques on user_id won't collide for our case (each user appears once anyway)
          for (const uc of userColsOnTable) {
            if (idxCols.includes(uc)) {
              // Skip if same key set already recorded
              if (!dedupeIndexes.some(d => d.table === t.name && d.userCol === uc && d.keyCols.join(',') === idxCols.join(','))) {
                dedupeIndexes.push({ table: t.name, keyCols: idxCols, userCol: uc });
              }
            }
          }
        }
      }

      // 4. Plan: dedupe junction tables, reassign each FK column, then delete users
      const plan: Array<{ table: string; column: string; affected: number; deduped?: number }> = [];
      const tx = rawDb.transaction(() => {
        const placeholders = oldIds.map(() => "?").join(",");

        // Step A: for each uniqueness-constrained table, delete rows where (old user) would duplicate (keep user)'s row
        for (const { table, keyCols, userCol } of dedupeIndexes) {
          const otherKeys = keyCols.filter(k => k !== userCol);
          if (otherKeys.length === 0) continue;
          const otherKeysCsv = otherKeys.join(", ");
          const sql = `DELETE FROM ${table} WHERE ${userCol} IN (${placeholders}) AND (${otherKeysCsv}) IN (SELECT ${otherKeysCsv} FROM ${table} WHERE ${userCol} = ?)`;
          const r = rawDb.prepare(sql).run(...oldIds, keep.id);
          if (r.changes > 0) {
            plan.push({ table, column: userCol, affected: 0, deduped: r.changes });
          }
        }

        for (const { table, column } of fkColumns) {
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
