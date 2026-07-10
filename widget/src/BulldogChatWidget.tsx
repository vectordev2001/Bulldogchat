import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ChatApp, queryClient as chatUiQueryClient, setApiBase, type ApiUser as ChatUiApiUser } from "@vectordev2001/chat-ui";
import { ChatApiClient, type ApiUser } from "./api";
import { useWidgetStore, type ConversationRef } from "./state";
import { ChatSyncBridge } from "./sync";
import { useMiniChatSse } from "./hooks/useMiniChatSse";
import { useRingtone, type RingMode } from "./hooks/useRingtone";
import { useOpenJobBus } from "./hooks/useOpenJobBus";
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

/** Pop-out target: the standalone Chat app, full experience, own tab. */
const CHAT_APP_URL = "https://chat.bulldogops.com/";

export function BulldogChatWidget({ apiBaseUrl, hidden }: BulldogChatWidgetProps) {
  const api = useMemo(() => new ChatApiClient(apiBaseUrl), [apiBaseUrl]);
  const sync = useMemo(() => new ChatSyncBridge(), []);
  const isMobile = useIsMobile();

  // ChatApp (from @vectordev2001/chat-ui) makes all of its own requests
  // through queryClient.ts's getApiBase()/setApiBase(), completely separate
  // from this widget's own hand-rolled ChatApiClient (used for the pill's
  // unread/call/SSE plumbing, which predates ChatApp and still owns those
  // concerns). Point it at the same cross-origin host once, on mount.
  useEffect(() => {
    setApiBase(apiBaseUrl);
  }, [apiBaseUrl]);

  const open = useWidgetStore((s) => s.open);
  const setOpen = useWidgetStore((s) => s.setOpen);
  const toggleOpen = useWidgetStore((s) => s.toggleOpen);
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
  const [startingCall, setStartingCall] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  // Expand-to-fullscreen: overrides the normal fixed-size panel with a
  // full-viewport one, same idea as the mobile layout but toggleable on
  // desktop too. Independent of `isMobile` (mobile is already full-screen).
  const [expanded, setExpanded] = useState(false);

  // ── openJob deep-link scoping ────────────────────────────────────────────
  // ChatApp is remounted (key={jobChannelKey}) whenever we resolve a new
  // target channel so its internal deep-link effect (which only runs once
  // per mount) re-fires for each job open, matching how the main app's
  // ChatApp handles a fresh page-load deep link.
  const [jobChannelId, setJobChannelId] = useState<number | null>(null);
  const [jobPrompt, setJobPrompt] = useState<{ jobId: number; jobNumber: string; source: string } | null>(null);
  const [jobPromptBusy, setJobPromptBusy] = useState(false);
  const [jobPromptError, setJobPromptError] = useState<string | null>(null);

  const handleJobOpen = useCallback((jobId: number, jobNumber: string, source: string) => {
    setOpen(true);
    setJobPrompt(null);
    setJobPromptError(null);
    (async () => {
      try {
        const channels = await api.getWorkObjectChannels(jobId);
        if (channels.length > 0) {
          setJobChannelId(channels[0].id);
        } else {
          setJobPrompt({ jobId, jobNumber, source });
        }
      } catch (err) {
        console.warn("[widget] openJob channel lookup failed", err);
        setJobPrompt({ jobId, jobNumber, source });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useOpenJobBus(api, { onJobOpen: handleJobOpen });

  const handleCreateJobChannel = async () => {
    if (!jobPrompt) return;
    setJobPromptBusy(true);
    setJobPromptError(null);
    try {
      // The job usually already exists server-side (it's the same
      // multi-tenant work_objects table Contracts/Ops write to) — try to
      // fetch it first and only create a new row on a genuine 404, per the
      // brief ("if work-object doesn't exist server-side").
      let workObjectId = jobPrompt.jobId;
      let projectId: number | null = null;
      try {
        const wo = await api.getWorkObject(jobPrompt.jobId);
        projectId = wo.projectId;
      } catch {
        // Job doesn't exist on the Chat side yet — create it. We have no
        // company (projectId) to attach it to from just a jobId/jobNumber,
        // so this falls back to the org's default company if the server
        // accepts an omitted projectId, otherwise surfaces the server's
        // error in jobPromptError below.
        const created = await api.createWorkObject({
          title: `Job ${jobPrompt.jobNumber}`,
          ref: jobPrompt.jobNumber,
        });
        workObjectId = created.id;
        projectId = created.projectId;
      }
      if (!projectId) throw new Error("Job has no company assigned — open it from the host app first");
      const channel = await api.createChannel(projectId, {
        name: "general",
        type: "text",
        workObjectId,
      });
      setJobChannelId(channel.id);
      setJobPrompt(null);
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? "Couldn't create the channel";
      setJobPromptError(msg);
    } finally {
      setJobPromptBusy(false);
    }
  };

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

  // Auth check + current user (still needed for the pill badge / call
  // banner / ChatApp's `user` prop — ChatApp itself no longer calls
  // useAuth() when used standalone this way, it just takes `user`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await api.isAuthenticated();
      if (cancelled) return;
      setAuthed(ok);
      if (!ok) return;
      try {
        const meRes = await api.me();
        if (cancelled) return;
        setMe(meRes);
      } catch {
        /* leave me null */
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

  // SSE — still driven by the widget's own lightweight ChatApiClient/SSE
  // hook (not ChatApp's internal useSSE) so the unread badge + incoming-call
  // banner on the *collapsed pill* work even while the panel (and therefore
  // ChatApp) isn't mounted at all.
  useMiniChatSse(apiBaseUrl, authed === true, {
    onMessageNew: (data) => {
      if (!(activeConversation && data?.channelId === activeConversation.id && open)) {
        if (data?.channelId) {
          incrementUnread();
          sync.broadcastUnreadChanged(unreadCount + 1);
        }
      }
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

  // Clear unread whenever the panel is open and showing chat (mirrors the
  // old widget's selectConversation() reset — ChatApp doesn't know about
  // this widget's unread store, so we clear it optimistically on open).
  useEffect(() => {
    if (open && !activeCall) {
      clearUnread();
      sync.broadcastUnreadChanged(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const panelSizeClass = expanded
    ? "bcw-fixed bcw-inset-0 bcw-w-full bcw-h-full bcw-rounded-none"
    : isMobile
    ? "bcw-fixed bcw-inset-0 bcw-w-full bcw-h-full bcw-rounded-none"
    : "bcw-w-[360px] bcw-h-[480px] bcw-rounded-xl";

  // Panel position: clamp so it doesn't go off-screen. Expanded/mobile use
  // the inset-0 fixed positioning above instead of right/bottom offsets.
  const panelRight = Math.max(8, pillPosition.right - 8);
  const panelBottom = Math.max(8, pillPosition.bottom + 64);
  const usesInsetPositioning = expanded || isMobile;

  return (
    <div
      className="bcw-fixed bcw-z-[1000]"
      style={usesInsetPositioning && open ? {} : { right: pillPosition.right, bottom: pillPosition.bottom }}
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
          style={usesInsetPositioning ? {} : { position: "fixed", right: panelRight, bottom: panelBottom }}
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
            <div className="bcw-flex-1 bcw-min-w-0 bcw-text-xs bcw-font-semibold bcw-text-white bcw-truncate">
              Bulldog Chat
            </div>

            {/* Expand to fullscreen — no-op visually on mobile (already full-screen). */}
            {!isMobile && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
                aria-label={expanded ? "Collapse" : "Expand to fullscreen"}
                title={expanded ? "Collapse" : "Expand to fullscreen"}
                data-testid="bulldog-chat-widget-expand"
              >
                {expanded ? <CollapseIcon /> : <ExpandIcon />}
              </button>
            )}

            {/* Pop out to the full Chat app in a new tab. */}
            <button
              type="button"
              onClick={() => window.open(CHAT_APP_URL, "_blank", "noopener,noreferrer")}
              className="bcw-p-1.5 bcw-rounded hover:bcw-bg-bcw-navy-light bcw-text-white/80"
              aria-label="Open in Bulldog Chat"
              title="Open in Bulldog Chat"
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
              onClick={() => { setOpen(false); setExpanded(false); }}
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

          {/* ── "No channels yet" prompt for an openJob() with nothing to show ── */}
          {jobPrompt && (
            <div className="bcw-px-3 bcw-py-2.5 bcw-bg-bcw-navy-light bcw-border-b bcw-border-black/40 bcw-shrink-0 bcw-space-y-1.5">
              <div className="bcw-text-xs bcw-text-white/90">
                No channels yet for job #{jobPrompt.jobNumber} — create one?
              </div>
              {jobPromptError && <div className="bcw-text-[11px] bcw-text-red-300">{jobPromptError}</div>}
              <div className="bcw-flex bcw-gap-1.5">
                <button
                  type="button"
                  onClick={handleCreateJobChannel}
                  disabled={jobPromptBusy}
                  className="bcw-px-2 bcw-py-1 bcw-rounded bcw-bg-bcw-red bcw-text-white bcw-text-xs bcw-font-semibold disabled:bcw-opacity-50"
                  data-testid="bulldog-chat-widget-create-job-channel"
                >
                  {jobPromptBusy ? "Creating…" : "Create #general"}
                </button>
                <button
                  type="button"
                  onClick={() => setJobPrompt(null)}
                  disabled={jobPromptBusy}
                  className="bcw-px-2 bcw-py-1 bcw-rounded bcw-text-white/70 bcw-text-xs hover:bcw-bg-black/20"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* ── Body ── */}
          <div className="bcw-flex-1 bcw-flex bcw-min-h-0 bcw-relative bcw-bg-white">
            {activeCall ? (
              <CallView
                call={activeCall}
                api={api}
                onCallEnded={() => setActiveCall(null)}
              />
            ) : authed === false ? (
              <div className="bcw-flex-1 bcw-flex bcw-items-center bcw-justify-center bcw-p-4 bcw-text-center bcw-text-xs bcw-text-bcw-navy/60">
                Sign in to Bulldog Chat to use the mini chat.
              </div>
            ) : authed === true && me ? (
              // Full chat experience, shared with the main app. Keyed so a
              // resolved openJob target remounts ChatApp and re-triggers its
              // internal deep-link-style effect for the new channel.
              <QueryClientProvider client={chatUiQueryClient}>
                <ChatApp
                  key={jobChannelId ?? "default"}
                  user={me as unknown as ChatUiApiUser}
                  apiBaseUrl={apiBaseUrl}
                  initialChannelId={jobChannelId}
                />
              </QueryClientProvider>
            ) : (
              <div className="bcw-flex-1 bcw-flex bcw-items-center bcw-justify-center bcw-p-4 bcw-text-center bcw-text-xs bcw-text-bcw-navy/60">
                Loading…
              </div>
            )}
          </div>
        </div>
      )}
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
function ExpandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" />
    </svg>
  );
}
function CollapseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3v4a1 1 0 01-1 1H4M15 3v4a1 1 0 001 1h4M9 21v-4a1 1 0 00-1-1H4M15 21v-4a1 1 0 011-1h4" />
    </svg>
  );
}
function PopOutIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
