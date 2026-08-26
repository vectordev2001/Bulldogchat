/**
 * Smoke test: `handRaised` LiveKit participant-attribute value contract.
 *
 * Bulldog Chat has two LiveKit adapters:
 *   - `@livekit/components-react` (Room.tsx, scheduled meetings)
 *   - `useLiveKitRoom` hand-rolled hook (CallOverlays, DM/group ad-hoc calls,
 *      iOS)
 *
 * Both adapters must write & read the SAME attribute value or hands raised
 * in one surface are silently dropped for participants on the other.
 *
 * useLiveKitRoom.ts is the newer contract and uses `"1"`. Room.tsx used to
 * use `"true"`, which was the source of the P0 cross-surface bug. This
 * smoke test locks the contract to `"1"` on both sides.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..");

const room = readFileSync(resolve(repo, "client/src/pages/meetings/Room.tsx"), "utf8");
const hook = readFileSync(resolve(repo, "client/src/lib/useLiveKitRoom.ts"), "utf8");

// Neither surface may write or read "true" for handRaised anymore.
for (const [label, src] of [["Room.tsx", room], ["useLiveKitRoom.ts", hook]] as const) {
  assert.ok(
    !/handRaised[^=]*===\s*"true"/.test(src),
    `${label} must not read handRaised === "true" (contract is "1")`,
  );
  assert.ok(
    !/setAttributes\([^)]*handRaised:\s*[^"]*"true"/.test(src),
    `${label} must not write handRaised: "true" (contract is "1")`,
  );
}

// And both surfaces must have at least one write and one read of the "1" form.
for (const [label, src, needs] of [
  ["Room.tsx", room, { writes: 1, reads: 2 }],
  ["useLiveKitRoom.ts", hook, { writes: 1, reads: 1 }],
] as const) {
  const writes = (src.match(/setAttributes\([^)]*handRaised:[^)]*"1"/g) || []).length;
  const reads = (src.match(/handRaised[^=]*===\s*"1"/g) || []).length;
  assert.ok(
    writes >= needs.writes,
    `${label} must write handRaised: "1" at least ${needs.writes} time(s), found ${writes}`,
  );
  assert.ok(
    reads >= needs.reads,
    `${label} must read handRaised === "1" at least ${needs.reads} time(s), found ${reads}`,
  );
}

console.log('OK: handRaised attribute contract is "1" on both LiveKit adapters');
