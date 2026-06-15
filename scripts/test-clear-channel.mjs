#!/usr/bin/env node
// Local verification for the internal admin "clear channel" escape hatch.
//
//   POST /internal/admin/clear-channel  (auth: X-Suite-Secret header)
//
// This is a LOCAL-ONLY smoke test — it is NOT wired into CI. It exercises the
// two contracts that matter:
//   1. With the correct X-Suite-Secret it returns 200 and clearedCount >= 0
//      (and > 0 when the target channel actually had messages).
//   2. Without the header it returns 401.
//
// Usage:
//   # Start the server first (in another shell):
//   #   SUITE_INTERNAL_SECRET=test-secret npm run dev
//   #
//   # Then run, pointing at whichever channel exists locally:
//   SUITE_INTERNAL_SECRET=test-secret \
//     node scripts/test-clear-channel.mjs --channelName=general
//
//   # or by id:
//   SUITE_INTERNAL_SECRET=test-secret \
//     node scripts/test-clear-channel.mjs --channelId=1
//
// Env:
//   BASE_URL              default http://localhost:5000
//   SUITE_INTERNAL_SECRET required — must match the running server's secret

const BASE_URL = process.env.BASE_URL ?? "http://localhost:5000";
const SECRET = process.env.SUITE_INTERNAL_SECRET;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const channelName = arg("channelName", undefined);
const channelIdRaw = arg("channelId", undefined);

if (!SECRET) {
  console.error("FAIL: SUITE_INTERNAL_SECRET env var is required (must match the server).");
  process.exit(1);
}
if (!channelName && !channelIdRaw) {
  console.error("FAIL: pass --channelName=<name> or --channelId=<id>.");
  process.exit(1);
}

const body = channelIdRaw
  ? { channelId: Number(channelIdRaw) }
  : { channelName };

const url = `${BASE_URL}/internal/admin/clear-channel`;

let failures = 0;

// --- Test 1: missing header → 401 -----------------------------------------
{
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    console.log("PASS: no X-Suite-Secret header → 401 Unauthorized");
  } else {
    console.error(`FAIL: expected 401 without header, got ${res.status}`);
    failures++;
  }
}

// --- Test 2: correct header → 200 + clearedCount ---------------------------
{
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Suite-Secret": SECRET },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 200 && json.ok === true && typeof json.clearedCount === "number") {
    console.log(
      `PASS: authorized clear → 200, channelId=${json.channelId}, ` +
        `channelName="${json.channelName}", clearedCount=${json.clearedCount}`,
    );
    if (json.clearedCount === 0) {
      console.log("  NOTE: clearedCount is 0 — channel had no live messages (seed it first to assert > 0).");
    }
  } else {
    console.error(`FAIL: expected 200 + {ok,clearedCount}, got ${res.status}:`, json);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
