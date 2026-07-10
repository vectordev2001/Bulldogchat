import { useEffect, useMemo, useRef, useState } from "react";
import { ChatApiClient, type ApiDmChannel, type ApiMessage, type ApiUser } from "./api";
import { useWidgetStore, type ConversationRef } from "./state";
import { ChatSyncBridge } from "./sync";
import { useMiniChatSse } from "./hooks/useMiniChatSse";
import { useRingtone, type RingMode } from "./hooks/useRingtone";
import { CallView } from "./CallView";

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
  const pillPosition = useWidgetStore((s) => s.pillPosition);
  const setPillPosition = useWidgetStore((s) => s.setPillPosition);
  const activeCall = useWidgetStore((s) => s.activeCall);
  const setActiveCall = useWidgetStore((s) => s.setActiveCall);
  const incomingCall = useWidgetStore((s) => s.incomingCall);
  const setIncomingCall = useWidgetStore((s) => s.setIncomingCall);

  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<ApiUser | null>(null);
  const [members, setMembers] = useState<ApiUser[]>([]);
  const [dms, setDms] = useState<ApiDmChannel[]>([]);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const [sending, setSending] = useState(false);
  const [startingCall, setStartingCall] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  // ── Draggable pill ────────────────────────────────────────────────────────
  const pillRef = useRef<HTMLButtonElement>(null);
  const dragState = useRef<{ startX: number; startY: number; startRight: number; startBottom: number } | null>(null);

  const onPillPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (open) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startRight: pillPosition.right,
      startBottom: pillPosition.bottom,
    };
  };

  const onPillPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    const newRight = Math.max(8, Math.min(window.innerWidth - 64, dragState.current.startRight - dx));
    const newBottom = Math.max(8, Math.min(window.innerHeight - 64, dragState.current.startBottom + dy));
    setPillPosition({ right: newRight, bottom: newBottom });
  };

  const onPillPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const wasDrag = dragState.current
      ? Math.abs(e.clientX - dragState.current.startX) > 4 || Math.abs(e.clientY - dragState.current.startY) > 4
      : false;
    dragState.current = null;
    if (!wasDrag) setOpen(true);
  };

  // Auth check + initial data load.
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
        /* leave lists empty */
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // ?joinCall=<id> — when the widget is mounted on Contracts/Ops after the user
  // clicked "Pop Out" on an active Chat call, auto-join that call immediately.
  // We read the URL param once on mount, then strip it so a refresh doesn't
  // re-join a long-ended call.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rawId = params.get("joinCall");
    if (!rawId) return;
    const callId = parseInt(rawId, 10);
    if (isNaN(callId) || callId <= 0) return;
    // Strip the param from the URL so it doesn't persist across page refreshes.
    params.delete("joinCall");
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
    window.history.replaceState({}, "", newUrl);
    // Join the call — api.joinCall hits POST /api/calls/:id/accept which returns
    // a fresh LiveKit token even if the caller already accepted (same endpoint
    // acceptCall uses). Open the widget automatically.
    (async () => {
      try {
        const session = await api.joinCall(callId);
        setActiveCall({ callId, roomName: session.roomName, token: session.token, wsUrl: session.ws_url });
        setOpen(true);
      } catch (err) {
        console.warn("[widget] auto-join call failed", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore last-opened conversation from localStorage on mount.
  useEffect(() => {
    if (activeConversation) return;
    const last = sync.readLastConversation();
    if (last) setActiveConversation(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cross-tab sync.
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
    try { setDms(await api.listDms()); } catch { /* keep stale */ }
  };

  const loadMessages = async (conv: ConversationRef) => {
    if (!conv) return;
    setMessagesLoading(true);
    try {
      const msgs = await api.listMessages(conv.id);
      setMessages(msgs);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  };

  useEffect(() => {
    if (activeConversation && open) loadMessages(activeConversation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, activeConversation?.kind, open]);

  // SSE.
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
      if (activeConversation && data?.channelId === activeConversation.id) loadMessages(activeConversation);
    },
    onMessageDelete: (data) => {
      if (activeConversation && data?.channelId === activeConversation.id) loadMessages(activeConversation);
    },
    onDmUpdated: refreshDms,
    onDmCreated: refreshDms,
    onChannelDelete: (data) => {
      if (activeConversation && data?.channelId === activeConversation.id) setActiveConversation(null);
      refreshDms();
    },
    onReopen: () => {
      refreshDms();
      if (activeConversation) loadMessages(activeConversation);
    },
    // Incoming call from SSE
    onCallIncoming: (data) => {
      if (data?.callId && data?.callerName) {
        setIncomingCall({
          callId: data.callId,
          callerId: data.callerId,
          callerName: data.callerName,
          callerHue: data.callerHue,
          kind: data.kind ?? "video",
        });
        setOpen(true);
        // Fire a browser Notification so the callee is alerted even when the
        // widget's tab is backgrounded. `Notification.requestPermission()` is
        // called eagerly on the first authed render (see effect below) so the
        // permission is usually already granted by the time a call arrives.
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            const n = new Notification(`${data.callerName} is calling`, {
              body: data.kind === "voice" ? "Voice call" : "Video call",
              tag: `bulldog-call-${data.callId}`,
              requireInteraction: true,
              icon: "/favicon.ico",
            });
            n.onclick = () => {
              window.focus();
              n.close();
            };
          }
        } catch {
          /* Notifications are best-effort. */
        }
      }
    },
    // Callee accepted — clear any "calling…" spinner on the caller side
    onCallAccepted: () => {
      setStartingCall(false);
    },
    // Call ended / missed / declined — clear active or incoming call state
    onCallEnded: (data) => {
      if (activeCall && data?.callId === activeCall.callId) {
        setActiveCall(null);
      }
      if (incomingCall && data?.callId === incomingCall.callId) {
        setIncomingCall(null);
      }
      setStartingCall(false);
    },
  });

  // Ringtone: incoming chime for the callee, ringback for the caller. Stops
  // automatically when the call is accepted (activeCall becomes truthy) or
  // ended (incomingCall + startingCall both clear).
  const ringMode: RingMode = incomingCall && !activeCall
    ? "incoming"
    : startingCall && !activeCall
      ? "outgoing"
      : null;
  useRingtone(ringMode);

  // Ask for Notification permission once the widget knows the user is logged
  // in, so the browser can raise a native alert (with sound, on the lock
  // screen if the OS allows) when a call arrives while this tab is in the
  // background. If the user denies, we silently fall back to the in-widget
  // banner + ringtone.
  useEffect(() => {
    if (authed !== true) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [authed]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(false);
      else if (e.key === "/" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleOpen(); }
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
      /* leave composer populated */
    } finally {
      setSending(false);
    }
  };

  // ── Start a 1:1 video call ────────────────────────────────────────────────
  const handleStartCall = async () => {
    if (!activeDm || !me || startingCall) return;
    const calleeId = activeDm.memberIds.find((id) => id !== me.id);
    if (!calleeId) return;
    setStartingCall(true);
    setCallError(null);
    try {
      const session = await api.startCall(calleeId, "video");
      setActiveCall({ callId: session.callId, roomName: session.roomName, token: session.token, wsUrl: session.ws_url });
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? "Call failed";
      console.warn("[widget] startCall failed", err);
      setCallError(msg);
      setTimeout(() => setCallError(null), 4000);
    } finally {
      setStartingCall(false);
    }
  };

  // ── Accept / decline incoming call ───────────────────────────────────────
  const handleAcceptCall = async () => {
    if (!incomingCall) return;
    try {
      const session = await api.acceptCall(incomingCall.callId);
      setActiveCall({ callId: incomingCall.callId, roomName: session.roomName, token: session.token, wsUrl: session.ws_url });
      setIncomingCall(null);
    } catch (err) {
      console.warn("[widget] acceptCall failed", err);
    }
  };

  const handleDeclineCall = async () => {
    if (!incomingCall) return;
    try { await api.endCall(incomingCall.callId); } catch { /* best-effort */ }
    setIncomingCall(null);
  };

  if (hidden) return null;

  const userById = new Map(members.map((u) => [u.id, u]));
  const activeDm = activeConversation?.kind === "dm" ? dms.find((d) => d.id === activeConversation.id) : undefined;
  const activeTitle = activeDm
    ? activeDm.title ||
      (me ? activeDm.memberIds.filter((id) => id !== me.id).map((id) => userById.get(id)?.name).filter(Boolean).join(", ") : "Direct message") ||
      "Direct message"
    : activeCall
    ? "In call"
    : "Select a conversation";

  const panelSizeClass = isMobile
    ? "bcw-fixed bcw-inset-0 bcw-w-full bcw-h-full bcw-rounded-none"
    : "bcw-w-[360px] bcw-h-[480px] bcw-rounded-xl";

  // Panel position: clamp so it doesn't go off-screen
  const panelRight = Math.max(8, pillPosition.right - 8);
  const panelBottom = isMobile ? 0 : Math.max(8, pillPosition.bottom + 64);

  return (
    <div
      className="bcw-fixed bcw-z-[1000]"
      style={isMobile ? {} : { right: pillPosition.right, bottom: pillPosition.bottom }}
      data-testid="bulldog-chat-widget-root"
    >
      {/* ── Collapsed pill ── */}
      {!open && (
        <button
          ref={pillRef}
          type="button"
          onPointerDown={onPillPointerDown}
          onPointerMove={onPillPointerMove}
          onPointerUp={onPillPointerUp}
          className="bcw-relative bcw-w-12 bcw-h-12 bcw-rounded-full bcw-bg-bcw-navy bcw-shadow-bcw-panel bcw-flex bcw-items-center bcw-justify-center bcw-text-white bcw-border bcw-border-black/20 hover:bcw-scale-105 bcw-transition-transform bcw-cursor-grab active:bcw-cursor-grabbing bcw-select-none"
          aria-label="Open Bulldog chat"
          data-testid="bulldog-chat-widget-pill"
        >
          <BulldogMark />
          {unreadCount > 0 && (
            <span
              className="bcw-absolute -bcw-top-1 -bcw-right-1 bcw-min-w-[18px] bcw-h-[18px] bcw-px-1 bcw-rounded-full bcw-bg-bcw-red bcw-text-white bcw-text-[10px] bcw-font-bold bcw-flex bcw-items-center bcw-justify-center"
              data-testid="bulldog-chat-widget-badge"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
          {incomingCall && (
            <span className="bcw-absolute -bcw-top-1 -bcw-left-1 bcw-w-3.5 bcw-h-3.5 bcw-rounded-full bcw-bg-green-400 bcw-animate-pulse" />
          )}
        </button>
      )}

      {/* ── Open panel ── */}
      {open && (
        <div
          className={`bcw-bg-bcw-navy bcw-shadow-bcw-panel bcw-flex bcw-flex-col bcw-overflow-hidden bcw-border bcw-border-black/30 ${panelSizeClass}`}
          style={isMobile ? {} : { position: "fixed", right: panelRight, bottom: panelBottom }}
          data-testid="bulldog-chat-widget-panel"
        >
          {/* ── Incoming call banner ── */}
          {incomingCall && (
            <div className="bcw-flex bcw-items-center bcw-gap-2 bcw-px-3 bcw-py-2 bcw-bg-green-900/80 bcw-border-b bcw-border-green-700/50 bcw-shrink-0 bcw-animate-pulse">
              <VideoCallIcon className="bcw-text-green-400 bcw-shrink-0" />
              <span className="bcw-flex-1 bcw-text-xs bcw-text-white bcw-truncate">
                {incomingCall.callerName} is calling…
              </span>
              <button
                type="button"
                onClick={handleAcceptCall}
                className="bcw-px-2 bcw-py-0.5 bcw-rounded bcw-bg-green-500 bcw-text-white bcw-text-xs bcw-font-semibold hover:bcw-bg-green-400"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={handleDeclineCall}
                className="bcw-px-2 bcw-py-0.5 bcw-rounded bcw-bg-red-600 bcw-text-white bcw-text-xs bcw-font-semibold hover:bcw-bg-red-500"
              >
                Decline
              </button>
            </div>
          )}

          {/* ── Header ── */}
          <header className="bcw-h-11 bcw-px-2.5 bcw-flex bcw-items-center bcw-gap-1.5 bcw-border-b bcw-border-black/40 bcw-shrink-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
              aria-label="Toggle conversation list"
              data-testid="bulldog-chat-widget-sidebar-toggle"
            >
              <MenuIcon />
            </button>
            <div className="bcw-flex-1 bcw-min-w-0 bcw-text-xs bcw-font-semibold bcw-text-white bcw-truncate">
              {activeTitle}
            </div>

            {/* Video call button — only when in a DM and not already on a call */}
            {activeDm && !activeCall && (
              <button
                type="button"
                onClick={handleStartCall}
                disabled={startingCall}
                className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/70 hover:bcw-text-white disabled:bcw-opacity-40"
                aria-label="Start video call"
                title="Start video call"
                data-testid="bulldog-chat-widget-call-btn"
              >
                <VideoCallIcon />
              </button>
            )}

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
              aria-label="Minimize"
              title="Minimize  ⌘/"
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

          {/* ── Call error banner ── */}
          {callError && (
            <div className="bcw-px-3 bcw-py-1.5 bcw-bg-red-900/80 bcw-border-b bcw-border-red-700/50 bcw-shrink-0">
              <span className="bcw-text-xs bcw-text-red-200">{callError}</span>
            </div>
          )}

          {/* ── Body ── */}
          <div className="bcw-flex-1 bcw-flex bcw-min-h-0 bcw-relative">
            {sidebarOpen && (
              <div className="bcw-absolute bcw-inset-y-0 bcw-left-0 bcw-w-52 bcw-bg-[hsl(220,60%,9%)] bcw-border-r bcw-border-black/40 bcw-overflow-y-auto bcw-z-10">
                {authed === false ? (
                  <div className="bcw-p-3 bcw-text-xs bcw-text-white/60">Sign in to Bulldog Chat to see your conversations.</div>
                ) : dms.length === 0 ? (
                  <div className="bcw-p-3 bcw-text-xs bcw-text-white/60">No conversations yet.</div>
                ) : (
                  dms.map((dm) => {
                    const others = me ? dm.memberIds.filter((id) => id !== me.id) : dm.memberIds;
                    const label = dm.title || others.map((id) => userById.get(id)?.name).filter(Boolean).join(", ") || "Direct message";
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
              {/* Active call view */}
              {activeCall ? (
                <CallView
                  call={activeCall}
                  api={api}
                  onCallEnded={() => setActiveCall(null)}
                />
              ) : authed === false ? (
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

              {authed !== false && activeConversation && !activeCall && (
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

// ── Sub-components ────────────────────────────────────────────────────────────

function MessageList({
  messages, loading, me, userById,
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
            {!mine && <span className="bcw-text-[10px] bcw-text-white/40 bcw-mb-0.5">{author?.name ?? "Unknown"}</span>}
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

function Composer({ value, onChange, onSend, disabled }: {
  value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean;
}) {
  return (
    <div className="bcw-h-12 bcw-px-2 bcw-flex bcw-items-center bcw-gap-1.5 bcw-border-t bcw-border-black/40 bcw-shrink-0">
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
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
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

// ── Icons ─────────────────────────────────────────────────────────────────────

function BulldogMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.15" />
      <path d="M7 15c0-3 2-6 5-6s5 3 5 6" stroke="white" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <circle cx="9" cy="10" r="1.2" fill="white" />
      <circle cx="15" cy="10" r="1.2" fill="white" />
    </svg>
  );
}
function VideoCallIcon({ className }: { className?: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
function MinimizeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 12h12" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function PaperclipIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M21 12.5l-8.5 8.5a4 4 0 01-5.7-5.7l9-9a2.7 2.7 0 013.8 3.8l-9 9a1.3 1.3 0 01-1.9-1.9l8-8" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 20l18-8L3 4v6l12 2-12 2z" />
    </svg>
  );
}
