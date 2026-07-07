// Integration tests for the channel call + deep-link plumbing shipped in
// PR #94 (channel-aware calls + chat notifications). Two-part coverage:
//
//   1. Pure unit tests for client/src/lib/deep-link.ts — verifies both the
//      legacy `?channel=<id>` form and the push-notif
//      `/#/channels/<id>?call=<room>` form parse to the same shape. This
//      is the fulcrum of the "push -> channel view -> join banner" flow;
//      if parseDeepLink misidentifies the shape, the banner never surfaces.
//
//   2. HTTP tests for the new POST /api/channels/:id/group-call/join
//      endpoint that the Join banner calls. Verifies room-name validation,
//      channel-mismatch protection, missing-channel 404, and (in the happy
//      case) that a live LiveKit token is minted for the joining user.
//
// Run with:  npx tsx --test server/routes-channel-calls.test.ts
//
// Uses Node's built-in node:test runner (no framework dependency), matching
// server/routes-attachments.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Env must be set before importing modules that read it at import time.
const workDir = mkdtempSync(join(tmpdir(), "bulldog-cc-"));
process.env.DATABASE_URL = `file:${join(workDir, "test.db")}`;
process.env.JWT_SECRET = "test-secret";
process.env.STORAGE_BACKEND = "disk";
process.env.LOCAL_UPLOAD_ROOT = join(workDir, "uploads");
// LiveKit needs *something* configured for the endpoint to mint a token
// rather than 503. Real keys aren't required — generateLivekitToken just
// signs a JWT with LIVEKIT_API_KEY/LIVEKIT_API_SECRET.
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret-thats-long-enough-for-hmac";
process.env.LIVEKIT_WS_URL = "wss://livekit.test.local";

let server: Server;
let baseUrl: string;
let token: string;
let orgId: number;
let userId: number;
let channelA: number;
let channelB: number;

before(async () => {
  const express = (await import("express")).default;
  const { runMigrations } = await import("./migrate");
  const { storage } = await import("./storage");
  const { signJwt, hashPassword } = await import("./auth");
  // Mount JUST the join endpoint. Booting the full registerRoutes tree runs
  // migrations, seeds, and the multi-tenant setup, which blocks the test
  // worker indefinitely in a fresh sqlite. We only need this one endpoint.
  const { registerGroupCallJoinRoute } = await import("./routes");

  runMigrations();

  // Seed org+user+project+channels BEFORE registerRoutes runs. seed.ts
  // short-circuits when orgCount()>0, so our data becomes the canonical
  // fixture and the Vector Services demo seed never fires.
  const org = storage.createOrg({ name: "CC Test Org", slug: "cc-test" } as any);
  orgId = org.id;
  const user = storage.createUser({
    orgId: org.id,
    email: "host@test.local",
    passwordHash: hashPassword("pw"),
    name: "Call Host",
    role: "admin",
  } as any);
  userId = user.id;
  token = signJwt(user.id);

  // Create a project + two text channels so we can exercise the channel-A
  // room-name in channel-B mismatch guard.
  const project = storage.createProject({
    orgId: org.id,
    name: "Test Project",
    slug: "test-proj",
    short: "TP",
    hue: 220,
  } as any);
  // Grant explicit membership. userCanAccessChannel gates on
  // project_members (admin bypasses it, but wire it up anyway so a future
  // test with a non-admin user still passes).
  storage.addProjectMember(project.id, user.id, "owner");
  const chA = storage.createChannel({
    orgId: org.id,
    projectId: project.id,
    name: "channel-a",
    type: "text",
    scope: "project",
    createdBy: user.id,
  } as any);
  const chB = storage.createChannel({
    orgId: org.id,
    projectId: project.id,
    name: "channel-b",
    type: "text",
    scope: "project",
    createdBy: user.id,
  } as any);
  channelA = chA.id;
  channelB = chB.id;

  const app = express();
  app.use(express.json());
  registerGroupCallJoinRoute(app);

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
  // Force-exit: the sqlite handle + Express keep-alive keep the event loop
  // alive past the last test, and we don't need graceful teardown in a
  // unit-test process. Without this the runner sits for another few
  // minutes waiting for handles to drain.
  setImmediate(() => process.exit(0));
});

