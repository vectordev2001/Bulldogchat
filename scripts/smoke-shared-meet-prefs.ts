/**
 * Smoke test: layout preference is shared across Bulldog Meet (Room.tsx)
 * and CallOverlays via the `bulldog.meet.prefs` blob + `MEET_PREFS_EVENT`.
 *
 * Guards against regression back to the split `bulldog.call.layout`
 * localStorage key that CallOverlays used before PR B of the parity work.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..");

const overlays = readFileSync(resolve(repo, "client/src/components/CallOverlays.tsx"), "utf8");
const prefs = readFileSync(resolve(repo, "client/src/lib/meet-prefs.ts"), "utf8");
const room = readFileSync(resolve(repo, "client/src/pages/meetings/Room.tsx"), "utf8");

// CallOverlays must import the shared prefs helpers.
for (const name of ["loadMeetPrefs", "saveMeetPrefs", "MEET_PREFS_EVENT", "emitMeetPrefsChanged"]) {
  assert.ok(
    new RegExp(`\\b${name}\\b`).test(overlays),
    `CallOverlays must reference \`${name}\` from @/lib/meet-prefs`,
  );
}

// The old CallOverlays-local layout key must not be used as a live
// localStorage identifier. String appears once in a migration comment;
// what matters is no code path reads or writes it.
assert.ok(
  !/localStorage\.(get|set)Item\(\s*["'`]bulldog\.call\.layout/.test(overlays),
  'CallOverlays must not read/write the old "bulldog.call.layout" localStorage key',
);
assert.ok(
  !/LAYOUT_STORAGE_KEY/.test(overlays),
  "CallOverlays must not carry the LAYOUT_STORAGE_KEY constant",
);

// CallOverlays must subscribe to MEET_PREFS_EVENT for cross-surface sync.
assert.ok(
  /addEventListener\(\s*MEET_PREFS_EVENT/.test(overlays),
  "CallOverlays must subscribe to MEET_PREFS_EVENT so Room.tsx layout picks propagate",
);
assert.ok(
  /removeEventListener\(\s*MEET_PREFS_EVENT/.test(overlays),
  "CallOverlays must remove its MEET_PREFS_EVENT listener on unmount",
);

// The cycle button must persist through the shared helper, not localStorage.setItem.
const cycleBlock = overlays.slice(overlays.indexOf("const cycleLayout"));
assert.ok(
  /persistSavedLayout\(next\)/.test(cycleBlock),
  "cycleLayout must call persistSavedLayout(next) which routes through saveMeetPrefs + emitMeetPrefsChanged",
);
assert.ok(
  !/localStorage\.setItem\([^,]*layout/i.test(cycleBlock),
  "cycleLayout must not write layout to localStorage directly",
);

// MeetLayout must include the CallOverlays-only "sidebar" mode.
assert.ok(
  /export type MeetLayout\s*=\s*("[^"]+"\s*\|\s*)*"sidebar"/.test(prefs),
  'MeetLayout must include the "sidebar" variant so CallOverlays can persist it via the shared blob',
);

// loadMeetPrefs must sanitize "sidebar" back out (not silently downgrade it).
const loadFn = prefs.slice(prefs.indexOf("export function loadMeetPrefs"));
assert.ok(
  /"sidebar"/.test(loadFn),
  "loadMeetPrefs must preserve the sidebar variant when reading an existing blob",
);

// Room.tsx must still use the shared bus (this stayed unchanged, just double-check).
assert.ok(
  /loadMeetPrefs|MEET_PREFS_EVENT|emitMeetPrefsChanged/.test(room),
  "Room.tsx must still consume the shared meet-prefs bus",
);

console.log(
  "OK: CallOverlays layout persistence unified with Bulldog Meet via bulldog.meet.prefs + MEET_PREFS_EVENT",
);
