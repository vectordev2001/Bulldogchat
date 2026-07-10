import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChatApiClient,
  type ApiAttachment,
  type ApiChannel,
  type ApiDmChannel,
  type ApiMessage,
  type ApiProject,
  type ApiUser,
} from "./api";
import { useWidgetStore, type ConversationRef } from "./state";
import { ChatSyncBridge } from "./sync";
import { useMiniChatSse } from "./hooks/useMiniChatSse";
import { useRingtone, playMentionChime, type RingMode } from "./hooks/useRingtone";
import { useBrowserNotifications } from "./hooks/useBrowserNotifications";
import { formatFileSize, isImageAttachment, mentionsUser, mergeOlderMessages, parseMentions } from "./format";
import { CallView } from "./CallView";

// Number of messages fetched per page. Matches the server default limit; a
// full page coming back is the signal that older history may still exist.
const PAGE_SIZE = 50;

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
  const activeTab = useWidgetStore((s) => s.activeTab);
  const setActiveTab = useWidgetStore((s) => s.setActiveTab);
  const browserNotificationsEnabled = useWidgetStore((s) => s.browserNotificationsEnabled);
  const setBrowserNotificationsEnabled = useWidgetStore((s) => s.setBrowserNotificationsEnabled);
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
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [channelsByProject, setChannelsByProject] = useState<Map<number, ApiChannel[]>>(new Map());
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [composerValue, setComposerValue] = useState("");
  const [sending, setSending] = useState(false);
  const [startingCall, setStartingCall] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  // Pagination bookkeeping. Refs (not state) so the SSE / scroll callbacks read
  // fresh values without being re-created every render:
  //   loadingOlderRef → guards against overlapping "load older" fetches when
  //     the user keeps the scrollbar pinned at the top.
  //   hasMoreRef → false once the server returns a short page, so we stop
  //     hammering the endpoint after the earliest message is reached.
  const loadingOlderRef = useRef(false);
  const hasMoreRef = useRef(true);

  const { permission: notifPermission, requestPermission, notify } = useBrowserNotifications();

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
      // Group channels load separately so a projects/channels failure never
      // blocks the DM list (the widget's primary use). We fetch each project's
      // channels in parallel and key them by project id for the sidebar.
      try {
        const projectsRes = await api.listProjects();
        if (cancelled) return;
        setProjects(projectsRes);
        const entries = await Promise.all(
          projectsRes.map(async (p) => {
            try {
              return [p.id, await api.listProjectChannels(p.id)] as const;
            } catch {
              return [p.id, [] as ApiChannel[]] as const;
            }
          }),
        );
        if (cancelled) return;
        setChannelsByProject(new Map(entries));
      } catch {
        /* no group channels — sidebar Channels tab shows an empty state */
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
    // Reset pagination for the new conversation: assume more history exists
    // until the first page proves otherwise, and drop any in-flight guard.
    hasMoreRef.current = true;
    loadingOlderRef.current = false;
    try {
      const msgs = await api.listMessages(conv.id, undefined, PAGE_SIZE);
      setMessages(msgs);
      // A short first page means we already have the entire history.
      if (msgs.length < PAGE_SIZE) hasMoreRef.current = false;
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  };

  // Fetch the page of messages older than the earliest one currently loaded
  // and prepend it. Guarded so overlapping scroll events (double-fetch) and
  // scrolling past the start of history (no-more) are both no-ops. Scroll
  // position is preserved by MessageList, which measures scrollHeight around
  // the prepend.
  const loadOlderMessages = async () => {
    const conv = activeConversation;
    if (!conv || loadingOlderRef.current || !hasMoreRef.current) return;
    const oldest = messages[0];
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const older = await api.listMessages(conv.id, oldest.id, PAGE_SIZE);
      if (older.length < PAGE_SIZE) hasMoreRef.current = false;
      if (older.length > 0) {
        // Dedupe defensively in case a boundary message overlaps.
        setMessages((prev) => mergeOlderMessages(older, prev));
      }
    } catch {
      /* keep what we have; allow a retry on the next scroll */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    if (activeConversation && open) loadMessages(activeConversation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, activeConversation?.kind, open]);

  // Human label for a channel id, used in notification bodies. DMs resolve to
  // member names / title; group channels to "#name". Falls back gracefully.
  const titleForChannel = (channelId: number): string => {
    const dm = dms.find((d) => d.id === channelId);
    if (dm) {
      const others = me ? dm.memberIds.filter((id) => id !== me.id) : dm.memberIds;
      return (
        dm.title ||
        others.map((id) => members.find((u) => u.id === id)?.name).filter(Boolean).join(", ") ||
        "Direct message"
      );
    }
    for (const list of channelsByProject.values()) {
      const ch = list.find((c) => c.id === channelId);
      if (ch) return `#${ch.name}`;
    }
    return "Bulldog Chat";
  };

  // Whether an incoming SSE message mentions the current user. The SSE payload
  // carries `content` (and, if the server ever adds it, `mentions`) but not the
  // resolved mentions array today, so we also scan the raw content for both the
  // numeric `<@id>` markup and the `@firstname` handle the composer emits.
  const incomingMentionsMe = (data: any): boolean => {
    if (!me) return false;
    if (Array.isArray(data?.mentions) && mentionsUser(data.mentions, me.id)) return true;
    const content = typeof data?.content === "string" ? data.content : "";
    if (content.includes(`<@${me.id}>`)) return true;
    const first = me.name.split(/\s+/)[0]?.toLowerCase();
    if (first && new RegExp(`@${first}(?![a-z0-9_.-])`, "i").test(content)) return true;
    return false;
  };

  // SSE.
  useMiniChatSse(apiBaseUrl, authed === true, {
    onMessageNew: (data) => {
      const isActiveAndOpen = activeConversation && data?.channelId === activeConversation.id && open;
      if (isActiveAndOpen) {
        loadMessages(activeConversation);
      } else if (data?.channelId) {
        incrementUnread();
        sync.broadcastUnreadChanged(unreadCount + 1);
      }
      // Alerting mirrors the incrementUnread rule: only alert when the message
      // is somewhere the user isn't actively reading (widget closed, or a
      // different conversation). Never alert for the user's own messages.
      const isMine = me != null && data?.userId === me.id;
      if (data?.channelId && !isActiveAndOpen && !isMine) {
        const mentioned = incomingMentionsMe(data);
        const convTitle = titleForChannel(data.channelId);
        if (mentioned) {
          // Mentions get a more prominent sound + a distinct notification title.
          playMentionChime();
        }
        if (browserNotificationsEnabled) {
          notify({
            title: mentioned ? `You were mentioned in ${convTitle}` : convTitle,
            body: typeof data?.content === "string" ? data.content.slice(0, 140) : undefined,
            // tag = conversation id so repeat pings about the same conversation
            // replace each other instead of stacking a tower of toasts.
            tag: `bcw-conv-${data.channelId}`,
            onClick: () => {
              setOpen(true);
              selectConversation(dms.some((d) => d.id === data.channelId) ? "dm" : "channel", data.channelId);
            },
          });
        }
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

  // Notification permission is now requested via an explicit user gesture — the
  // "Enable notifications" pill below — rather than eagerly on login. Browsers
  // increasingly ignore non-gesture permission prompts, and a gesture-driven
  // opt-in is friendlier. Call + message notifications both check
  // Notification.permission === "granted" at fire time, so granting via the
  // pill lights up both paths.

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
  const activeChannel = activeConversation?.kind === "channel"
    ? [...channelsByProject.values()].flat().find((c) => c.id === activeConversation.id)
    : undefined;
  const activeTitle = activeDm
    ? activeDm.title ||
      (me ? activeDm.memberIds.filter((id) => id !== me.id).map((id) => userById.get(id)?.name).filter(Boolean).join(", ") : "Direct message") ||
      "Direct message"
    : activeChannel
    ? `# ${activeChannel.name}`
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

          {/* ── Enable-notifications pill ── */}
          {/* Only shown while permission is still "default": granting or denying
              hides it, and denied stays hidden so we never nag. */}
          {authed !== false && notifPermission === "default" && (
            <div className="bcw-px-2.5 bcw-py-1.5 bcw-border-b bcw-border-black/40 bcw-shrink-0">
              <button
                type="button"
                onClick={() => { requestPermission(); }}
                className="bcw-w-full bcw-flex bcw-items-center bcw-justify-center bcw-gap-1.5 bcw-px-2 bcw-py-1 bcw-rounded-full bcw-bg-bcw-navy-light bcw-text-white/90 bcw-text-[11px] bcw-font-medium hover:bcw-bg-bcw-red bcw-transition-colors"
                data-testid="bulldog-chat-widget-enable-notifications"
              >
                <BellIcon />
                Enable notifications
              </button>
            </div>
          )}

          {/* ── Body ── */}
          <div className="bcw-flex-1 bcw-flex bcw-min-h-0 bcw-relative">
            {sidebarOpen && (
              <div className="bcw-absolute bcw-inset-y-0 bcw-left-0 bcw-w-52 bcw-bg-[hsl(220,60%,9%)] bcw-border-r bcw-border-black/40 bcw-flex bcw-flex-col bcw-z-10">
                {/* Tab strip: DMs vs group Channels. The chosen tab is persisted
                    in the store so it survives reopen/reload. */}
                <div className="bcw-flex bcw-shrink-0 bcw-border-b bcw-border-black/40">
                  {(["dms", "channels"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      className={`bcw-flex-1 bcw-py-1.5 bcw-text-[11px] bcw-font-semibold bcw-uppercase bcw-tracking-wide ${
                        activeTab === tab
                          ? "bcw-text-white bcw-border-b-2 bcw-border-bcw-red"
                          : "bcw-text-white/50 hover:bcw-text-white/80"
                      }`}
                      data-testid={`bulldog-chat-widget-tab-${tab}`}
                    >
                      {tab === "dms" ? "DMs" : "Channels"}
                    </button>
                  ))}
                </div>

                <div className="bcw-flex-1 bcw-overflow-y-auto">
                  {authed === false ? (
                    <div className="bcw-p-3 bcw-text-xs bcw-text-white/60">Sign in to Bulldog Chat to see your conversations.</div>
                  ) : activeTab === "dms" ? (
                    dms.length === 0 ? (
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
                    )
                  ) : projects.length === 0 ? (
                    <div className="bcw-p-3 bcw-text-xs bcw-text-white/60">No channels available.</div>
                  ) : (
                    projects.map((project) => {
                      const channels = channelsByProject.get(project.id) ?? [];
                      if (channels.length === 0) return null;
                      return (
                        <div key={project.id} className="bcw-py-1">
                          <div className="bcw-px-3 bcw-py-1 bcw-text-[10px] bcw-font-semibold bcw-uppercase bcw-tracking-wide bcw-text-white/40 bcw-truncate">
                            {project.name}
                          </div>
                          {channels.map((ch) => (
                            <button
                              key={ch.id}
                              type="button"
                              onClick={() => selectConversation("channel", ch.id)}
                              className={`bcw-w-full bcw-text-left bcw-px-3 bcw-py-2 bcw-text-xs bcw-truncate hover:bcw-bg-bcw-navy-light ${
                                activeConversation?.kind === "channel" && activeConversation.id === ch.id
                                  ? "bcw-bg-bcw-navy-light bcw-text-white"
                                  : "bcw-text-white/80"
                              }`}
                              data-testid={`bulldog-chat-widget-channel-${ch.id}`}
                            >
                              # {ch.name}
                            </button>
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>
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
                <MessageList
                  messages={messages}
                  loading={messagesLoading}
                  loadingOlder={loadingOlder}
                  hasMore={hasMoreRef.current}
                  onLoadOlder={loadOlderMessages}
                  me={me}
                  userById={userById}
                />
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
  messages, loading, loadingOlder, hasMore, onLoadOlder, me, userById,
}: {
  messages: ApiMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  onLoadOlder: () => void;
  me: ApiUser | null;
  userById: Map<number, ApiUser>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // When set, a "load older" prepend is in flight and holds the scrollHeight
  // measured just before the fetch. After the older page renders we restore
  // scroll by the exact height delta so the message the user was reading stays
  // put instead of jumping. null means the next growth is a bottom-append (new
  // message / initial load) and should scroll to the newest message.
  const pendingPrepend = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (pendingPrepend.current != null) {
      // Older messages were prepended: shift scrollTop down by the height that
      // was inserted above the viewport.
      el.scrollTop += el.scrollHeight - pendingPrepend.current;
      pendingPrepend.current = null;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    // Trigger a page load a little before the very top so it feels seamless.
    if (el.scrollTop < 48 && hasMore && !loadingOlder) {
      pendingPrepend.current = el.scrollHeight;
      onLoadOlder();
    }
  };

  return (
    <div
      ref={listRef}
      onScroll={onScroll}
      className="bcw-flex-1 bcw-overflow-y-auto bcw-px-3 bcw-py-2 bcw-space-y-2"
      data-testid="bulldog-chat-widget-messages"
    >
      {loadingOlder && (
        <div className="bcw-text-[11px] bcw-text-white/50 bcw-text-center bcw-py-1.5" data-testid="bulldog-chat-widget-older-spinner">
          Loading older messages…
        </div>
      )}
      {loading && <div className="bcw-text-xs bcw-text-white/50 bcw-text-center bcw-py-4">Loading…</div>}
      {!loading && messages.length === 0 && (
        <div className="bcw-text-xs bcw-text-white/50 bcw-text-center bcw-py-4">No messages yet. Say hi!</div>
      )}
      {messages.map((m) => (
        <MessageRow key={m.id} message={m} me={me} userById={userById} />
      ))}
    </div>
  );
}

function MessageRow({ message, me, userById }: {
  message: ApiMessage;
  me: ApiUser | null;
  userById: Map<number, ApiUser>;
}) {
  const author = userById.get(message.userId);
  const mine = me?.id === message.userId;
  const attachments = message.attachmentsList ?? [];
  const segments = message.deletedAt
    ? []
    : parseMentions(message.content, { mentions: message.mentions, meId: me?.id ?? null, userById });

  return (
    <div className={`bcw-flex bcw-flex-col ${mine ? "bcw-items-end" : "bcw-items-start"}`}>
      {!mine && <span className="bcw-text-[10px] bcw-text-white/40 bcw-mb-0.5">{author?.name ?? "Unknown"}</span>}
      {(message.deletedAt || message.content) && (
        <div
          className={`bcw-max-w-[85%] bcw-rounded-lg bcw-px-2.5 bcw-py-1.5 bcw-text-xs bcw-whitespace-pre-wrap bcw-break-words ${
            mine ? "bcw-bg-bcw-red bcw-text-white" : "bcw-bg-bcw-navy-light bcw-text-white/90"
          }`}
        >
          {message.deletedAt ? (
            <em className="bcw-opacity-60">message deleted</em>
          ) : (
            segments.map((seg, i) =>
              seg.mention ? (
                <span key={i} className={`bcw-mention${seg.mention.isMe ? " bcw-mention-me" : ""}`}>
                  {seg.text}
                </span>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )
          )}
        </div>
      )}
      {!message.deletedAt && attachments.length > 0 && (
        <div className="bcw-max-w-[85%] bcw-mt-1 bcw-space-y-1">
          {attachments.map((att) => (
            <AttachmentView key={att.id} attachment={att} />
          ))}
        </div>
      )}
    </div>
  );
}

// Read-only attachment rendering. Uploading from the mini widget is not yet
// supported (the composer's paperclip stays disabled) — this only displays
// attachments that already exist on a message.
function AttachmentView({ attachment }: { attachment: ApiAttachment }) {
  if (isImageAttachment(attachment)) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="bcw-block bcw-max-w-[240px] bcw-rounded-lg bcw-overflow-hidden bcw-border bcw-border-black/30"
        data-testid="bulldog-chat-widget-attachment-image"
      >
        <img
          src={attachment.thumbnailUrl ?? attachment.url}
          alt={attachment.filename}
          className="bcw-block bcw-w-full bcw-h-auto bcw-max-h-[200px] bcw-object-cover"
          loading="lazy"
        />
      </a>
    );
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      download={attachment.filename}
      className="bcw-flex bcw-items-center bcw-gap-2 bcw-max-w-[240px] bcw-rounded-lg bcw-border bcw-border-black/30 bcw-bg-[hsl(220,60%,9%)] bcw-px-2.5 bcw-py-1.5 hover:bcw-bg-bcw-navy-light"
      data-testid="bulldog-chat-widget-attachment-file"
    >
      <PaperclipIcon />
      <span className="bcw-flex-1 bcw-min-w-0">
        <span className="bcw-block bcw-text-xs bcw-text-white/90 bcw-truncate">{attachment.filename}</span>
        <span className="bcw-block bcw-text-[10px] bcw-text-white/40">{formatFileSize(attachment.sizeBytes)}</span>
      </span>
    </a>
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
function BellIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}
