/**
 * RtcChatPanel — in-call chat for calls that have no channel (PR E)
 * ---------------------------------------------------------------------
 * Direct (1:1) calls in Bulldogchat don't route through a channel, so the
 * regular InCallChatPanel (which reads/writes channel messages via the
 * REST API) doesn't apply. This panel piggybacks on the existing LiveKit
 * data channel exposed by useLiveKitRoom (sendData / onData) so callers
 * can pass text while on a call without needing any server plumbing.
 *
 * Design notes:
 *   - Ephemeral by design. Messages live only in the panel while the call
 *     is up. Refreshing / rejoining wipes the log; if the user needs a
 *     durable record they should be in a channel call instead. This
 *     mirrors how Google Meet / Zoom handle 1:1 chat.
 *   - No history for late joiners. LiveKit's data channel is fire-and-
 *     forget; a user who joins late won't see earlier messages. We could
 *     replay via a "history-request" round-trip but it's not worth the
 *     complexity for a 2-person call — the peer can just retype.
 *   - Wire format is a small JSON blob: { id, text, ts }. We deliberately
 *     don't send the sender's display name — the topic-level fromIdentity
 *     LiveKit hands us in onData is authoritative, and we look up the
 *     name from the current participant list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import type { useLiveKitRoom } from "@/lib/useLiveKitRoom";

// Keep in sync with the wire format below. Fields are minimal on purpose so
// the JSON blob is small on the wire (data channel packets are limited).
interface RtcChatMessage {
  /** Client-generated id; used only for React keys. */
  id: string;
  /** Message body. Plain text; renderers keep whitespace. */
  text: string;
  /** ms since epoch when the sender created the message. */
  ts: number;
  /**
   * Identity of the sender as reported by LiveKit's onData callback.
   * Populated by the panel on receive; senders leave it undefined. */
  fromIdentity?: string;
}

// Data-channel topic. Kept short (LiveKit sends the topic as a string with
// every packet). Namespaced so future in-call features can pick their own
// topic without collision (e.g. reactions used "reactions").
export const RTC_CHAT_TOPIC = "bulldog-call-chat";

interface Props {
  /** LiveKit hook result — panel reads participants, sends + receives data. */
  lk: ReturnType<typeof useLiveKitRoom>;
  onClose: () => void;
  /** Local user identity (usually "u_<userId>"). Used to render "You" and
   *  to skip echoing our own sent messages back into the panel — LiveKit's
   *  data channel does not echo publisher packets to themselves, but we
   *  optimistically append locally so the sender sees their own message
   *  instantly. */
  myIdentity: string | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function RtcChatPanel({ lk, onClose, myIdentity }: Props) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<RtcChatMessage[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Subscribe to incoming chat packets. The hook's onData returns an
  // unsubscribe fn we hand to the effect cleanup so hot-reload / remount
  // doesn't stack duplicate listeners.
  useEffect(() => {
    const off = lk.onData(RTC_CHAT_TOPIC, (payload, fromIdentity) => {
      try {
        const text = decoder.decode(payload);
        const parsed = JSON.parse(text) as Partial<RtcChatMessage>;
        if (!parsed || typeof parsed.text !== "string") return;
        // Ignore our own packets — LiveKit doesn't echo them, but a mesh
        // topology could conceivably relay one; guarding is cheap.
        if (fromIdentity && myIdentity && fromIdentity === myIdentity) return;
        const msg: RtcChatMessage = {
          id: typeof parsed.id === "string" && parsed.id ? parsed.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: parsed.text,
          ts: typeof parsed.ts === "number" ? parsed.ts : Date.now(),
          fromIdentity,
        };
        setMessages((prev) => [...prev, msg].slice(-100));
      } catch {
        // Malformed packet — ignore. A future protocol version could add
        // a "kind" field for typed events; today we only speak chat.
      }
    });
    return off;
  }, [lk, myIdentity]);

  // Auto-scroll to bottom on new messages. requestAnimationFrame so the
  // DOM has appended the new row before we measure scrollHeight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages.length]);

  // Focus the composer on mount so the user can start typing immediately.
  useEffect(() => { taRef.current?.focus(); }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const msg: RtcChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      ts: Date.now(),
    };
    // Optimistic local append — sender sees their own message immediately.
    setMessages((prev) => [...prev, { ...msg, fromIdentity: myIdentity ?? undefined }].slice(-100));
    setDraft("");
    // Ship over the data channel. sendData no-ops if the room isn't
    // connected, which is fine — the message is still in the local log
    // for the sender; the peer just missed it. (Same UX Google Meet's
    // pre-connect chat has.)
    try {
      lk.sendData(RTC_CHAT_TOPIC, encoder.encode(JSON.stringify({ id: msg.id, text: msg.text, ts: msg.ts })));
    } catch {
      /* ignore — data channel unavailable */
    }
    requestAnimationFrame(() => taRef.current?.focus());
  }, [draft, lk, myIdentity]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts newline. Match InCallChatPanel.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  // Look up a friendly name for a given identity from the live participant
  // list. Falls back to the raw identity when we can't find them (e.g.
  // guest joins from Teams / meeting bridge that use a different scheme).
  function nameFor(identity: string | undefined): string {
    if (!identity) return "Someone";
    const p = lk.participants.find((pp) => pp.identity === identity);
    if (p) return p.name;
    return identity;
  }

  return (
    <div className="w-full sm:w-[360px] h-full flex flex-col bg-[hsl(220_55%_10%)] border-l border-[hsl(220_40%_22%)]" data-testid="panel-rtc-chat">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[hsl(220_40%_22%)] bg-[hsl(220_60%_11%)]">
        <div className="text-sm font-semibold text-white">In-call chat</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="p-1 rounded hover:bg-[hsl(220_50%_18%)] text-[hsl(0_0%_70%)]"
          data-testid="rtc-chat-close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 ? (
          <div className="text-center py-6 text-[hsl(0_0%_60%)] text-xs">
            Messages stay in this call only.
          </div>
        ) : (
          messages.map((m) => {
            const mine = myIdentity != null && m.fromIdentity === myIdentity;
            return (
              <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                <div className="text-[10px] text-[hsl(0_0%_60%)] px-1 mb-0.5">
                  {mine ? "You" : nameFor(m.fromIdentity)}
                </div>
                <div
                  className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-sm break-words whitespace-pre-wrap ${
                    mine
                      ? "bg-vs-blue text-[hsl(220_60%_9%)]"
                      : "bg-[hsl(220_50%_18%)] text-white"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-[hsl(220_40%_22%)] bg-[hsl(220_60%_11%)] p-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message this call…"
            rows={1}
            className="flex-1 resize-none rounded-md bg-[hsl(220_50%_15%)] border border-[hsl(220_40%_22%)] text-white text-sm placeholder:text-[hsl(0_0%_50%)] px-3 py-2 focus:outline-none focus:ring-1 focus:ring-vs-blue max-h-[120px] overflow-y-auto"
            data-testid="rtc-chat-composer"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim()}
            className="shrink-0 h-9 w-9 rounded-md bg-vs-blue text-[hsl(220_60%_9%)] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-vs-blue-light"
            aria-label="Send"
            data-testid="rtc-chat-send"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
