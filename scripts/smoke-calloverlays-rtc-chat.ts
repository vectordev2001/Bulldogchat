/**
 * Smoke test for PR E — RTC chat for non-channel (direct/1:1) calls.
 *
 * Locks in:
 *   - RtcChatPanel exists and speaks the shared RTC_CHAT_TOPIC constant.
 *   - It subscribes to lk.onData and publishes via lk.sendData for the
 *     bulldog-call-chat topic.
 *   - CallOverlays imports it and mounts it in the ActiveCallOverlay body
 *     with the !hasChannel gate (parity fallback for the existing
 *     InCallChatPanel that requires a channelId).
 *
 * Run: npx tsx scripts/smoke-calloverlays-rtc-chat.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const panel = readFileSync(
  resolve(repoRoot, "client/src/components/call/RtcChatPanel.tsx"),
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

// ── RtcChatPanel ─────────────────────────────────────────────────────────
must(
  /export const RTC_CHAT_TOPIC = "bulldog-call-chat"/.test(panel),
  "RtcChatPanel must export RTC_CHAT_TOPIC = 'bulldog-call-chat'",
);
must(
  /export function RtcChatPanel\(\{\s*lk,\s*onClose,\s*myIdentity\s*\}: Props\)/.test(
    panel,
  ),
  "RtcChatPanel must accept lk, onClose, myIdentity props",
);
must(
  /lk\.onData\(RTC_CHAT_TOPIC,/.test(panel),
  "RtcChatPanel must subscribe with lk.onData(RTC_CHAT_TOPIC, ...)",
);
must(
  /lk\.sendData\(RTC_CHAT_TOPIC,/.test(panel),
  "RtcChatPanel must publish with lk.sendData(RTC_CHAT_TOPIC, ...)",
);
must(
  /return off;/.test(panel),
  "RtcChatPanel must unsubscribe on effect cleanup (return off)",
);
must(
  /data-testid="panel-rtc-chat"/.test(panel),
  "RtcChatPanel must render with data-testid panel-rtc-chat",
);
must(
  /data-testid="rtc-chat-composer"/.test(panel) &&
    /data-testid="rtc-chat-send"/.test(panel) &&
    /data-testid="rtc-chat-close"/.test(panel),
  "RtcChatPanel must expose composer/send/close testids",
);
must(
  /const encoder = new TextEncoder\(\);/.test(panel) &&
    /const decoder = new TextDecoder\(\);/.test(panel),
  "RtcChatPanel must set up TextEncoder + TextDecoder for the wire format",
);
must(
  /JSON\.stringify\(\{\s*id:\s*msg\.id,\s*text:\s*msg\.text,\s*ts:\s*msg\.ts\s*\}\)/.test(
    panel,
  ),
  "RtcChatPanel wire format must be { id, text, ts }",
);
must(
  /if \(fromIdentity && myIdentity && fromIdentity === myIdentity\) return;/.test(
    panel,
  ),
  "RtcChatPanel must skip self-echo packets",
);

// ── CallOverlays wiring ──────────────────────────────────────────────────
must(
  /from "\.\/call\/RtcChatPanel"/.test(overlays),
  "CallOverlays must import RtcChatPanel from ./call/RtcChatPanel",
);
must(
  /\{chatOpen && !hasChannel && \(\s*<RtcChatPanel/.test(overlays),
  "CallOverlays must mount <RtcChatPanel> gated on chatOpen && !hasChannel",
);
must(
  /lk=\{lk\}/.test(overlays),
  "RtcChatPanel mount must forward lk",
);
must(
  /myIdentity=\{lk\.participants\.find\(\(p\) => p\.isLocal\)\?\.identity \?\? null\}/.test(
    overlays,
  ),
  "RtcChatPanel mount must derive myIdentity from lk.participants (local)",
);
must(
  /onClose=\{\(\) => setChatOpen\(false\)\}/.test(overlays),
  "RtcChatPanel mount must close via setChatOpen(false)",
);

// Sanity check: the existing InCallChatPanel path is still gated on
// hasChannel — we didn't accidentally break the channel chat.
must(
  /\{chatOpen && hasChannel && \(\s*<InCallChatPanel/.test(overlays),
  "InCallChatPanel must remain gated on chatOpen && hasChannel",
);

if (failures.length > 0) {
  console.error("SMOKE FAIL: PR E RTC chat");
  for (const f of failures) console.error("  \u2716 " + f);
  process.exit(1);
}

console.log("SMOKE PASS: PR E RTC chat (" + [
  "RtcChatPanel exports RTC_CHAT_TOPIC + subscribes/publishes via lk",
  "wire format { id, text, ts } + self-echo guard",
  "testids (panel/composer/send/close)",
  "CallOverlays mounts RtcChatPanel with !hasChannel gate",
  "InCallChatPanel path untouched (hasChannel gate intact)",
].join(", ") + ")");
