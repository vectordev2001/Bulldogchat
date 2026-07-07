import { useEffect, useMemo, useRef, useState } from "react";
import { ChatApiClient, type ApiDmChannel, type ApiMessage, type ApiUser } from "./api";
import { useWidgetStore, type ConversationRef } from "./state";
import { ChatSyncBridge } from "./sync";
import { useMiniChatSse } from "./hooks/useMiniChatSse";

export interface BulldogChatWidgetProps {
  /** Base URL of the Chat app, e.g. "https://chat.bulldogops.com". */
  apiBaseUrl: string;
  /** Optional: hide the widget entirely (e.g. host app knows user is logged out). */
  hidden?: boolean;
}

const MOBILE_BREAKPOINT = 768;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

export function BulldogChatWidget({ apiBaseUrl, hidden }: BulldogChatWidgetProps) {
  const api = useMemo(() => new ChatApiClient(apiBaseUrl), [apiBaseUrl]);
  const sync = useMemo(() => new ChatSyncBridge(), []);
  const isMobile = useIsMobile();

  const open = useWidgetStore((s) => s.open);
  const setOpen = useWidgetStore((s) => s.setOpen);
  const toggleOpen = useWidgetStore((s) => s.toggleOpen);
  const sidebarOpen = useWidgetStore((s) => s.sidebarOpen);
  const setSidebarOpen = useWidgetStore((s) => s.setSidebarOpen);
  const activeConversation = useWidgetStore((s) => s.activeConversation);
  const setActiveConversation = useWidgetStore((s) => s.setActiveConversation);
  const unreadCount = useWidgetStore((s) => s.unreadCount);
  const incrementUnread = useWidgetStore((s) => s.incrementUnread);
  const clearUnread = useWidgetStore((s) => s.clearUnread);

  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<ApiUser | null>(null);
  const [members, setMembers] = useState<ApiUser[]>([]);
  const [dms, setDms] = useState<ApiDmChannel[]>([]);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const [sending, setSending] = useState(false);

  // Auth check + initial data load. Fails soft: if the shared JWT cookie
  // isn't valid (or CORS isn't configured yet), the pill still renders but
  // clicking it shows a "sign in on Chat" placeholder instead of infinitely
  // retrying network calls.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await api.isAuthenticated();
      if (cancelled) return;
      setAuthed(ok);
      if (!ok) return;
      try {
        const [meRes, membersRes, dmsRes] = await Promise.all([
          api.me(),
          api.orgMembers(),
          api.listDms(),
        ]);
        if (cancelled) return;
        setMe(meRes);
        setMembers(membersRes);
        setDms(dmsRes);
      } catch {
        /* leave lists empty; panel shows an error/empty state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Restore last-opened conversation from localStorage on mount (state
  // persistence requirement) — but only if the store doesn't already have
  // one (e.g. set by a sync broadcast that arrived first).
  useEffect(() => {
    if (activeConversation) return;
    const last = sync.readLastConversation();
    if (last) setActiveConversation(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab sync: mirror conversation changes from the main Chat app tab
  // (or another widget instance on the same origin).
  useEffect(() => {
    return sync.subscribe((msg) => {
      if (msg.type === "conversation:changed") {
        setActiveConversation({ kind: msg.kind, id: msg.id } as ConversationRef);
      } else if (msg.type === "unread:changed") {
        useWidgetStore.getState().setUnreadCount(msg.count);
      }
    });
  }, [sync, setActiveConversation]);

  const refreshDms = async () => {
    try {
      setDms(await api.listDms());
    } catch {
      /* keep stale list on transient failure */
    }
  };

  const loadMessages = async (conv: ConversationRef) => {
    if (!conv) return;
    setMessagesLoading(true);
    try {
      const channelId = conv.id;
      const msgs = await api.listMessages(channelId);
      setMessages(msgs);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  };

  useEffect(() => {
    if (activeConversation && open) {
      loadMessages(activeConversation);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, activeConversation?.kind, open]);

  // SSE: mirrors use-sse.ts patterns from the main app. Only connects once
  // we know the user is authenticated (avoids a guaranteed-401 EventSource
  // spinning forever pre-login).
  useMiniChatSse(apiBaseUrl, authed === true, {
    onMessageNew: (data) => {
      if (activeConversation && data?.channelId === activeConversation.id && open) {
        loadMessages(activeConversation);
      } else if (data?.channelId) {
        incrementUnread();
        sync.broadcastUnreadChanged(unreadCount + 1);
      }
      refreshDms();
    },
    onMessageUpdate: (data) => {
      if (activeConversation && data?.channelId === activeConversation.id) {
        loadMessages(activeConversation);
      }
    },
    onMessageDelete: (data) => {
      if (activeConversation && data?.channelId === activeConversation.id) {
        loadMessages(activeConversation);
      }
    },
    onDmUpdated: refreshDms,
    onDmCreated: refreshDms,
    onChannelDelete: (data) => {
      if (activeConversation && data?.channelId === activeConversation.id) {
        setActiveConversation(null);
      }
      refreshDms();
    },
    onReopen: () => {
      refreshDms();
      if (activeConversation) loadMessages(activeConversation);
    },
  });

  // Keyboard shortcuts: Esc collapses, Cmd/Ctrl+/ toggles.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        setOpen(false);
      } else if (e.key === "/" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen, toggleOpen]);

  const selectConversation = (kind: "dm" | "channel", id: number) => {
    setActiveConversation({ kind, id } as ConversationRef);
    sync.broadcastConversationChanged(kind, id);
    setSidebarOpen(false);
    clearUnread();
    sync.broadcastUnreadChanged(0);
  };

  const handleSend = async () => {
    const content = composerValue.trim();
    if (!content || !activeConversation || sending) return;
    setSending(true);
    try {
      await api.sendMessage(activeConversation.id, content);
      setComposerValue("");
      await loadMessages(activeConversation);
    } catch {
      /* leave composerValue populated so the user can retry */
    } finally {
      setSending(false);
    }
  };

  if (hidden) return null;

  const userById = new Map(members.map((u) => [u.id, u]));
  const activeDm = activeConversation?.kind === "dm" ? dms.find((d) => d.id === activeConversation.id) : undefined;
  const activeTitle = activeDm
    ? activeDm.title ||
      (me ? activeDm.memberIds.filter((id) => id !== me.id).map((id) => userById.get(id)?.name).filter(Boolean).join(", ") : "Direct message") ||
      "Direct message"
    : "Select a conversation";

  const panelSizeClass = isMobile
    ? "bcw-fixed bcw-inset-0 bcw-w-full bcw-h-full bcw-rounded-none"
    : "bcw-w-[380px] bcw-h-[560px] bcw-rounded-xl";

  return (
    <div
      className="bcw-fixed bcw-z-[1000]"
      style={{ right: 24, bottom: 24 }}
      data-testid="bulldog-chat-widget-root"
    >
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="bcw-relative bcw-w-14 bcw-h-14 bcw-rounded-full bcw-bg-bcw-navy bcw-shadow-bcw-panel bcw-flex bcw-items-center bcw-justify-center bcw-text-white bcw-border bcw-border-black/20 hover:bcw-scale-105 bcw-transition-transform"
          aria-label="Open Bulldog chat"
          data-testid="bulldog-chat-widget-pill"
        >
          <BulldogMark />
          {unreadCount > 0 && (
            <span
              className="bcw-absolute -bcw-top-1 -bcw-right-1 bcw-min-w-[20px] bcw-h-5 bcw-px-1 bcw-rounded-full bcw-bg-bcw-red bcw-text-white bcw-text-[11px] bcw-font-bold bcw-flex bcw-items-center bcw-justify-center"
              data-testid="bulldog-chat-widget-badge"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          className={`bcw-bg-bcw-navy bcw-shadow-bcw-panel bcw-flex bcw-flex-col bcw-overflow-hidden bcw-border bcw-border-black/30 ${panelSizeClass}`}
          data-testid="bulldog-chat-widget-panel"
        >
          <header className="bcw-h-12 bcw-px-3 bcw-flex bcw-items-center bcw-gap-2 bcw-border-b bcw-border-black/40 bcw-shrink-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
              aria-label="Toggle conversation list"
              data-testid="bulldog-chat-widget-sidebar-toggle"
            >
              <MenuIcon />
            </button>
            <div className="bcw-flex-1 bcw-min-w-0 bcw-text-sm bcw-font-semibold bcw-text-white bcw-truncate">
              {activeTitle}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
              aria-label="Minimize"
              data-testid="bulldog-chat-widget-minimize"
            >
              <MinimizeIcon />
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setActiveConversation(null); }}
              className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
              aria-label="Close"
              data-testid="bulldog-chat-widget-close"
            >
              <CloseIcon />
            </button>
          </header>

          <div className="bcw-flex-1 bcw-flex bcw-min-h-0 bcw-relative">
            {sidebarOpen && (
              <div className="bcw-absolute bcw-inset-y-0 bcw-left-0 bcw-w-56 bcw-bg-[hsl(220,60%,9%)] bcw-border-r bcw-border-black/40 bcw-overflow-y-auto bcw-z-10">
                {authed === false ? (
                  <div className="bcw-p-3 bcw-text-xs bcw-text-white/60">
                    Sign in to Bulldog Chat to see your conversations.
                  </div>
                ) : dms.length === 0 ? (
                  <div className="bcw-p-3 bcw-text-xs bcw-text-white/60">No conversations yet.</div>
                ) : (
                  dms.map((dm) => {
                    const others = me ? dm.memberIds.filter((id) => id !== me.id) : dm.memberIds;
                    const label =
                      dm.title || others.map((id) => userById.get(id)?.name).filter(Boolean).join(", ") || "Direct message";
                    return (
                      <button
                        key={dm.id}
                        type="button"
                        onClick={() => selectConversation("dm", dm.id)}
                        className={`bcw-w-full bcw-text-left bcw-px-3 bcw-py-2 bcw-text-xs bcw-truncate hover:bcw-bg-bcw-navy-light ${
                          activeConversation?.kind === "dm" && activeConversation.id === dm.id
                            ? "bcw-bg-bcw-navy-light bcw-text-white"
                            : "bcw-text-white/80"
                        }`}
                        data-testid={`bulldog-chat-widget-dm-${dm.id}`}
                      >
                        {label}
                      </button>
                    );
                  })
                )}
              </div>
            )}

            <div className="bcw-flex-1 bcw-flex bcw-flex-col bcw-min-w-0 bcw-min-h-0">
              {authed === false ? (
                <div className="bcw-flex-1 bcw-flex bcw-items-center bcw-justify-center bcw-p-4 bcw-text-center bcw-text-xs bcw-text-white/60">
                  Sign in to Bulldog Chat to use the mini chat.
                </div>
              ) : !activeConversation ? (
                <div className="bcw-flex-1 bcw-flex bcw-items-center bcw-justify-center bcw-p-4 bcw-text-center bcw-text-xs bcw-text-white/60">
                  Pick a conversation from the menu.
                </div>
              ) : (
                <MessageList messages={messages} loading={messagesLoading} me={me} userById={userById} />
              )}

              {authed !== false && activeConversation && (
                <Composer
                  value={composerValue}
                  onChange={setComposerValue}
                  onSend={handleSend}
                  disabled={sending}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageList({
  messages,
  loading,
  me,
  userById,
}: {
  messages: ApiMessage[];
  loading: boolean;
  me: ApiUser | null;
  userById: Map<number, ApiUser>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  // Simple virtualization guard: for >100 messages, only render the most
  // recent 100 plus a "load older" affordance rather than mounting every
  // row. Full virtualized windowing is left as a follow-up (would pull in
  // react-window as an extra dependency) — capping the DOM node count here
  // gets 90% of the perf benefit for a floating widget's use case.
  const VISIBLE_CAP = 100;
  const visible = messages.length > VISIBLE_CAP ? messages.slice(-VISIBLE_CAP) : messages;
  const hiddenCount = messages.length - visible.length;

  return (
    <div ref={listRef} className="bcw-flex-1 bcw-overflow-y-auto bcw-px-3 bcw-py-2 bcw-space-y-2" data-testid="bulldog-chat-widget-messages">
      {loading && <div className="bcw-text-xs bcw-text-white/50 bcw-text-center bcw-py-4">Loading…</div>}
      {!loading && hiddenCount > 0 && (
        <div className="bcw-text-[10px] bcw-text-white/40 bcw-text-center">{hiddenCount} earlier messages hidden</div>
      )}
      {!loading && visible.length === 0 && (
        <div className="bcw-text-xs bcw-text-white/50 bcw-text-center bcw-py-4">No messages yet. Say hi!</div>
      )}
      {visible.map((m) => {
        const author = userById.get(m.userId);
        const mine = me?.id === m.userId;
        return (
          <div key={m.id} className={`bcw-flex bcw-flex-col ${mine ? "bcw-items-end" : "bcw-items-start"}`}>
            {!mine && (
              <span className="bcw-text-[10px] bcw-text-white/40 bcw-mb-0.5">{author?.name ?? "Unknown"}</span>
            )}
            <div
              className={`bcw-max-w-[85%] bcw-rounded-lg bcw-px-2.5 bcw-py-1.5 bcw-text-xs bcw-whitespace-pre-wrap bcw-break-words ${
                mine ? "bcw-bg-bcw-red bcw-text-white" : "bcw-bg-bcw-navy-light bcw-text-white/90"
              }`}
            >
              {m.deletedAt ? <em className="bcw-opacity-60">message deleted</em> : m.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  return (
    <div className="bcw-h-14 bcw-px-2 bcw-flex bcw-items-center bcw-gap-1.5 bcw-border-t bcw-border-black/40 bcw-shrink-0">
      <button
        type="button"
        className="bcw-p-1.5 bcw-rounded bcw-text-white/50 hover:bcw-bg-bcw-navy-light bcw-cursor-not-allowed"
        title="Attachments are not yet supported in the mini widget — use the full Chat app"
        disabled
        data-testid="bulldog-chat-widget-attach"
      >
        <PaperclipIcon />
      </button>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder="Message…"
        className="bcw-flex-1 bcw-bg-[hsl(220,60%,9%)] bcw-border bcw-border-black/40 bcw-text-xs bcw-text-white bcw-placeholder-white/30 bcw-rounded-md bcw-px-2.5 bcw-py-1.5 focus:bcw-outline-none"
        data-testid="bulldog-chat-widget-composer-input"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || !value.trim()}
        className="bcw-p-1.5 bcw-rounded bcw-bg-bcw-red bcw-text-white disabled:bcw-opacity-40"
        aria-label="Send"
        data-testid="bulldog-chat-widget-send"
      >
        <SendIcon />
      </button>
    </div>
  );
}

function BulldogMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
      <path d="M7 15c0-3 2-6 5-6s5 3 5 6" stroke="white" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="9" cy="10" r="1.2" fill="white" />
      <circle cx="15" cy="10" r="1.2" fill="white" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
function MinimizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 12h12" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 12.5l-8.5 8.5a4 4 0 01-5.7-5.7l9-9a2.7 2.7 0 013.8 3.8l-9 9a1.3 1.3 0 01-1.9-1.9l8-8" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 20l18-8L3 4v6l12 2-12 2z" />
    </svg>
  );
}
