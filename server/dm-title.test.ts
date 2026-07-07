// Titled Chats (Phase 2.5) — integration tests for PATCH /api/dms/:id and
// POST /api/dms/titled: validation, permission checks (must be a DM member),
// and that GET /api/dms round-trips the title.
//
// Follows the same pattern as server/routes-attachments.test.ts: real
// (temp-file) SQLite DB, Node's built-in node:test runner, no mocks.
// registerRoutes() runs the full seed (creates the demo org + users), so
// we authenticate as seeded demo users rather than creating our own —
// keeps this test independent of any other test file's DB state since each
// gets its own tmp DB via a fresh DATABASE_URL.
//
// Run with:  npx tsx --test server/dm-title.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Server as HttpServer } from "node:http";

const workDir = mkdtempSync(join(tmpdir(), "bulldog-dmtitle-"));
process.env.DATABASE_URL = `file:${join(workDir, "test.db")}`;
process.env.JWT_SECRET = "test-secret";
process.env.STORAGE_BACKEND = "disk";
process.env.LOCAL_UPLOAD_ROOT = join(workDir, "uploads");
// Skip anything that would reach out to real infra during the seed/boot path.
process.env.NODE_ENV = "test";

let server: Server;
let baseUrl: string;
// Two seeded demo users so we can test cross-member permission checks.
let tokenA: string; // chat@bulldogops.com — will be a DM member
let tokenOutsider: string; // a user NOT in the DM under test
let userAId: number;
let userBId: number; // second DM member
let outsiderId: number;

before(async () => {
  const express = (await import("express")).default;
  const { storage } = await import("./storage");
  const { signJwt } = await import("./auth");
  const { registerRoutes } = await import("./routes");

  const app = express();
  app.use(express.json());
  // registerRoutes runs the seed internally (idempotent — creates the demo
  // org + users on first call against this fresh DB).
  await registerRoutes({} as HttpServer, app);

  // Seed always creates org id 1 ("Vector Services") when the DB starts
  // empty — pull three distinct seeded users by their known demo emails.
  const allUsers = storage.listUsersByOrg(1);
  const admin = allUsers.find((u) => u.email === "chat@bulldogops.com");
  const manager = allUsers.find((u) => u.email === "marcus@vectorservicesus.com");
  const outsider = allUsers.find((u) => u.email === "reina@vectorservicesus.com");
  assert.ok(admin && manager && outsider, "seed produced the expected demo users");

  userAId = admin.id;
  userBId = manager.id;
  outsiderId = outsider.id;
  tokenA = signJwt(admin.id);
  tokenOutsider = signJwt(outsider.id);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  server?.close();
  // registerRoutes() starts the in-process scheduled-call reminder loop
  // (setInterval, 60s tick) as a side effect of full app boot — unlike
  // routes-attachments.test.ts, which only registers the lighter v2 router
  // and never starts it. Without stopping it here, node:test's process
  // never exits (setInterval keeps the event loop alive indefinitely).
  const { stopReminderLoop } = await import("./scheduled-calls");
  stopReminderLoop();
  rmSync(workDir, { recursive: true, force: true });
});

async function createTitledDm(token: string, title: string, memberIds: number[]) {
  return fetch(`${baseUrl}/api/dms/titled`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, memberIds }),
  });
}

test("POST /api/dms/titled requires a non-empty title", async () => {
  const res = await createTitledDm(tokenA, "", [userBId]);
  assert.equal(res.status, 400);
});

test("POST /api/dms/titled rejects titles over 80 chars", async () => {
  const res = await createTitledDm(tokenA, "x".repeat(81), [userBId]);
  assert.equal(res.status, 400);
});

test("POST /api/dms/titled requires at least one other member", async () => {
  const res = await createTitledDm(tokenA, "Empty room", []);
  assert.equal(res.status, 400);
});

test("POST /api/dms/titled creates a new channel with the title set and emits created:true", async () => {
  const res = await createTitledDm(tokenA, "Q3 Budget Review", [userBId]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, "Q3 Budget Review");
  assert.equal(body.created, true);
  assert.ok(Array.isArray(body.memberIds));
  assert.ok(body.memberIds.includes(userAId));
  assert.ok(body.memberIds.includes(userBId));
});

test("POST /api/dms/titled is NOT idempotent — same members + different call makes a second channel", async () => {
  const first = await (await createTitledDm(tokenA, "Topic One", [userBId])).json();
  const second = await (await createTitledDm(tokenA, "Topic Two", [userBId])).json();
  assert.notEqual(first.id, second.id, "two titled chats with the same members are distinct channels");
});

test("GET /api/dms includes the title field", async () => {
  const created = await (await createTitledDm(tokenA, "Visible In List", [userBId])).json();
  const res = await fetch(`${baseUrl}/api/dms`, { headers: { Authorization: `Bearer ${tokenA}` } });
  assert.equal(res.status, 200);
  const list = await res.json();
  const row = list.find((c: any) => c.id === created.id);
  assert.ok(row, "created titled DM appears in the list");
  assert.equal(row.title, "Visible In List");
});

test("PATCH /api/dms/:id requires the title field in the body", async () => {
  const created = await (await createTitledDm(tokenA, "Rename Target", [userBId])).json();
  const res = await fetch(`${baseUrl}/api/dms/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("PATCH /api/dms/:id renames the chat for a member", async () => {
  const created = await (await createTitledDm(tokenA, "Old Title", [userBId])).json();
  const res = await fetch(`${baseUrl}/api/dms/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ title: "New Title" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, "New Title");
});

test("PATCH /api/dms/:id clears the title when passed null", async () => {
  const created = await (await createTitledDm(tokenA, "Will Be Cleared", [userBId])).json();
  const res = await fetch(`${baseUrl}/api/dms/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ title: null }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, null);
});

test("PATCH /api/dms/:id rejects titles over 80 chars", async () => {
  const created = await (await createTitledDm(tokenA, "Length Check", [userBId])).json();
  const res = await fetch(`${baseUrl}/api/dms/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ title: "y".repeat(81) }),
  });
  assert.equal(res.status, 400);
});

test("PATCH /api/dms/:id is forbidden for a non-member", async () => {
  const created = await (await createTitledDm(tokenA, "Members Only", [userBId])).json();
  const res = await fetch(`${baseUrl}/api/dms/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenOutsider}` },
    body: JSON.stringify({ title: "Hijacked" }),
  });
  assert.equal(res.status, 403);
});

test("PATCH /api/dms/:id 404s for a non-DM (or nonexistent) channel id", async () => {
  const res = await fetch(`${baseUrl}/api/dms/999999999`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ title: "Nope" }),
  });
  assert.equal(res.status, 404);
});

test("PATCH and POST /api/dms/titled require authentication", async () => {
  const patchRes = await fetch(`${baseUrl}/api/dms/1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(patchRes.status, 401);

  const postRes = await fetch(`${baseUrl}/api/dms/titled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "x", memberIds: [userBId] }),
  });
  assert.equal(postRes.status, 401);
});
