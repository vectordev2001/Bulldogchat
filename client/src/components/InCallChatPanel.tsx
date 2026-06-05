/**
 * In-call chat side panel (Phase 1.9.28)
 * --------------------------------------
 * Lightweight chat sidebar shown when the user taps the "Chat" toolbar button
 * during an active call. Mirrors the channel's messages and lets the user type
 * + send without leaving the call overlay.
 *
 * Why not embed TextChannelView? TextChannelView is the full channel UI with
 * threads, mentions, attachments, slash commands, etc. Way too heavy for an
 * overlay sidebar. This panel deliberately keeps just: list of recent messages
 * + compose textarea + send button. For everything else, the user can hang up
 * and open the channel directly.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Send, X, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { ApiMessage, ApiUser } from "@/types/api";

interface Props {
  channelId: number;
  onClose: () => void;
}

export function InCallChatPanel({ channelId, onClose }: Props) {
  const { user } = useAuth();
  const me = (user as ApiUser | null) ?? null;
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: messages = [], isLoading } = useQuery<ApiMessage[]>({
    queryKey: ["/api/channels", channelId, "messages"],
    // Poll every 3s while the panel is open so new messages from other
    // participants show up without needing a WS subscription.
    refetchInterval: 3000,
  });

  // Auto-scroll to bottom whenever new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Defer to next frame so DOM has new nodes.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length]);

  // Focus the composer on mount so the user can immediately type.
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      apiRequest<ApiMessage>("POST", `/api/channels/${channelId}/messages`, {
        content,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "messages"] });
    },
  });

  function send() {
    const text = draft.trim();
    if (!text || sendMutation.isPending) return;
    sendMutation.mutate(text);
    setDraft("");
    // Keep focus in the textarea for rapid follow-ups.
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts newline (Slack-style).
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="w-full sm:w-[360px] h-full flex flex-col bg-[hsl(232_55%_10%)] border-l border-[hsl(232_40%_22%)]">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[hsl(232_40%_22%)] bg-[hsl(232_60%_11%)]">
        <div className="text-sm font-semibold text-white">In-call chat</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="p-1 rounded hover:bg-[hsl(232_50%_18%)] text-[hsl(0_0%_70%)]"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {isLoading && messages.length === 0 ? (
          <div className="flex items-center justify-center py-6 text-[hsl(0_0%_60%)] text-xs">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-6 text-[hsl(0_0%_60%)] text-xs">
            No messages yet. Say hi.
          </div>
        ) : (
          messages.slice(-50).map((m) => {
            const mine = me != null && m.userId === me.id;
            const isSystem = m.meta != null;
            // For system messages just render a centered hint.
            if (isSystem) {
              return (
                <div key={m.id} className="text-center text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] py-1">
                  {m.content || "—"}
                </div>
              );
            }
            if (m.deletedAt) {
              return (
                <div key={m.id} className="text-center text-[10px] italic text-[hsl(0_0%_55%)] py-1">
                  Message deleted
                </div>
              );
            }
            return (
              <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                <div className="text-[10px] text-[hsl(0_0%_60%)] px-1 mb-0.5">
                  {mine ? "You" : (m.authorName || `User ${m.userId}`)}
                </div>
                <div
                  className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-sm break-words whitespace-pre-wrap ${
                    mine
                      ? "bg-vs-blue text-[hsl(232_60%_9%)]"
                      : "bg-[hsl(232_50%_18%)] text-white"
                  }`}
                >
                  {m.content || "[attachment]"}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-[hsl(232_40%_22%)] bg-[hsl(232_60%_11%)] p-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message the channel…"
            rows={1}
            className="flex-1 resize-none rounded-md bg-[hsl(232_50%_15%)] border border-[hsl(232_40%_22%)] text-white text-sm placeholder:text-[hsl(0_0%_50%)] px-3 py-2 focus:outline-none focus:ring-1 focus:ring-vs-blue max-h-[120px] overflow-y-auto"
            data-testid="incall-chat-composer"
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim() || sendMutation.isPending}
            className="shrink-0 h-9 w-9 rounded-md bg-vs-blue text-[hsl(232_60%_9%)] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-vs-blue-light"
            aria-label="Send"
            data-testid="incall-chat-send"
          >
            {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
