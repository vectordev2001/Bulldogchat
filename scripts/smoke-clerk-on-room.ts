/**
 * Smoke test: MeetingClerkButton is mounted on Room.tsx's bottom control
 * bar (not just the sidebar Transcript tab) so scheduled meetings get the
 * same first-class clerk toggle CallOverlays already exposes for channel
 * calls.
 *
 * Deferred item from PR #87 notes: "MeetingClerkButton on Room pending
 * channelId design". The channelId question resolved to: use
 * `meetingData.meeting.channelId` (already fetched via /api/meetings/:code),
 * gate the button on channelId != null, and adopt Room's own
 * `isHost = !!authedUser` semantic for canControl + autoStart.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const room = readFileSync(
  resolve(__dirname, "..", "client/src/pages/meetings/Room.tsx"),
  "utf8",
);
const clerk = readFileSync(
  resolve(__dirname, "..", "client/src/components/MeetingClerkButton.tsx"),
  "utf8",
);

// MeetingClerkButton must accept the new `round` variant.
assert.ok(
  /round\?:\s*boolean/.test(clerk),
  "MeetingClerkButton must expose a `round` prop for BarBtn-shaped rendering",
);
assert.ok(
  /if \(round\) \{/.test(clerk),
  "MeetingClerkButton must have a `round` branch in its render",
);
// The round branch must handle all four states: idle, recording, processing, countdown.
const roundBranch = clerk.slice(clerk.indexOf("if (round) {"));
for (const marker of [
  "button-start-clerk",
  "button-stop-clerk",
  "status-clerk-processing",
  "button-cancel-clerk-autostart",
]) {
  assert.ok(
    roundBranch.includes(marker),
    `round branch must render ${marker} state`,
  );
}

// Room.tsx must mount the clerk on the bottom bar (round variant), NOT
// only inside TranscriptTab.
assert.ok(
  /<MeetingClerkButton[\s\S]{0,400}\bround\b[\s\S]{0,400}\/>/.test(room),
  "Room.tsx must mount <MeetingClerkButton round /> on the control bar",
);

// It must be gated on channelId != null and pass the correct wiring.
const barMount = room.match(
  /meetingData\?\.meeting\?\.channelId != null[\s\S]{0,600}<\/[^>]+>|meetingData\?\.meeting\?\.channelId != null[\s\S]{0,600}\)\}/,
);
assert.ok(barMount, "Room.tsx clerk must be gated on channelId != null");
const mount = barMount![0];
assert.ok(
  /canControl=\{isHost\}/.test(mount),
  "clerk canControl must be `isHost` (reuses Room's existing authed-host semantic)",
);
assert.ok(
  /autoStart=\{isHost\}/.test(mount),
  "clerk autoStart must be `isHost` for parity with CallOverlays' `iAmCaller`",
);
assert.ok(
  /roomName=\{room\?\.name\}/.test(mount),
  "clerk must pass roomName={room?.name} for participant tracking",
);

// Sidebar Transcript tab clerk mount must still exist \u2014 both surfaces are
// intentional (bar button for start/stop, sidebar for history + recipients).
const transcriptTab = room.slice(room.indexOf("function TranscriptTab"));
assert.ok(
  /<MeetingClerkButton[\s\S]{0,300}compact=\{false\}/.test(transcriptTab),
  "TranscriptTab must keep its full-size clerk (history + recipients surface)",
);

console.log(
  "OK: Room.tsx bottom bar mounts MeetingClerkButton (round, isHost-gated); sidebar copy preserved",
);
