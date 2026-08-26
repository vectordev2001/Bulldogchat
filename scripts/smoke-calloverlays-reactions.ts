/**
 * Smoke test: CallOverlays reactions parity (PR C.3).
 *
 * Locks:
 * - useLiveKitRoom exposes sendData + onData with the right signatures.
 * - CallOverlays imports the Smile icon.
 * - Reactions constants + wire format match Room.tsx (topic
 *   "bulldog-reactions", 5 emojis).
 * - Toolbar renders a <TopBarBtn testid="call-toolbar-reactions"> with
 *   a popover containing per-emoji buttons.
 * - Floating reactions layer + CSS animation are in place.
 * - fireReaction encodes the same { emoji, fromIdentity, timestamp }
 *   payload the Room.tsx path uses.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..");

const hook = readFileSync(resolve(repo, "client/src/lib/useLiveKitRoom.ts"), "utf8");
const overlays = readFileSync(resolve(repo, "client/src/components/CallOverlays.tsx"), "utf8");
const room = readFileSync(resolve(repo, "client/src/pages/meetings/Room.tsx"), "utf8");
const css = readFileSync(resolve(repo, "client/src/index.css"), "utf8");

// --- Hook contract -------------------------------------------------------
assert.ok(
  /sendData: \(topic: string, payload: Uint8Array\) => void;/.test(hook),
  "useLiveKitRoom must expose sendData(topic, payload)",
);
assert.ok(
  /onData: \(\s*topic: string,\s*handler: \(payload: Uint8Array, fromIdentity: string\) => void,\s*\) => \(\) => void;/.test(
    hook,
  ),
  "useLiveKitRoom must expose onData(topic, handler) returning unsubscribe",
);
assert.ok(
  /RoomEvent\.DataReceived/.test(hook),
  "useLiveKitRoom must register a DataReceived listener",
);
assert.ok(
  /publishData\(payload, \{ reliable: true, topic \}\)/.test(hook),
  "sendData must use reliable delivery with the requested topic",
);

// --- Wire compat with Room.tsx ------------------------------------------
const overlaysTopic = overlays.match(/REACTIONS_TOPIC = "(bulldog-reactions)"/);
assert.ok(overlaysTopic, "CallOverlays must declare REACTIONS_TOPIC = 'bulldog-reactions'");
assert.ok(
  /useDataChannel\("bulldog-reactions"/.test(room),
  "Room.tsx sanity: still using the 'bulldog-reactions' topic",
);
assert.ok(
  /REACTION_EMOJIS = \[[^\]]+\]/.test(overlays),
  "CallOverlays must declare a REACTION_EMOJIS array",
);
// Room emojis parity: 👍 ❤️ 😂 🎉 👏
const roomEmojis = room.match(/const REACTIONS = \[[^\]]+\]/);
const overlayEmojis = overlays.match(/REACTION_EMOJIS = \[[^\]]+\]/);
assert.ok(roomEmojis && overlayEmojis, "both surfaces must declare their reaction arrays");
for (const e of ["👍", "❤️", "😂", "🎉", "👏"]) {
  assert.ok(roomEmojis![0].includes(e), `Room.REACTIONS missing ${e}`);
  assert.ok(overlayEmojis![0].includes(e), `CallOverlays.REACTION_EMOJIS missing ${e}`);
}

// --- CallOverlays UI wiring ---------------------------------------------
assert.ok(
  /from "lucide-react"[^]*?\bSmile\b/.test(overlays),
  "CallOverlays must import the Smile icon",
);
const reactBtn = overlays.match(/<TopBarBtn[\s\S]{0,600}testid="call-toolbar-reactions"[\s\S]{0,50}\/>/);
assert.ok(reactBtn, "CallOverlays must render a <TopBarBtn testid=\"call-toolbar-reactions\" />");
assert.ok(/data-testid="popover-reactions"/.test(overlays), "reactions popover must be rendered with a stable testid");
assert.ok(
  /data-testid=\{`reaction-\$\{e\}`\}/.test(overlays),
  "each emoji button must expose a stable testid",
);
assert.ok(
  /data-testid="call-floating-reactions"/.test(overlays),
  "floating-reactions layer must be present with a stable testid",
);

// --- Payload shape parity ------------------------------------------------
assert.ok(
  /JSON\.stringify\(\s*\{\s*emoji,\s*fromIdentity[^}]+timestamp: Date\.now\(\),?\s*\}/.test(overlays),
  "fireReaction must encode { emoji, fromIdentity, timestamp } to match Room.tsx",
);
assert.ok(
  /lk\.sendData\(REACTIONS_TOPIC, payload\)/.test(overlays),
  "fireReaction must publish via lk.sendData on the shared topic",
);
assert.ok(
  /lk\.onData\(REACTIONS_TOPIC,/.test(overlays),
  "CallOverlays must subscribe to inbound reactions via lk.onData",
);

// --- CSS animation ------------------------------------------------------
assert.ok(/@keyframes vs-reaction-float/.test(css), "reaction float keyframes must exist");
assert.ok(/\.call-reaction-float\s*\{[^}]*animation:/.test(css), "call-reaction-float class must run the keyframes");
assert.ok(/prefers-reduced-motion/.test(css), "reaction animation must honor reduced-motion");

console.log("OK: CallOverlays reactions wired end-to-end (hook + toolbar + wire compat + CSS)");
