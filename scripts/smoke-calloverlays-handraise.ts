/**
 * Smoke test: CallOverlays exposes a hand-raise UI (toolbar button +
 * per-tile badge), reading and writing the same `handRaised` LiveKit
 * attribute Room.tsx uses.
 *
 * PR C.2 of the parity work. Contract value is locked to `"1"` in PR
 * #159; the useLiveKitRoom hook already exposes setHandRaised and
 * surfaces `handRaised` on each RoomParticipantState \u2014 this test just
 * asserts the CallOverlays UI wiring is present.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..");

const overlays = readFileSync(resolve(repo, "client/src/components/CallOverlays.tsx"), "utf8");
const tile = readFileSync(resolve(repo, "client/src/components/call/CallTile.tsx"), "utf8");
const hook = readFileSync(resolve(repo, "client/src/lib/useLiveKitRoom.ts"), "utf8");

// The lucide Hand icon must be imported.
assert.ok(
  /from "lucide-react"[^]*?\bHand\b/.test(overlays),
  "CallOverlays must import the Hand icon from lucide-react",
);

// Toolbar hand button must exist with the right wiring.
const handBtn = overlays.match(/<TopBarBtn[\s\S]{0,600}testid="call-hand"[\s\S]{0,50}\/>/);
assert.ok(handBtn, "CallOverlays must render a <TopBarBtn testid=\"call-hand\" />");
const btn = handBtn![0];
assert.ok(
  /icon=\{<Hand /.test(btn),
  "call-hand button must render the <Hand /> icon",
);
assert.ok(
  /lk\.setHandRaised\(!meParticipant\?\.handRaised\)/.test(btn),
  "call-hand onClick must toggle via lk.setHandRaised(!current)",
);
assert.ok(
  /active=\{!!meParticipant\?\.handRaised\}/.test(btn),
  "call-hand button must reflect meParticipant.handRaised as active",
);
assert.ok(
  /disabled=\{lk\.status !== "connected"\}/.test(btn),
  "call-hand button must be disabled until the room is connected",
);

// CallTile must render the badge when participant.handRaised is truthy.
assert.ok(
  /const handRaised = !!participant\?\.handRaised/.test(tile),
  "CallTile must read handRaised from participant state",
);
assert.ok(
  /data-testid="call-tile-hand-raised"/.test(tile),
  "CallTile must render the hand-raise badge with a stable testid",
);
assert.ok(
  /\{handRaised && \(/.test(tile),
  "CallTile must gate the hand-raise badge on the handRaised value",
);

// The underlying hook must still expose setHandRaised (contract).
assert.ok(
  /\bsetHandRaised\b/.test(hook),
  "useLiveKitRoom must continue to expose setHandRaised",
);

console.log("OK: CallOverlays hand-raise UI wired end-to-end (toolbar + tile badge)");
