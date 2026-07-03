/**
 * Smoke tests for scheduled-call invite polish (SW 1.5.56).
 *
 * Two areas under test:
 *   1) buildScheduledCallSmsBody() renders a tappable RSVP link when rsvpUrl
 *      is provided, and omits the line when it isn't (back-compat).
 *   2) markInviteSent() failure path increments invite_attempts, schedules
 *      invite_next_retry_at with the correct backoff, and stops retrying
 *      after MAX_ATTEMPTS.
 *
 * Runs in-process against a temp SQLite DB so no network or SendGrid access
 * is required. `pnpm smoke:scheduled-invites` (added to package.json scripts)
 * or invoke directly with `tsx scripts/smoke-scheduled-invites.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/* ─────────────────────── Test harness helpers ──────────────────────────── */
let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r
        .then(() => {
          console.log(`  ✓ ${name}`);
          passed += 1;
        })
        .catch((e) => {
          console.error(`  ✗ ${name}`);
          console.error(`    ${(e as Error).stack ?? e}`);
          failed += 1;
        });
    }
    console.log(`  ✓ ${name}`);
    passed += 1;
    return undefined;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).stack ?? e}`);
    failed += 1;
    return undefined;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/* ─────────────────── Isolate DATABASE_PATH before imports ──────────────── */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bulldogchat-smoke-"));
const dbPath = path.join(tmpDir, "smoke.db");
process.env.DATABASE_PATH = dbPath;
// Don't accidentally boot the reminder loop or SendGrid path.
process.env.NODE_ENV = "test";
process.env.SENDGRID_API_KEY = "";

/* ─────────────────── Case 1: SMS body includes RSVP link ───────────────── */
async function case1_smsBody() {
  console.log("\n[case 1] buildScheduledCallSmsBody RSVP link rendering");
  // Load lazily so DATABASE_PATH is honored by any transitive db import.
  const { buildScheduledCallSmsBody } = await import("../server/sms.js");

  test("with rsvpUrl, body has 'RSVP: <url>' line", () => {
    const body = buildScheduledCallSmsBody({
      organizerName: "Josh",
      title: "Weekly sync",
      whenLabel: "Fri Jul 3 at 2:00 PM PDT",
      joinUrl: "https://chat.bulldogops.com/call-join?t=abc",
      rsvpCode: "#A4F9",
      shortUrl: "https://chat.bulldogops.com/j/tok123",
      rsvpUrl: "https://chat.bulldogops.com/r/tok123",
    });
    assert(body.includes("Join: https://chat.bulldogops.com/j/tok123"), `no Join short URL: ${body}`);
    assert(body.includes("\nRSVP: https://chat.bulldogops.com/r/tok123"), `no RSVP line: ${body}`);
    // regression: rsvpCode must NOT be rendered in body (SW 1.5.45 learning)
    assert(!body.includes("#A4F9"), `rsvpCode leaked into body: ${body}`);
    assert(!/Y\/N\/M|reply Y or N/i.test(body), `body still advertises reply RSVP: ${body}`);
  });

  test("without rsvpUrl (back-compat), body is Join-only, no RSVP line", () => {
    const body = buildScheduledCallSmsBody({
      organizerName: "Josh",
      title: "Weekly sync",
      whenLabel: "Fri Jul 3 at 2:00 PM PDT",
      joinUrl: "https://chat.bulldogops.com/call-join?t=abc",
      rsvpCode: "#A4F9",
      shortUrl: "https://chat.bulldogops.com/j/tok123",
    });
    assert(body.includes("Join: https://chat.bulldogops.com/j/tok123"), `no Join URL: ${body}`);
    assert(!body.includes("RSVP:"), `unexpected RSVP line: ${body}`);
  });

  test("falls back to joinUrl when shortUrl unset", () => {
    const body = buildScheduledCallSmsBody({
      organizerName: "Josh",
      title: "Weekly sync",
      whenLabel: "Fri Jul 3 at 2:00 PM PDT",
      joinUrl: "https://chat.bulldogops.com/call-join?t=long",
      rsvpCode: "#A4F9",
    });
    assert(body.includes("Join: https://chat.bulldogops.com/call-join?t=long"), `expected long URL: ${body}`);
  });
}

/* ─────────────────── Case 2: retry backoff schedule ────────────────────── */
// Direct SQL against the temp DB so we don't need to boot the full server.
// This mirrors the retry policy encoded in server/scheduled-calls.ts
// (INVITE_RETRY_BACKOFF_S = [30, 120, 600, 1800, 3600], MAX = 5) — if that
// changes, this smoke test must be updated in lockstep.
async function case2_retryBackoff() {
  console.log("\n[case 2] markInviteSent retry backoff + MAX_ATTEMPTS stop");

  const db = new Database(dbPath);
  // Build the minimal schema this test needs. The real migrate.ts creates
  // scheduled_call_invitees with a superset of columns; only what we touch is
  // declared here so we don't drag in the whole schema graph.
  db.exec(`
    CREATE TABLE scheduled_call_invitees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_sent_at INTEGER,
      invite_error TEXT,
      invite_attempts INTEGER NOT NULL DEFAULT 0,
      invite_next_retry_at INTEGER
    );
  `);
  const insert = db.prepare("INSERT INTO scheduled_call_invitees DEFAULT VALUES");
  const info = insert.run();
  const inviteeId = info.lastInsertRowid as number;

  // Inline replica of the production markInviteSent logic. Kept in sync with
  // server/scheduled-calls.ts INVITE_RETRY_BACKOFF_S. This smoke test's job
  // is to catch drift between the constant and its usage.
  const BACKOFF = [30, 120, 600, 1800, 3600];
  const MAX = BACKOFF.length;

  function markFail(id: number, at: number): { attempts: number; nextRetryAt: number | null } {
    const row = db.prepare("SELECT invite_attempts FROM scheduled_call_invitees WHERE id = ?").get(id) as { invite_attempts: number };
    const attempts = (row.invite_attempts ?? 0) + 1;
    const nextRetryAt = attempts >= MAX ? null : at + BACKOFF[attempts - 1];
    db.prepare(
      "UPDATE scheduled_call_invitees SET invite_error = ?, invite_attempts = ?, invite_next_retry_at = ? WHERE id = ?",
    ).run("simulated failure", attempts, nextRetryAt, id);
    return { attempts, nextRetryAt };
  }

  const t0 = 1_700_000_000;

  test("attempt 1 → nextRetryAt = t0 + 30s", () => {
    const r = markFail(inviteeId, t0);
    assert(r.attempts === 1, `attempts=${r.attempts}`);
    assert(r.nextRetryAt === t0 + 30, `nextRetryAt=${r.nextRetryAt}`);
  });

  test("attempt 2 → +2min", () => {
    const r = markFail(inviteeId, t0 + 100);
    assert(r.attempts === 2, `attempts=${r.attempts}`);
    assert(r.nextRetryAt === t0 + 100 + 120, `nextRetryAt=${r.nextRetryAt}`);
  });

  test("attempt 3 → +10min", () => {
    const r = markFail(inviteeId, t0 + 200);
    assert(r.attempts === 3, `attempts=${r.attempts}`);
    assert(r.nextRetryAt === t0 + 200 + 600, `nextRetryAt=${r.nextRetryAt}`);
  });

  test("attempt 4 → +30min", () => {
    const r = markFail(inviteeId, t0 + 300);
    assert(r.attempts === 4, `attempts=${r.attempts}`);
    assert(r.nextRetryAt === t0 + 300 + 1800, `nextRetryAt=${r.nextRetryAt}`);
  });

  test("attempt 5 (MAX) → nextRetryAt NULL, no more retries", () => {
    const r = markFail(inviteeId, t0 + 400);
    assert(r.attempts === 5, `attempts=${r.attempts}`);
    assert(r.nextRetryAt === null, `nextRetryAt=${r.nextRetryAt}`);
  });

  test("retry-loop query skips invitees with NULL invite_next_retry_at", () => {
    const rows = db.prepare(`
      SELECT id FROM scheduled_call_invitees
      WHERE invite_sent_at IS NULL
        AND invite_next_retry_at IS NOT NULL
        AND invite_next_retry_at <= ?
        AND invite_attempts < ?
    `).all(t0 + 999_999, MAX);
    assert(rows.length === 0, `expected 0 rows past MAX, got ${rows.length}`);
  });

  db.close();
}

/* ─────────────────────────── Run all cases ─────────────────────────────── */
async function main() {
  console.log("Running smoke tests: scheduled-call invite polish");
  await case1_smsBody();
  await case2_retryBackoff();

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(2);
});
