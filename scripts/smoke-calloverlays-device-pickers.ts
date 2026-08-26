/**
 * Smoke test for PR D — mid-call device pickers in CallOverlays.
 *
 * Locks in:
 *   - useLiveKitRoom exposes switchActiveDevice with the DOM MediaDeviceKind
 *     vocabulary (audioinput / videoinput / audiooutput).
 *   - CallOverlays imports the shared DeviceSelector + MeetSettingsModal
 *     components and the meet-devices persistence helpers.
 *   - The toolbar renders the two input DeviceSelectors (audio + video) as
 *     pills and a Devices gear button with stable testids.
 *   - The Devices modal is mounted at the ActiveCallOverlay tail.
 *   - Apply-on-connect wiring is present (mirrors Room.tsx behaviour).
 *
 * Run: npx tsx scripts/smoke-calloverlays-device-pickers.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const hook = readFileSync(
  resolve(repoRoot, "client/src/lib/useLiveKitRoom.ts"),
  "utf8",
);
const overlays = readFileSync(
  resolve(repoRoot, "client/src/components/CallOverlays.tsx"),
  "utf8",
);

const failures: string[] = [];
function must(cond: boolean, label: string) {
  if (!cond) failures.push(label);
}

// ── Hook ─────────────────────────────────────────────────────────────────
must(
  /switchActiveDevice:\s*\(\s*kind:\s*"audioinput"\s*\|\s*"videoinput"\s*\|\s*"audiooutput"/.test(
    hook,
  ),
  "useLiveKitRoom result type must declare switchActiveDevice(kind, deviceId)",
);
must(
  /const\s+switchActiveDevice\s*=\s*useCallback/.test(hook),
  "useLiveKitRoom must implement switchActiveDevice via useCallback",
);
must(
  /await\s+room\.switchActiveDevice\(\s*kind\s*,\s*deviceId\s*\)/.test(hook),
  "switchActiveDevice must forward to room.switchActiveDevice(kind, deviceId)",
);
must(
  /return\s+\{[^}]*switchActiveDevice,/s.test(hook),
  "useLiveKitRoom must return switchActiveDevice in its result object",
);

// ── CallOverlays imports ─────────────────────────────────────────────────
must(
  /import\s+\{[^}]*Settings[^}]*\}\s+from\s+"lucide-react"/.test(overlays),
  "CallOverlays must import the Settings icon from lucide-react",
);
must(
  /from\s+"\.\/call\/DeviceSelector"/.test(overlays),
  "CallOverlays must import DeviceSelector",
);
must(
  /from\s+"\.\/call\/MeetSettingsModal"/.test(overlays),
  "CallOverlays must import MeetSettingsModal",
);
must(
  /import\s+\{[^}]*loadDevicePrefs[^}]*saveDevicePrefs[^}]*DevicePrefs[^}]*\}\s+from\s+"@\/lib\/meet-devices"/.test(
    overlays,
  ),
  "CallOverlays must import loadDevicePrefs, saveDevicePrefs, DevicePrefs from meet-devices",
);

// ── State + handler ──────────────────────────────────────────────────────
must(
  /useState<DevicePrefs>\(\(\)\s*=>\s*loadDevicePrefs\(\)\)/.test(overlays),
  "CallOverlays must initialize devicePrefs from loadDevicePrefs()",
);
must(
  /const\s+\[settingsOpen,\s*setSettingsOpen\]\s*=\s*useState\(false\)/.test(
    overlays,
  ),
  "CallOverlays must hold a settingsOpen boolean for the modal",
);
must(
  /const\s+onDevicePick\s*=\s*useCallback/.test(overlays),
  "CallOverlays must define onDevicePick as a useCallback",
);
must(
  /saveDevicePrefs\(next\)/.test(overlays),
  "onDevicePick must persist device picks via saveDevicePrefs()",
);
must(
  /lk\.switchActiveDevice\(deviceKindMap\[kind\],\s*deviceId\)/.test(overlays),
  "onDevicePick must forward the pick to lk.switchActiveDevice using deviceKindMap",
);

// ── Apply-on-connect ─────────────────────────────────────────────────────
must(
  /if\s*\(lk\.status\s*!==\s*"connected"\)\s*return;/.test(overlays),
  "CallOverlays must have an apply-on-connect effect gated by lk.status === connected",
);
must(
  /lk\.switchActiveDevice\("audioinput",\s*devicePrefs\.audioInput\)/.test(
    overlays,
  ),
  "Apply-on-connect must switch audioinput to devicePrefs.audioInput",
);
must(
  /lk\.switchActiveDevice\("videoinput",\s*devicePrefs\.videoInput\)/.test(
    overlays,
  ),
  "Apply-on-connect must switch videoinput to devicePrefs.videoInput",
);
must(
  /lk\.switchActiveDevice\("audiooutput",\s*devicePrefs\.audioOutput/.test(
    overlays,
  ),
  "Apply-on-connect must apply audio output preference",
);

// ── Toolbar wiring ───────────────────────────────────────────────────────
must(
  /data-testid="call-toolbar-devices"/.test(overlays),
  "Toolbar must render a device-pill row with data-testid call-toolbar-devices",
);
must(
  /<DeviceSelector[\s\S]*?kind="audioInput"[\s\S]*?variant="pill"/.test(
    overlays,
  ),
  "Toolbar must render an audioInput DeviceSelector as a pill",
);
must(
  /<DeviceSelector[\s\S]*?kind="videoInput"[\s\S]*?variant="pill"/.test(
    overlays,
  ),
  "Toolbar must render a videoInput DeviceSelector as a pill",
);
must(
  /testid="call-toolbar-devices-modal"/.test(overlays),
  "Toolbar must render a Devices gear button with testid call-toolbar-devices-modal",
);

// ── Modal mount ──────────────────────────────────────────────────────────
must(
  /\{settingsOpen && \(\s*<MeetSettingsModal/.test(overlays),
  "MeetSettingsModal must be gated on settingsOpen inside ActiveCallOverlay",
);
must(
  /prefs=\{devicePrefs\}/.test(overlays),
  "MeetSettingsModal must receive devicePrefs as prefs",
);
must(
  /onChange=\{\(kind,\s*deviceId\)\s*=>\s*onDevicePick\(kind,\s*deviceId\)\}/.test(
    overlays,
  ),
  "MeetSettingsModal onChange must route through onDevicePick",
);
must(
  /onClose=\{\(\)\s*=>\s*setSettingsOpen\(false\)\}/.test(overlays),
  "MeetSettingsModal must close via setSettingsOpen(false)",
);

if (failures.length > 0) {
  console.error("SMOKE FAIL: PR D device pickers");
  for (const f of failures) console.error("  \u2716 " + f);
  process.exit(1);
}

console.log("SMOKE PASS: PR D device pickers (" + [
  "hook.switchActiveDevice",
  "CallOverlays imports (Settings icon, DeviceSelector, MeetSettingsModal, meet-devices)",
  "devicePrefs state + settingsOpen + onDevicePick",
  "apply-on-connect for audioinput / videoinput / audiooutput",
  "toolbar pills (audioInput + videoInput) + Devices gear",
  "MeetSettingsModal mounted with prefs/onChange/onClose",
].join(", ") + ")");
