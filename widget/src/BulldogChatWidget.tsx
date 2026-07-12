import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChatApiClient,
  type ApiAttachment,
  type ApiChannel,
  type ApiDmChannel,
  type ApiMessage,
  type ApiProject,
  type ApiReaction,
  type ApiUser,
  type ApiWorkObject,
} from "./api";
import { useWidgetStore, type ConversationRef } from "./state";
import { ChatSyncBridge } from "./sync";
import { useMiniChatSse } from "./hooks/useMiniChatSse";
import { useRingtone, playMentionChime, type RingMode } from "./hooks/useRingtone";
import { useBrowserNotifications } from "./hooks/useBrowserNotifications";
import { useOpenJobBus, type OpenJobEventDetail } from "./hooks/useOpenJobBus";
import {
  formatFileSize,
  hasOwnReaction,
  isImageAttachment,
  mentionsUser,
  mergeOlderMessages,
  parseMentions,
  presenceDotClass,
  presenceLabel,
  reactedByNames,
  reactionToggleAction,
  REACTION_EMOJIS,
  threadChipLabel,
} from "./format";
import { CallView } from "./CallView";

// Number of messages fetched per page. Matches the server default limit; a
// full page coming back is the signal that older history may still exist.
const PAGE_SIZE = 50;

export interface BulldogChatWidgetProps {
  /** Base URL of the Chat app, e.g. "https://chat.bulldogops.com". */
  apiBaseUrl: string;
  /** Optional: hide the widget entirely (e.g. host app knows user is logged out). */
  hidden?: boolean;
  /** Optional: URL to open in a new tab when the pop-out button is clicked.
   * Defaults to apiBaseUrl, since the Chat app IS the full chat experience. */
  chatAppUrl?: string;
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

export function BulldogChatWidget({ apiBaseUrl, hidden, chatAppUrl }: BulldogChatWidgetProps) {
  const api = useMemo(() => new ChatApiClient(apiBaseUrl), [apiBaseUrl]);
  const sync = useMemo(() => new ChatSyncBridge(), []);
  const isMobile = useIsMobile();
  // Expand-to-fullscreen (widget 0.4.0). Hidden on mobile, where the panel is
  // already fullscreen via the existing isMobile CSS path.
  const [expanded, setExpanded] = useState(false);

  const open = useWidgetStore((s) => s.open);
  const setOpen = useWidgetStore((s) => s.setOpen);
  const toggleOpen = useWidgetStore((s) => s.toggleOpen);
  const sidebarOpen = useWidgetStore((s) => s.sidebarOpen);
  const setSidebarOpen = useWidgetStore((s) => s.setSidebarOpen);
  const activeConversation = useWidgetStore((s) => s.activeConversation);
  const setActiveConversation = useWidgetStore((s) => s.setActiveConversation);
  const activeThreadId = useWidgetStore((s) => s.activeThreadId);
  const setActiveThreadId = useWidgetStore((s) => s.setActiveThreadId);
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
  // Thread panel: replies to the parent message identified by activeThreadId.
  const [threadReplies, setThreadReplies] = useState<ApiMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadComposer, setThreadComposer] = useState("");
  const [threadSending, setThreadSending] = useState(false);
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

  // Read-receipt bookkeeping. lastReadFiredRef throttles POST /read to at most
  // once per 5s; readTimerRef holds the "visible 2s at bottom" delay so we only
  // mark read once the user has actually dwelled at the latest message.
  const lastReadFiredRef = useRef(0);
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const READ_DEBOUNCE_MS = 5000;
  const READ_DWELL_MS = 2000;

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