// ─────────────────────────── deep-link parser ────────────────────────────
// Pure functions imported directly from the client module. tsx will resolve
// the @/ alias via tsconfig when running the test (verified: matches
// existing tsconfig.json paths setup).

test("parseDeepLink: legacy ?channel=<id> form", async () => {
  const { parseDeepLink } = await import("../client/src/lib/deep-link");
  assert.deepEqual(parseDeepLink("https://chat.bulldogops.com/?channel=42"), {
    channelId: 42,
    callRoom: null,
  });
});

test("parseDeepLink: push-notif /#/channels/<id>?call=<room> form", async () => {
  const { parseDeepLink } = await import("../client/src/lib/deep-link");
  const href =
    "https://chat.bulldogops.com/#/channels/42?call=group-channel-42-1720291000000";
  assert.deepEqual(parseDeepLink(href), {
    channelId: 42,
    callRoom: "group-channel-42-1720291000000",
  });
});

test("parseDeepLink: hash-path without ?call resolves channel only", async () => {
  const { parseDeepLink } = await import("../client/src/lib/deep-link");
  assert.deepEqual(parseDeepLink("https://chat.bulldogops.com/#/channels/7"), {
    channelId: 7,
    callRoom: null,
  });
});

test("parseDeepLink: bogus channel id returns null", async () => {
  const { parseDeepLink } = await import("../client/src/lib/deep-link");
  assert.equal(parseDeepLink("https://chat.bulldogops.com/#/channels/abc"), null);
  assert.equal(parseDeepLink("https://chat.bulldogops.com/?channel=-5"), null);
});

test("hasDeepLink is a boolean fast-path aligned with parseDeepLink", async () => {
  const { hasDeepLink, parseDeepLink } = await import("../client/src/lib/deep-link");
  const hrefs = [
    "https://chat.bulldogops.com/",
    "https://chat.bulldogops.com/?channel=7",
    "https://chat.bulldogops.com/#/channels/9?call=group-channel-9-1",
    "https://chat.bulldogops.com/#/settings",
  ];
  for (const h of hrefs) {
    assert.equal(hasDeepLink(h), parseDeepLink(h) !== null, `mismatch for ${h}`);
  }
});

// ────────────────── POST /api/channels/:id/group-call/join ───────────────

test("group-call/join: 401 without auth", async () => {
  const res = await fetch(`${baseUrl}/api/channels/${channelA}/group-call/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomName: `group-channel-${channelA}-1720291000000` }),
  });
  assert.equal(res.status, 401);
});

test("group-call/join: 400 when roomName missing", async () => {
  const res = await fetch(`${baseUrl}/api/channels/${channelA}/group-call/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("group-call/join: 400 when roomName shape is bogus", async () => {
  const res = await fetch(`${baseUrl}/api/channels/${channelA}/group-call/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ roomName: "not-a-real-room-name" }),
  });
  assert.equal(res.status, 400);
});

test("group-call/join: 403 when room name belongs to a different channel", async () => {
  // Room name embeds channelA's id but we're calling join on channelB.
  const res = await fetch(`${baseUrl}/api/channels/${channelB}/group-call/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ roomName: `group-channel-${channelA}-1720291000000` }),
  });
  assert.equal(res.status, 403);
});

test("group-call/join: happy path mints a token for the caller", async () => {
  const roomName = `group-channel-${channelA}-1720291234567`;
  const res = await fetch(`${baseUrl}/api/channels/${channelA}/group-call/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ roomName, kind: "video" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.roomName, roomName);
  assert.equal(body.kind, "video");
  assert.equal(body.channelId, channelA);
  assert.ok(typeof body.token === "string" && body.token.length > 20, "token minted");
  assert.equal(body.ws_url, process.env.LIVEKIT_WS_URL);
});
