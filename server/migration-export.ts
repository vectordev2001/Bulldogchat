// TEMPORARY ENDPOINT — REMOVE AFTER MIGRATION TO bulldog-auth
// Returns all users with password hashes, gated by MIGRATION_TOKEN env var.
import type { Express } from "express";
import { rawDb } from "./db";

export function mountMigrationExport(app: Express) {
  app.get("/api/_migration/export-users", (req, res) => {
    const expected = process.env.MIGRATION_TOKEN;
    const provided = req.header("x-migration-token");
    if (!expected || !provided || provided !== expected) {
      return res.status(403).json({ error: "forbidden" });
    }
    try {
      const rows = rawDb.prepare("SELECT * FROM users").all();
      res.json({ app: "chat", count: rows.length, users: rows });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
}