  // ── Read receipts ──────────────────────────────────────────────────────────
  // POST /api/channels/:id/read advances the caller's receipt (receipts only
  // move forward server-side). We fire it (a) immediately when a conversation
  // is opened, and (b) after the user has dwelled ~2s scrolled near the bottom.
  // Both paths funnel through fireMarkRead, which throttles to once per 5s so a
  // burst of scroll events can't hammer the endpoint. `force` bypasses the
  // throttle for the open-conversation case.
  const fireMarkRead = (channelId: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastReadFiredRef.current < READ_DEBOUNCE_MS) return;
    lastReadFiredRef.current = now;
    api.markChannelRead(channelId).catch(() => { /* best-effort */ });
  };

  // Called by MessageList as the user scrolls. When they're within 100px of the
  // bottom we start a dwell timer; scrolling away cancels it. Firing marks the
  // channel read (throttled).
  const onBottomVisibilityChange = (atBottom: boolean) => {
    if (readTimerRef.current) {
      clearTimeout(readTimerRef.current);
      readTimerRef.current = null;
    }
    if (!atBottom) return;
    const conv = activeConversation;
    if (!conv) return;
    readTimerRef.current = setTimeout(() => {
      readTimerRef.current = null;
      fireMarkRead(conv.id);
    }, READ_DWELL_MS);
  };

  useEffect(() => {
    return () => { if (readTimerRef.current) clearTimeout(readTimerRef.current); };
  }, []);

  useEffect(() => {
    if (activeConversation && open) {
      loadMessages(activeConversation);
      // Mark read immediately on open, then let scroll-dwell handle the rest.
      fireMarkRead(activeConversation.id, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversation?.id, activeConversation?.kind, open]);

  // ── Reactions ──────────────────────────────────────────────────────────────
  // Replace a message in both the main timeline and the open thread panel with
  // the server's updated wire copy (returned by add/removeReaction). Keeps pills
  // authoritative rather than guessing counts optimistically.
  const applyUpdatedMessage = (updated: ApiMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    setThreadReplies((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  };

  const handleToggleReaction = async (messageId: number, emoji: string) => {
    const target =
      messages.find((m) => m.id === messageId) ?? threadReplies.find((m) => m.id === messageId);
    const action = reactionToggleAction(target?.reactions, emoji, me?.id ?? null);
    try {
      const updated =
        action === "remove"
          ? await api.removeReaction(messageId, emoji)
          : await api.addReaction(messageId, emoji);
      applyUpdatedMessage(updated);
    } catch {
      /* best-effort — leave existing pills as they are */
    }
  };

  // ── Threads ────────────────────────────────────────────────────────────────
  const loadThreadReplies = async (parentId: number) => {
    setThreadLoading(true);
    try {
      setThreadReplies(await api.listThreadReplies(parentId));
    } catch {
      setThreadReplies([]);
    } finally {
      setThreadLoading(false);
    }
  };

  const openThread = (parentId: number) => {
    setActiveThreadId(parentId);
    setThreadComposer("");
    loadThreadReplies(parentId);
  };

  const closeThread = () => {
    setActiveThreadId(null);
    setThreadReplies([]);
  };

  const handleSendThreadReply = async () => {
    const content = threadComposer.trim();
    if (!content || !activeConversation || activeThreadId == null || threadSending) return;
    setThreadSending(true);
    try {
      await api.sendMessage(activeConversation.id, content, activeThreadId);
      setThreadComposer("");
      await loadThreadReplies(activeThreadId);
      // Refresh the main list so the parent's "N replies" chip updates.
      await loadMessages(activeConversation);
    } catch {
      /* leave composer populated */
    } finally {
      setThreadSending(false);
    }
  };

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
        // If the new message is a reply to the thread we're viewing, refresh it.
        if (activeThreadId != null && data?.replyToMessageId === activeThreadId) {
          loadThreadReplies(activeThreadId);
        }
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
    // A reaction changed on some message. We don't get the updated message on
    // the wire (only {messageId, channelId}), so refetch the affected channel
    // if it's the one we're viewing; refresh the thread too if it's open.
    onReactionChange: (data) => {
      if (activeConversation && data?.channelId === activeConversation.id) {
        loadMessages(activeConversation);
        if (activeThreadId != null) loadThreadReplies(activeThreadId);
      }
    },
    // A user's presence changed — patch that user's presence in the members
    // list so sidebar / header dots update live (no polling needed).
    onPresenceChange: (data) => {
      if (data?.userId == null || typeof data?.presence !== "string") return;
      setMembers((prev) =>
        prev.map((u) => (u.id === data.userId ? { ...u, presence: data.presence } : u)),
      );
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
    // A thread panel is scoped to one conversation; drop it when switching.
    closeThread();
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

  // ── Cross-app openJob bus (widget 0.4.0) ────────────────────────────────────
  // bulldog-ops / bulldog-contracts dispatch `bulldog:widget:openJob` on
  // window when the user clicks a "Chat about this job" trigger. We resolve
  // the job, jump straight to its first channel, or — if it has none yet —
  // surface a lightweight "create #general" prompt.
  const [pendingJobPrompt, setPendingJobPrompt] = useState<{
    workObject: ApiWorkObject;
    creating: boolean;
    error?: string;
  } | null>(null);

  const handleOpenJob = useCallback(async (detail: OpenJobEventDetail) => {
    setOpen(true);
    try {
      // Resolve the work object.
      let wo: ApiWorkObject | null = null;
      if (typeof detail.jobId === "number") {
        wo = await api.getWorkObject(detail.jobId);
      } else {
        const ref = detail.jobRef ?? detail.jobNumber;
        if (!ref) throw new Error("openJob requires jobId, jobRef, or jobNumber");
        wo = await api.getWorkObjectByRef(ref);
      }
      if (!wo) throw new Error("Job not found");

      // Find channels attached to this job.
      const channels = await api.listWorkObjectChannels(wo.id);
      if (channels.length > 0) {
        // Activate the first channel (order comes from listChannelsForWorkObject).
        setActiveTab("channels");
        setSidebarOpen(false); // focus on the message list, not the sidebar
        setActiveConversation({ kind: "channel", id: channels[0].id });
        setPendingJobPrompt(null);
      } else {
        // Nothing yet — surface the create prompt.
        setPendingJobPrompt({ workObject: wo, creating: false });
      }
    } catch (err) {
      console.error("[widget] openJob failed:", err, "source:", detail.source);
      setPendingJobPrompt(null);
      // Best-effort: leave the widget open with whatever conversation was active.
    }
  }, [api, setOpen, setActiveTab, setSidebarOpen, setActiveConversation]);

  useOpenJobBus(handleOpenJob);

  const handleCreateJobChannel = async () => {
    if (!pendingJobPrompt || pendingJobPrompt.creating) return;
    const { workObject } = pendingJobPrompt;
    if (workObject.projectId == null) {
      setPendingJobPrompt({
        ...pendingJobPrompt,
        error: "This job isn't attached to a company yet — create the channel from Chat directly.",
      });
      return;
    }
    setPendingJobPrompt({ ...pendingJobPrompt, creating: true, error: undefined });
    try {
      await api.createChannel(workObject.projectId, {
        name: "general",
        type: "text",
        workObjectId: workObject.id,
      });
      const channels = await api.listWorkObjectChannels(workObject.id);
      if (channels.length > 0) {
        setActiveTab("channels");
        setSidebarOpen(false);
        setActiveConversation({ kind: "channel", id: channels[0].id });
      }
      setPendingJobPrompt(null);
      refreshProjectChannels(workObject.projectId);
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? "Failed to create channel";
      setPendingJobPrompt({ ...pendingJobPrompt, creating: false, error: msg });
    }
  };

  // Refresh a single project's channel list in channelsByProject (used after
  // creating a job channel so the sidebar picks it up without a full reload).
  const refreshProjectChannels = async (projectId: number) => {
    try {
      const channels = await api.listProjectChannels(projectId);
      setChannelsByProject((prev) => {
        const next = new Map(prev);
        next.set(projectId, channels);
        return next;
      });
    } catch {
      /* best-effort */
    }
  };

  if (hidden) return null;

  const userById = new Map(members.map((u) => [u.id, u]));
  const activeDm = activeConversation?.kind === "dm" ? dms.find((d) => d.id === activeConversation.id) : undefined;
  // The other participant in a 1:1 DM — drives the header presence dot.
  const activeDmOther = activeDm && me
    ? userById.get(activeDm.memberIds.find((id) => id !== me.id) ?? -1)
    : undefined;
  const threadParent = activeThreadId != null
    ? messages.find((m) => m.id === activeThreadId)
    : undefined;
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

  // Expand-to-fullscreen (widget 0.4.0): when toggled, the panel takes over
  // the same "fixed inset-0" CSS path the mobile breakpoint already uses, so
  // there's no new layout code to maintain — just an extra condition.
  const panelSizeClass = isMobile || expanded
    ? "bcw-fixed bcw-inset-0 bcw-w-full bcw-h-full bcw-rounded-none"
    : "bcw-w-[360px] bcw-h-[480px] bcw-rounded-xl";

  // Panel position: clamp so it doesn't go off-screen
  const panelRight = Math.max(8, pillPosition.right - 8);
  const panelBottom = isMobile || expanded ? 0 : Math.max(8, pillPosition.bottom + 64);

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
          style={isMobile || expanded ? {} : { position: "fixed", right: panelRight, bottom: panelBottom }}
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
            <div className="bcw-flex-1 bcw-min-w-0 bcw-flex bcw-items-center bcw-gap-1.5">
              {activeDmOther && (
                <span
                  className={`bcw-w-2 bcw-h-2 bcw-rounded-full bcw-shrink-0 ${presenceDotClass(activeDmOther.presence)}`}
                  title={presenceLabel(activeDmOther.presence)}
                  data-testid="bulldog-chat-widget-header-presence"
                />
              )}
              <span className="bcw-min-w-0 bcw-text-xs bcw-font-semibold bcw-text-white bcw-truncate">
                {activeTitle}
              </span>
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

            {/* Expand-to-fullscreen — hidden on mobile, where the panel is
                already fullscreen. */}
            {!isMobile && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/70 hover:bcw-text-white"
                aria-label={expanded ? "Restore" : "Expand to fullscreen"}
                title={expanded ? "Restore" : "Expand to fullscreen"}
                data-testid="bulldog-chat-widget-expand"
              >
                {expanded ? <CollapseIcon /> : <ExpandIcon />}
              </button>
            )}

            {/* Pop-out — opens the full Chat app in a new tab. */}
            <button
              type="button"
              onClick={() => window.open(chatAppUrl ?? apiBaseUrl, "_blank", "noopener,noreferrer")}
              className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/70 hover:bcw-text-white"
              aria-label="Open in Chat"
              title="Open in Chat"
              data-testid="bulldog-chat-widget-popout"
            >
              <PopOutIcon />
            </button>

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
            {/* "No channels yet" prompt — surfaced by the openJob bus (widget
                0.4.0) when a resolved job has no channels attached. Sits above
                the sidebar and message list so it's the first thing the user
                sees after opening the widget from a job trigger. */}
            {pendingJobPrompt && (
              <div
                className="bcw-absolute bcw-inset-0 bcw-z-30 bcw-flex bcw-items-center bcw-justify-center bcw-bg-bcw-navy/95 bcw-p-4"
                data-testid="bulldog-chat-widget-job-prompt"
              >
                <div className="bcw-max-w-[280px] bcw-text-center bcw-space-y-3">
                  <p className="bcw-text-sm bcw-text-white/90">
                    No channels yet for job{" "}
                    <span className="bcw-font-semibold">{pendingJobPrompt.workObject.ref}</span>
                  </p>
                  {pendingJobPrompt.error && (
                    <p className="bcw-text-xs bcw-text-red-300" data-testid="bulldog-chat-widget-job-prompt-error">
                      {pendingJobPrompt.error}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={handleCreateJobChannel}
                    disabled={pendingJobPrompt.creating}
                    className="bcw-w-full bcw-px-3 bcw-py-1.5 bcw-rounded-md bcw-bg-bcw-red bcw-text-white bcw-text-xs bcw-font-semibold disabled:bcw-opacity-50"
                    data-testid="bulldog-chat-widget-job-prompt-create"
                  >
                    {pendingJobPrompt.creating ? "Creating…" : "Create #general channel"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingJobPrompt(null)}
                    className="bcw-w-full bcw-px-3 bcw-py-1.5 bcw-rounded-md bcw-bg-bcw-navy-light bcw-text-white/80 bcw-text-xs bcw-font-medium"
                    data-testid="bulldog-chat-widget-job-prompt-cancel"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

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
                        // Presence dot only for 1:1 DMs (a single other member);
                        // group DMs have no single presence to show.
                        const solo = others.length === 1 ? userById.get(others[0]) : undefined;
                        return (
                          <button
                            key={dm.id}
                            type="button"
                            onClick={() => selectConversation("dm", dm.id)}
                            className={`bcw-w-full bcw-text-left bcw-px-3 bcw-py-2 bcw-text-xs bcw-flex bcw-items-center bcw-gap-1.5 hover:bcw-bg-bcw-navy-light ${
                              activeConversation?.kind === "dm" && activeConversation.id === dm.id
                                ? "bcw-bg-bcw-navy-light bcw-text-white"
                                : "bcw-text-white/80"
                            }`}
                            data-testid={`bulldog-chat-widget-dm-${dm.id}`}
                          >
                            <span
                              className={`bcw-w-2 bcw-h-2 bcw-rounded-full bcw-shrink-0 ${solo ? presenceDotClass(solo.presence) : "bcw-bg-transparent"}`}
                              title={solo ? presenceLabel(solo.presence) : undefined}
                              data-testid={`bulldog-chat-widget-dm-presence-${dm.id}`}
                            />
                            <span className="bcw-truncate">{label}</span>
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
                  onBottomVisibilityChange={onBottomVisibilityChange}
                  me={me}
                  userById={userById}
                  onToggleReaction={handleToggleReaction}
                  onOpenThread={openThread}
                />
              )}

              {/* Typing indicator: intentionally not implemented. The Chat
                  backend has no typing SSE event or POST /typing route today
                  (verified: no `typing` references in server/), so there's
                  nothing to subscribe to or send. This is a no-op placeholder —
                  wire the UI here once the backend emits typing:started /
                  typing:stopped and exposes a send endpoint. */}

              {authed !== false && activeConversation && !activeCall && (
                <Composer
                  value={composerValue}
                  onChange={setComposerValue}
                  onSend={handleSend}
                  disabled={sending}
                />
              )}
            </div>

            {/* Thread panel: right-hand slide-in showing the parent message,
                its replies, and a reply composer scoped to the parent. */}
            {activeThreadId != null && !activeCall && (
              <ThreadPanel
                parent={threadParent}
                replies={threadReplies}
                loading={threadLoading}
                me={me}
                userById={userById}
                composerValue={threadComposer}
                onComposerChange={setThreadComposer}
                onSend={handleSendThreadReply}
                sending={threadSending}
                onClose={closeThread}
                onToggleReaction={handleToggleReaction}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MessageList({
  messages, loading, loadingOlder, hasMore, onLoadOlder, onBottomVisibilityChange, me, userById, onToggleReaction, onOpenThread,
}: {
  messages: ApiMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  onLoadOlder: () => void;
  onBottomVisibilityChange: (atBottom: boolean) => void;
  me: ApiUser | null;
  userById: Map<number, ApiUser>;
  onToggleReaction: (messageId: number, emoji: string) => void;
  onOpenThread: (parentId: number) => void;
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
      // A bottom-append / initial load lands the user at the newest message,
      // which counts as "viewing the bottom" for read receipts.
      onBottomVisibilityChange(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    // Trigger a page load a little before the very top so it feels seamless.
    if (el.scrollTop < 48 && hasMore && !loadingOlder) {
      pendingPrepend.current = el.scrollHeight;
      onLoadOlder();
    }
    // Report whether the user is within 100px of the newest message so the
    // parent can decide when to mark the conversation read.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    onBottomVisibilityChange(atBottom);
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
        <MessageRow
          key={m.id}
          message={m}
          me={me}
          userById={userById}
          onToggleReaction={onToggleReaction}
          onOpenThread={onOpenThread}
        />
      ))}
    </div>
  );
}

function MessageRow({ message, me, userById, onToggleReaction, onOpenThread, inThread }: {
  message: ApiMessage;
  me: ApiUser | null;
  userById: Map<number, ApiUser>;
  onToggleReaction: (messageId: number, emoji: string) => void;
  onOpenThread: (parentId: number) => void;
  /** When rendered inside the thread panel, hide the reply-in-thread action and
   * the thread chip (you're already in the thread). */
  inThread?: boolean;
}) {
  const author = userById.get(message.userId);
  const mine = me?.id === message.userId;
  const attachments = message.attachmentsList ?? [];
  const reactions = message.reactions ?? [];
  const chip = threadChipLabel(message.replyCount, message.lastReplyAt);
  const segments = message.deletedAt
    ? []
    : parseMentions(message.content, { mentions: message.mentions, meId: me?.id ?? null, userById });

  return (
    <div
      className={`bcw-group bcw-relative bcw-flex bcw-flex-col ${mine ? "bcw-items-end" : "bcw-items-start"}`}
      data-testid={`bulldog-chat-widget-message-${message.id}`}
    >
      {!mine && <span className="bcw-text-[10px] bcw-text-white/40 bcw-mb-0.5">{author?.name ?? "Unknown"}</span>}

      {/* Hover actions — react and (outside the thread) reply in thread. */}
      {!message.deletedAt && (
        <div
          className={`bcw-absolute -bcw-top-2 bcw-z-10 bcw-hidden group-hover:bcw-flex bcw-items-center bcw-gap-0.5 bcw-rounded-md bcw-bg-[hsl(220,60%,9%)] bcw-border bcw-border-black/40 bcw-px-0.5 bcw-py-0.5 bcw-shadow ${mine ? "bcw-right-0" : "bcw-right-0"}`}
        >
          <ReactionAdder onPick={(emoji) => onToggleReaction(message.id, emoji)} />
          {!inThread && (
            <button
              type="button"
              onClick={() => onOpenThread(message.id)}
              className="bcw-p-1 bcw-rounded bcw-text-white/60 hover:bcw-text-white hover:bcw-bg-bcw-navy-light"
              title="Reply in thread"
              data-testid={`bulldog-chat-widget-reply-${message.id}`}
            >
              <ThreadIcon />
            </button>
          )}
        </div>
      )}

      {(message.deletedAt || message.content) && (
        <div
          className={`bcw-max-w-[85%] bcw-rounded-lg bcw-px-2.5 bcw-py-1.5 bcw-text-xs bcw-whitespace-pre-wrap bcw-break-words ${
            mine ? "bcw-bg-bcw-red bcw-text-white" : "bcw-bg-bcw-navy-light bcw-text-white/90"
          }`}
        >
          {message.deletedAt ? (
            <span className="bcw-opacity-60 bcw-italic">message deleted</span>
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

      {reactions.length > 0 && (
        <ReactionPills
          reactions={reactions}
          meId={me?.id ?? null}
          userById={userById}
          onToggle={(emoji) => onToggleReaction(message.id, emoji)}
        />
      )}

      {chip && !inThread && (
        <button
          type="button"
          onClick={() => onOpenThread(message.id)}
          className="bcw-mt-1 bcw-text-[11px] bcw-text-bcw-red/90 hover:bcw-text-bcw-red bcw-font-medium"
          data-testid={`bulldog-chat-widget-thread-chip-${message.id}`}
        >
          {chip}
        </button>
      )}
    </div>
  );
}

// ── Reactions ──────────────────────────────────────────────────────────────

function ReactionPills({ reactions, meId, userById, onToggle }: {
  reactions: ApiReaction[];
  meId: number | null;
  userById: Map<number, ApiUser>;
  onToggle: (emoji: string) => void;
}) {
  return (
    <div className="bcw-mt-1 bcw-flex bcw-flex-wrap bcw-gap-1" data-testid="bulldog-chat-widget-reactions">
      {reactions.map((r) => {
        const own = hasOwnReaction(r, meId);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onToggle(r.emoji)}
            title={reactedByNames(r, userById)}
            className={`bcw-flex bcw-items-center bcw-gap-0.5 bcw-rounded-full bcw-px-1.5 bcw-py-0.5 bcw-text-[11px] bcw-border ${
              own
                ? "bcw-border-bcw-red bcw-bg-bcw-red/20 bcw-text-white"
                : "bcw-border-black/40 bcw-bg-bcw-navy-light bcw-text-white/80"
            }`}
            data-testid={`bulldog-chat-widget-reaction-${r.emoji}`}
          >
            <span>{r.emoji}</span>
            <span className="bcw-tabular-nums">{r.count}</span>
          </button>
        );
      })}
    </div>
  );
}

// The "+" affordance that opens a small fixed emoji grid. Deliberately not
// emoji-mart — a hand-picked palette keeps the widget asset-free and small.
function ReactionAdder({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="bcw-relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="bcw-p-1 bcw-rounded bcw-text-white/60 hover:bcw-text-white hover:bcw-bg-bcw-navy-light"
        title="Add reaction"
        data-testid="bulldog-chat-widget-react-btn"
      >
        <EmojiPlusIcon />
      </button>
      {open && (
        <div
          className="bcw-absolute bcw-right-0 bcw-top-full bcw-mt-1 bcw-z-20 bcw-w-[184px] bcw-grid bcw-grid-cols-8 bcw-gap-0.5 bcw-rounded-md bcw-bg-[hsl(220,60%,9%)] bcw-border bcw-border-black/40 bcw-p-1 bcw-shadow-bcw-panel"
          data-testid="bulldog-chat-widget-emoji-picker"
        >
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => { onPick(emoji); setOpen(false); }}
              className="bcw-text-sm bcw-leading-none bcw-p-1 bcw-rounded hover:bcw-bg-bcw-navy-light"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Thread panel ─────────────────────────────────────────────────────────────

function ThreadPanel({
  parent, replies, loading, me, userById, composerValue, onComposerChange, onSend, sending, onClose, onToggleReaction,
}: {
  parent: ApiMessage | undefined;
  replies: ApiMessage[];
  loading: boolean;
  me: ApiUser | null;
  userById: Map<number, ApiUser>;
  composerValue: string;
  onComposerChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  onClose: () => void;
  onToggleReaction: (messageId: number, emoji: string) => void;
}) {
  const noop = () => {};
  return (
    <div
      className="bcw-absolute bcw-inset-y-0 bcw-right-0 bcw-w-full sm:bcw-w-[300px] bcw-bg-bcw-navy bcw-border-l bcw-border-black/40 bcw-flex bcw-flex-col bcw-z-20 bcw-shadow-bcw-panel"
      data-testid="bulldog-chat-widget-thread-panel"
    >
      <header className="bcw-h-9 bcw-px-2.5 bcw-flex bcw-items-center bcw-gap-1.5 bcw-border-b bcw-border-black/40 bcw-shrink-0">
        <span className="bcw-flex-1 bcw-text-xs bcw-font-semibold bcw-text-white">Thread</span>
        <button
          type="button"
          onClick={onClose}
          className="bcw-p-1 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
          aria-label="Close thread"
          data-testid="bulldog-chat-widget-thread-close"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="bcw-flex-1 bcw-overflow-y-auto bcw-px-3 bcw-py-2 bcw-space-y-2">
        {parent && (
          <div className="bcw-pb-2 bcw-border-b bcw-border-black/40">
            <MessageRow
              message={parent}
              me={me}
              userById={userById}
              onToggleReaction={onToggleReaction}
              onOpenThread={noop}
              inThread
            />
          </div>
        )}
        {loading && <div className="bcw-text-xs bcw-text-white/50 bcw-text-center bcw-py-2">Loading replies…</div>}
        {!loading && replies.length === 0 && (
          <div className="bcw-text-xs bcw-text-white/50 bcw-text-center bcw-py-2">No replies yet.</div>
        )}
        {replies.map((r) => (
          <MessageRow
            key={r.id}
            message={r}
            me={me}
            userById={userById}
            onToggleReaction={onToggleReaction}
            onOpenThread={noop}
            inThread
          />
        ))}
      </div>

      <Composer value={composerValue} onChange={onComposerChange} onSend={onSend} disabled={sending} placeholder="Reply…" />
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

function Composer({ value, onChange, onSend, disabled, placeholder = "Message…" }: {
  value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean; placeholder?: string;
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
        placeholder={placeholder}
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
// Two diagonal arrows pointing outward — "expand to fullscreen".
function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 00-2 2v3" />
      <path d="M16 3h3a2 2 0 012 2v3" />
      <path d="M16 21h3a2 2 0 002-2v-3" />
      <path d="M8 21H5a2 2 0 01-2-2v-3" />
    </svg>
  );
}
// Two diagonal arrows pointing inward — "restore" from fullscreen.
function CollapseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3v4a2 2 0 01-2 2H3" />
      <path d="M15 3v4a2 2 0 002 2h4" />
      <path d="M15 21v-4a2 2 0 012-2h4" />
      <path d="M9 21v-4a2 2 0 00-2-2H3" />
    </svg>
  );
}
// Arrow escaping a box — "open in a new tab / pop out".
function PopOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
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
function ThreadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
    </svg>
  );
}
function EmojiPlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4 4 0 007 0" />
      <path d="M9 9h.01M15 9h.01" />
    </svg>
  );
}
