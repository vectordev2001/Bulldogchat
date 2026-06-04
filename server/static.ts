import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Long-cache hashed asset bundles (Vite emits content-hashed filenames
  // under /assets/*) but NEVER cache index.html or sw.js — those are the
  // entry points that must always be fresh, otherwise the PWA gets stuck
  // on a stale shell pointing at deleted bundle hashes.
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      const name = path.basename(filePath);
      if (name === "index.html" || name === "sw.js") {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        res.setHeader("Pragma", "no-cache");
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Hashed bundle assets are immutable.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));

  // SPA fallback — always send a fresh index.html, never cached.
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
