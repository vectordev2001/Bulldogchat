// Integration tests for the attachment routes. Runs against a real (temp)
// SQLite DB and the disk storage backend — no mocks — so the multer + sharp +
// storage + DB path is exercised end to end.
//
// Run with:  npx tsx --test server/routes-attachments.test.ts
//
// No test framework is configured in package.json, so this uses Node's built-in
// node:test runner (zero new dependencies) executed through the repo's tsx.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Env must be set before importing modules that read it at import time
// (server/db.ts resolves DATABASE_URL, storage-files.ts reads STORAGE_BACKEND).
const workDir = mkdtempSync(join(tmpdir(), "bulldog-att-"));
process.env.DATABASE_URL = `file:${join(workDir, "test.db")}`;
process.env.JWT_SECRET = "test-secret";
process.env.STORAGE_BACKEND = "disk";
process.env.LOCAL_UPLOAD_ROOT = join(workDir, "uploads");

let server: Server;
let baseUrl: string;
let token: string;

before(async () => {
  const express = (await import("express")).default;
  const { runMigrations } = await import("./migrate");
  const { storage } = await import("./storage");
  const { signJwt, hashPassword } = await import("./auth");
  const { registerV2Routes } = await import("./routes-v2");

  runMigrations();

  const org = storage.createOrg({ name: "Test Org", slug: "test-org" } as any);
  const user = storage.createUser({
    orgId: org.id,
    email: "crew@test.local",
    passwordHash: hashPassword("pw"),
    name: "Crew One",
    role: "admin",
  } as any);
  token = signJwt(user.id);

  const app = express();
  app.use(express.json());
  registerV2Routes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  rmSync(workDir, { recursive: true, force: true });
});

// Build a tiny valid JPEG via sharp so the upload path (rotate/metadata/thumb)
// runs for real.
async function jpegBuffer(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 24, height: 16, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .jpeg()
    .toBuffer();
}

function form(buf: Buffer, filename: string, type: string): FormData {
  const fd = new FormData();
  fd.append("files", new Blob([buf], { type }), filename);
  return fd;
}

test("POST /api/attachments rejects unauthenticated requests", async () => {
  const res = await fetch(`${baseUrl}/api/attachments`, { method: "POST", body: form(Buffer.from("x"), "x.jpg", "image/jpeg") });
  assert.equal(res.status, 401);
});

test("POST /api/attachments rejects disallowed MIME types with 415", async () => {
  const res = await fetch(`${baseUrl}/api/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form(Buffer.from("hello world"), "notes.txt", "text/plain"),
  });
  assert.equal(res.status, 415);
});

test("POST /api/attachments accepts a JPEG and returns an attachment with dimensions", async () => {
  const res = await fetch(`${baseUrl}/api/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form(await jpegBuffer(), "site-map.jpg", "image/jpeg"),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.attachments), "response has attachments array");
  const att = body.attachments[0];
  assert.equal(att.contentType, "image/jpeg");
  assert.equal(att.filename, "site-map.jpg");
  assert.equal(att.width, 24);
  assert.equal(att.height, 16);
  assert.ok(att.thumbnailUrl, "image gets a thumbnail URL");
  assert.ok(att.downloadUrl.startsWith("/api/files/"), "downloadUrl points at /api/files");

  // GET /api/files/:id streams the original back to the uploader.
  const fileRes = await fetch(`${baseUrl}${att.url}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get("content-type"), "image/jpeg");
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  assert.ok(bytes.length > 0, "streamed file has content");

  // Thumbnail variant is served as WebP.
  const thumbRes = await fetch(`${baseUrl}/api/files/${att.id}?thumb=1`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(thumbRes.status, 200);
  assert.equal(thumbRes.headers.get("content-type"), "image/webp");
});

test("GET /api/files/:id returns 404 for unknown id", async () => {
  const res = await fetch(`${baseUrl}/api/files/does-not-exist`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 404);
});
