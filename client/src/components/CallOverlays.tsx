/**
 * CallOverlays — full-screen UI for incoming, outgoing, and active 1:1
 * calls. Mounts once at the app root so the modal appears no matter
 * which page the user is on when the phone rings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, MonitorUp, Loader2, Volume2, UserPlus, X, Check, Search, PhoneCall, FileText, Sparkles, LayoutGrid, MessageSquare, Users, MoreHorizontal } from "lucide-react";
import { useCalls } from "@/lib/CallContext";
import { useLiveKitRoom, attachTrack } from "@/lib/useLiveKitRoom";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Avatar } from "./Avatar";
import type { RoomParticipantState } from "@/lib/useLiveKitRoom";
import type { ApiUser, ApiChannel } from "@/types/api";
import { useAuth } from "@/lib/auth";
import { MeetingClerkButton, MeetingClerkBanner } from "./MeetingClerkButton";
import { CallVideoStage, type CallLayout, type StageParticipant } from "./call/CallVideoStage";
import { InCallChatPanel } from "./InCallChatPanel";
import { useToast } from "@/hooks/use-toast";
import { ContractPanel } from "./call/ContractPanel";
import { VirtualBackgroundPicker, loadSavedSelection, type BgSelection } from "./call/VirtualBackgroundPicker";
import { VirtualBackgroundProcessor } from "@/lib/virtual-background";
import { isNativeApp, openInIosApp } from "@/lib/native-app";

// Group calls run in a room named `group-channel-<id>-<ts>` or
// `vector-<org>-channel-<id>`. 1:1 calls use `direct-<callId>` and have no
// channel. Returns the numeric channelId or null.
function channelIdFromRoomName(roomName: string | undefined | null): number | null {
  if (!roomName) return null;
  const m = roomName.match(/(?:group-channel-|vector-\d+-channel-)(\d+)/);
  return m ? Number(m[1]) : null;
}

// Detect iOS in-app browsers (Messages, Mail, Slack, Instagram, etc.) that
// frequently block getUserMedia / WebRTC. These browsers omit "Safari" from
// the UA string even though they're WebKit-based. When detected we show a
// banner asking the user to tap the share/Safari icon and open in real Safari.
// (Phase 1.9.26 — user reported camera doesn't work in the in-app browser.)
function detectIOSInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  // Running inside the Bulldog native iOS shell. The native WKWebView grants
  // camera/mic (allowsInlineMediaPlayback + no user-action gate), so the
  // "camera blocked" banner is wrong here and the normal getUserMedia path
  // must run. Genuine in-app browsers (Slack/Messages/Mail) still fall through.
  if (isNativeApp()) return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1);
  if (!isIOS) return false;
  // Real Safari includes "Safari/" + "Version/" in UA. In-app WKWebViews omit one or both.
  const isRealSafari = /Safari\//.test(ua) && /Version\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return !isRealSafari;
}

const LAYOUT_STORAGE_KEY = "bulldog.call.layout";
function loadSavedLayout(): CallLayout {
  try {
    const v = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (v === "grid" || v === "speaker" || v === "sidebar") return v;
  } catch { /* ignore */ }
  return "grid";
}

export function CallOverlays() {
  const calls = useCalls();
  return (
    <>
      {calls.incoming && <IncomingCallModal />}
      {calls.outgoing && <OutgoingCallModal />}
      {calls.active && <ActiveCallOverlay />}
      {calls.lastEnded && <EndedToast />}
    </>
  );
}

/* ────────────────── Incoming (ringing) modal ────────────────── */

function IncomingCallModal() {
  const { incoming, acceptIncoming, declineIncoming } = useCalls();
  if (!incoming) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm" data-testid="modal-incoming-call">
      <div className="w-full max-w-sm rounded-2xl bg-[hsl(220_60%_12%)] border border-[hsl(220_40%_22%)] p-6 shadow-2xl text-center">
        <div className="text-xs font-mono uppercase tracking-[0.18em] text-vs-blue-light mb-4 animate-pulse">
          Incoming {incoming.kind === "video" ? "video" : "voice"} call
        </div>
        <div className="flex justify-center mb-4">
          <div className="speaking-ring rounded-full">
            <Avatar member={{ name: incoming.callerName, hue: incoming.callerHue }} size={96} ring="blue" />
          </div>
        </div>
        <div className="text-xl font-display text-white mb-1">{incoming.callerName}</div>
        <div className="text-xs text-[hsl(0_0%_60%)] font-mono mb-6">is calling you</div>
        <div className="flex gap-3 justify-center">
          <button
            type="button"
            onClick={() => { void declineIncoming(); }}
            className="h-14 w-14 rounded-full bg-vs-red hover:bg-[hsl(var(--vs-red-bright))] text-white flex items-center justify-center shadow-lg transition-colors"
            title="Decline"
            data-testid="button-decline-call"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
          <button
            type="button"
            onClick={() => { void acceptIncoming(); }}
            className="h-14 w-14 rounded-full bg-vs-green hover:bg-[hsl(145_60%_55%)] text-[hsl(220_60%_9%)] flex items-center justify-center shadow-lg transition-colors"
            title="Accept"
            data-testid="button-accept-call"
          >
            <Phone className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────── Outgoing (calling…) modal ────────────────── */

function OutgoingCallModal() {
  const { outgoing, cancelOutgoing } = useCalls();
  if (!outgoing) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm" data-testid="modal-outgoing-call">
      <div className="w-full max-w-sm rounded-2xl bg-[hsl(220_60%_12%)] border border-[hsl(220_40%_22%)] p-6 shadow-2xl text-center">
        <div className="text-xs font-mono uppercase tracking-[0.18em] text-vs-amber mb-4 flex items-center justify-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          Calling…
        </div>
        <div className="flex justify-center mb-4">
          <Avatar member={{ name: outgoing.calleeName, hue: outgoing.calleeHue }} size={96} />
        </div>
        <div className="text-xl font-display text-white mb-1">{outgoing.calleeName}</div>
        <div className="text-xs text-[hsl(0_0%_60%)] font-mono mb-6">
          {outgoing.kind === "video" ? "Video call" : "Voice call"} · waiting for them to pick up
        </div>
        <button
          type="button"
          onClick={() => { void cancelOutgoing(); }}
          className="h-12 px-6 rounded-full bg-vs-red hover:bg-[hsl(var(--vs-red-bright))] text-white flex items-center gap-2 mx-auto shadow-lg transition-colors"
          data-testid="button-cancel-call"
        >
          <PhoneOff className="w-4 h-4" />
          <span className="text-sm font-semibold">Cancel</span>
        </button>
      </div>
    </div>
  );
}

/* ────────────────── Active call overlay ────────────────── */

/** Format elapsed seconds as HH:MM:SS (or MM:SS for < 1 hour). */
function formatCallTimer(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function ActiveCallOverlay() {
  const { active, endActive } = useCalls();
  const [micMuted, setMicMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(active?.kind === "video");
  const [screenSharing, setScreenSharing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // Call timer — tracks seconds since this component mounted (proxy for call start).
  const callStartRef = useRef<number>(Date.now());
  const [timerSecs, setTimerSecs] = useState(0);
  useEffect(() => {
    callStartRef.current = Date.now();
    setTimerSecs(0);
    const id = setInterval(() => {
      setTimerSecs(Math.floor((Date.now() - callStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active?.callId, active?.roomName]);

  // ── In-call HUD upgrades (Phase 1.9.14) ───────────────────────────────
  const channelId = useMemo(() => channelIdFromRoomName(active?.roomName), [active?.roomName]);
  const hasChannel = typeof channelId === "number";

  const [contractOpen, setContractOpen] = useState(false);
  // In-call chat side panel (Phase 1.9.28). The Chat toolbar button was
  // previously a no-op toast; now it opens this panel which shows the channel's
  // recent messages and lets the user send without leaving the call overlay.
  const [chatOpen, setChatOpen] = useState(false);

  // Wire bulldog:toast events into the global toast system so the
  // camera/mic/screen failure messages from onTrackError actually render
  // (Phase 1.9.28). Without this listener, the events were no-ops and the
  // user saw nothing when the camera failed.
  const { toast } = useToast();
  useEffect(() => {
    function onToast(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      toast({ description: String(detail), duration: 8000 });
    }
    window.addEventListener("bulldog:toast", onToast);
    return () => window.removeEventListener("bulldog:toast", onToast);
  }, [toast]);
  const [panelWidth, setPanelWidth] = useState(400);
  const [layout, setLayout] = useState<CallLayout>(loadSavedLayout);
  const [bgOpen, setBgOpen] = useState(false);
  const [bgSel, setBgSel] = useState<BgSelection>(() => loadSavedSelection());
  const processorRef = useRef<VirtualBackgroundProcessor | null>(null);

  // iOS in-app browser warning (Phase 1.9.26). Calculated once at mount.
  const isInAppBrowser = useMemo(() => detectIOSInAppBrowser(), []);
  const [inAppDismissed, setInAppDismissed] = useState(false);
  const [escapeLinkCopied, setEscapeLinkCopied] = useState(false);

  // Reset toggles when the call changes.
  useEffect(() => {
    setMicMuted(false);
    setVideoOn(active?.kind === "video");
    setScreenSharing(false);
    setContractOpen(false);
    setBgOpen(false);
    setMoreOpen(false);
  }, [active?.callId, active?.kind, active?.roomName]);

  const lk = useLiveKitRoom({
    token: active?.token ?? null,
    wsUrl: active?.wsUrl ?? null,
    // roomKey must be unique per call AND per channel-group call (callId is 0
    // for group calls), so fall back to the room name which is always unique.
    roomKey: active ? (active.callId ? `direct-${active.callId}` : active.roomName) : null,
    micMuted,
    videoOn,
    screenSharing,
    onTrackError: (kind, err) => {
      console.warn(`[call] ${kind} error`, err);
      if (kind === "camera") setVideoOn(false);
      if (kind === "screen") setScreenSharing(false);
      // Phase 1.9.28 — surface the real failure to the user. Previously we
      // silently flipped the toggle off and the user had no idea why. Map
      // the common DOMException names to actionable messages.
      const e = err as Error & { name?: string };
      const name = e?.name || "";
      const msg = e?.message || String(err);
      let toast = `${kind === "camera" ? "Camera" : kind === "mic" ? "Microphone" : "Screen share"} couldn't start.`;
      if (name === "NotAllowedError" || /permission|denied/i.test(msg)) {
        toast = kind === "camera"
          ? "Camera permission denied. In iOS: Settings → Bulldog → Camera → enable. In Safari: tap aA → Website Settings → Camera → Allow, then reload."
          : kind === "mic"
          ? "Microphone permission denied. iOS: Settings → Bulldog → Microphone → enable."
          : "Screen-share permission denied.";
      } else if (name === "NotFoundError" || /no.*device|not.*found/i.test(msg)) {
        toast = `No ${kind === "camera" ? "camera" : kind === "mic" ? "microphone" : "screen"} found on this device.`;
      } else if (name === "NotReadableError" || /in use|busy/i.test(msg)) {
        toast = `${kind === "camera" ? "Camera" : "Mic"} is in use by another app. Close FaceTime / Zoom / Camera and try again.`;
      } else if (name === "OverconstrainedError") {
        toast = `${kind} constraints not supported by this device.`;
      } else if (/getUserMedia is not implemented|not supported|secure context/i.test(msg)) {
        toast = "This browser/WebView doesn't expose the camera. Open chat.bulldogops.com in Safari instead.";
      } else if (msg) {
        toast = `${toast} (${msg})`;
      }
      window.dispatchEvent(new CustomEvent("bulldog:toast", { detail: toast }));
    },
  });

  // Fetch channel details (for the linked contract). Only when we have a
  // channel-scoped call and the room is up.
  const channelQ = useQuery<ApiChannel>({
    queryKey: ["/api/channels", channelId],
    enabled: hasChannel,
  });
  const contract = channelQ.data?.linkedContract ?? null;
  const contractPdfUrl = contract?.pdfUrl ?? null;

  // ── Virtual background pipeline ───────────────────────────────────────
  const applyBackground = useCallbackApplyBackground(lk, videoOn, bgSel, processorRef);
  useEffect(() => { void applyBackground(); }, [applyBackground]);
  // Tear down the processor on unmount.
  useEffect(() => () => { processorRef.current?.stop(); processorRef.current = null; }, []);

  const cycleLayout = () => {
    setLayout((cur) => {
      const next: CallLayout = cur === "grid" ? "speaker" : cur === "speaker" ? "sidebar" : "grid";
      try { localStorage.setItem(LAYOUT_STORAGE_KEY, next); } catch { /* ignore */ }
      return next;
    });
  };

  // Ending the call must also stop any clerk that's still recording on this
  // channel — otherwise the post-process pipeline (transcript → summary →
  // PDF → post + email) never fires. We read the notes the clerk banner is
  // already polling (cached under the same key) and fire-and-forget the stop
  // so the call ends instantly; the server runs the pipeline async.
  const endCallWithClerkStop = useCallback(() => {
    if (hasChannel) {
      try {
        const notes = queryClient.getQueryData<{ id: number; status: string }[]>([
          "/api/channels", channelId, "meeting-notes",
        ]);
        const recording = (notes ?? []).find(n => n.status === "recording");
        if (recording) {
          void apiRequest("POST", `/api/meeting-notes/${recording.id}/stop`).catch(() => null);
        }
      } catch { /* ignore — never block the hangup */ }
    }
    void endActive();
  }, [hasChannel, channelId, endActive]);

  if (!active) return null;

  const others: StageParticipant[] = lk.participants
    .filter((p) => !p.isLocal)
    .map((p) => ({ key: p.identity, name: p.name, hue: active.otherHue, participant: p, isMe: false }));
  const meParticipant = lk.participants.find((p) => p.isLocal) ?? null;
  const me: StageParticipant = { key: "me", name: "You", hue: 210, participant: meParticipant, isMe: true, muted: micMuted, videoOff: !videoOn };
  // Solo / 1:1 fallback so the stage always has the "other" tile present.
  const stageOthers: StageParticipant[] = others.length > 0
    ? others
    : [{ key: "them", name: active.otherName, hue: active.otherHue, participant: null, isMe: false }];
  const firstRemote = others[0]?.participant ?? null;

  const effectiveLayout: CallLayout = contractOpen && layout === "grid" ? "sidebar" : layout;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-[hsl(220_65%_8%)] text-white"
      style={{
        // Honor iOS safe areas when running as a native app / standalone PWA so
        // the system status bar (clock, battery, dynamic island) doesn't overlap
        // the toolbar. (Phase 1.9.26 — user reported overlap in app.)
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
      data-testid="overlay-active-call"
    >

      {/* ── Teams-style top toolbar (Phase 1.9.24, mobile-responsive 1.9.26) ── */}
      {/* On mobile the row becomes horizontally scrollable so every control
          stays reachable (Effects/Clerk/More/Leave were being cut off on iPhone
          per Phase 1.9.26 user report). The Leave button is rendered OUTSIDE
          the scroll container so it's always pinned on the right edge. */}
      <div className="shrink-0 px-2 sm:px-4 py-2 border-b border-[hsl(220_40%_22%)] bg-[hsl(220_60%_11%)] flex items-center gap-0">
        {/* Call timer — upper left, compact on mobile */}
        <div className="flex items-center gap-1 sm:gap-1.5 mr-2 sm:mr-4 shrink-0">
          <Volume2 className="w-4 h-4 text-vs-blue" />
          <span className="font-mono text-xs sm:text-sm text-white tabular-nums">{formatCallTimer(timerSecs)}</span>
        </div>

        {/* Toolbar buttons row — scrolls horizontally on narrow screens so
            nothing is hidden. The flex-1 lets it consume remaining width;
            min-w-0 + overflow-x-auto enables the scroll. */}
        <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1 w-max mx-auto">

          {/* Chat (Phase 1.9.28) — toggles the in-call chat side panel so the
              user can read and send channel messages without leaving the call. */}
          <TopBarBtn
            icon={<MessageSquare className="w-5 h-5" />}
            label="Chat"
            active={chatOpen}
            onClick={() => setChatOpen(o => !o)}
            testid="call-toolbar-chat"
          />

          {/* People — show count badge */}
          <TopBarBtn
            icon={
              <span className="relative inline-flex">
                <Users className="w-5 h-5" />
                {lk.participants.length > 0 && (
                  <span className="absolute -top-1 -right-1 h-3.5 min-w-3.5 rounded-full bg-vs-blue text-[hsl(220_60%_9%)] text-[9px] font-bold flex items-center justify-center px-0.5">
                    {lk.participants.length}
                  </span>
                )}
              </span>
            }
            label="People"
            active={false}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("bulldog:toast", { detail: `${lk.participants.length} participant(s) in this call` }));
            }}
            testid="call-toolbar-people"
          />

          {/* View — cycles layout */}
          <TopBarBtn
            icon={<LayoutGrid className="w-5 h-5" />}
            label={layout.charAt(0).toUpperCase() + layout.slice(1)}
            active={true}
            onClick={cycleLayout}
            testid="call-toolbar-view"
          />

          {/* Divider */}
          <div className="w-px h-8 bg-[hsl(220_40%_22%)] mx-1" />

          {/* Camera — Phase 1.9.30: route through lk.toggleCamera() so the
              iOS gesture-safe imperative path is preserved. Previously we
              just flipped a React state which never invoked the iOS-only
              manual publish path — so on iOS the camera toggle was a no-op
              and the local tile stayed an avatar. */}
          <TopBarBtn
            icon={videoOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
            label="Camera"
            active={videoOn}
            onClick={() => {
              // Fire toggleCamera() inside the click gesture so iOS
              // getUserMedia() runs while the user-activation token is
              // still valid. The returned promise resolves to the new
              // "on" state — mirror it into React state for the UI.
              lk.toggleCamera().then((nowOn) => setVideoOn(nowOn)).catch(() => {});
            }}
            disabled={lk.status !== "connected"}
            testid="call-video"
          />

          {/* Mic — same iOS gesture-safe routing as Camera (Phase 1.9.30). */}
          <TopBarBtn
            icon={micMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            label={micMuted ? "Unmute" : "Mute"}
            active={!micMuted}
            onClick={() => {
              lk.toggleMic().then((nowMuted) => setMicMuted(nowMuted)).catch(() => {});
            }}
            disabled={lk.status !== "connected"}
            testid="call-mic"
          />

          {/* Share screen */}
          <TopBarBtn
            icon={<MonitorUp className="w-5 h-5" />}
            label={screenSharing ? "Sharing" : "Share"}
            active={screenSharing}
            onClick={() => setScreenSharing(s => !s)}
            disabled={lk.status !== "connected"}
            testid="call-screen"
          />

          {/* Background effects — first-class toolbar button (Phase 1.9.25) */}
          <TopBarBtn
            icon={<Sparkles className="w-5 h-5" />}
            label="Effects"
            active={bgOpen}
            onClick={() => setBgOpen(o => !o)}
            disabled={!videoOn}
            testid="call-toolbar-effects"
          />

          {/* AI Meeting Clerk — inline button so it's always visible (Phase 1.9.25) */}
          {hasChannel && (
            <div className="flex items-center" data-testid="call-toolbar-clerk">
              <MeetingClerkButton channelId={channelId} canControl={true} roomName={active.roomName} compact />
            </div>
          )}

          {/* Add people — first-class toolbar button (Phase 1.9.27). Promoted
              out of the More popover because solo-meeting users need to invite
              people mid-call; it was previously buried two taps deep. */}
          <TopBarBtn
            icon={<UserPlus className="w-5 h-5" />}
            label="Add"
            active={addOpen}
            onClick={() => setAddOpen(true)}
            testid="call-toolbar-addpeople"
          />

          {/* More — popover holds only contextual extras now (Contract). The
              popover is hidden entirely when there's nothing to show. */}
          {contractPdfUrl && (
            <div className="relative">
              <TopBarBtn
                icon={<MoreHorizontal className="w-5 h-5" />}
                label="More"
                active={moreOpen}
                onClick={() => setMoreOpen(o => !o)}
                testid="call-toolbar-more"
              />
              {moreOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-[120] w-56 rounded-lg bg-[hsl(220_55%_13%)] border border-[hsl(220_40%_25%)] shadow-2xl overflow-hidden"
                  onMouseLeave={() => setMoreOpen(false)}
                >
                  <button
                    type="button"
                    onClick={() => { setContractOpen(o => !o); setMoreOpen(false); }}
                    className="w-full px-3 py-2.5 flex items-center gap-3 text-sm text-white hover:bg-[hsl(220_50%_20%)] text-left"
                  >
                    <FileText className="w-4 h-4 text-vs-blue-light shrink-0" />
                    {contractOpen ? "Hide contract" : "View contract"}
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
        </div>

        {/* Leave — ALWAYS pinned on the right (outside scroll container) so the
            user can always hang up regardless of screen size. */}
        <button
          type="button"
          onClick={endCallWithClerkStop}
          className="ml-1 sm:ml-2 shrink-0 flex flex-col items-center gap-0.5 px-2 sm:px-3 py-1.5 rounded-md bg-vs-red hover:bg-[hsl(var(--vs-red-bright))] text-white transition-colors min-w-[44px]"
          data-testid="button-end-call"
          title="Leave call"
        >
          <PhoneOff className="w-5 h-5" />
          <span className="text-[10px] font-medium">Leave</span>
        </button>
      </div>

      {/* iOS in-app browser banner (Phase 1.9.26) — surfaces when the user
          opened the link from Messages/Mail/Slack/etc, which blocks the
          camera. Dismissable but persistent until tapped. */}
      {isInAppBrowser && !inAppDismissed && (
        <div className="shrink-0 px-4 py-3 bg-[hsl(var(--vs-accent)/0.32)] border-b border-[hsl(var(--vs-accent)/0.6)] text-xs text-[hsl(var(--vs-accent))] flex items-start gap-2">
          <VideoOff className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm">Camera blocked in this browser</div>
            <div className="text-[11px] opacity-90 leading-snug mt-0.5">
              iOS in-app browsers block camera and mic. Open the meeting in the Bulldog app or copy the link into Safari.
            </div>
            <div className="flex flex-col gap-2 mt-2.5">
              <button
                type="button"
                onClick={() => openInIosApp(window.location.href)}
                className="w-full px-3 py-2 rounded-md bg-vs-blue hover:bg-[hsl(var(--vs-accent-hover))] text-white text-sm font-medium transition-colors"
                data-testid="button-open-in-ios-app"
              >
                Open in Bulldog app
              </button>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(window.location.href).then(() => {
                    setEscapeLinkCopied(true);
                    setTimeout(() => setEscapeLinkCopied(false), 2000);
                  }).catch(() => {});
                }}
                className="w-full px-3 py-2 rounded-md border border-[hsl(var(--vs-accent)/0.6)] hover:bg-black/20 text-[hsl(var(--vs-accent))] text-sm font-medium transition-colors"
                data-testid="button-copy-meeting-link"
              >
                {escapeLinkCopied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setInAppDismissed(true)}
            className="shrink-0 p-1 rounded hover:bg-black/20"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Status warning bar (shown only when not connected) */}
      {lk.status !== "connected" && (
        <div className="shrink-0 px-4 py-1.5 bg-[hsl(40_80%_45%/0.12)] border-b border-[hsl(40_80%_45%/0.3)] text-[11px] uppercase tracking-wider font-mono text-[hsl(40_80%_60%)] text-center">
          {lk.status === "connecting" || lk.status === "reconnecting"
            ? "Connecting… controls active once joined"
            : lk.status === "failed"
            ? "Call failed to connect. Leave and try again."
            : "Waiting for media…"}
        </div>
      )}

      {/* Clerk banner — visible to every participant while a clerk runs. */}
      {hasChannel && <MeetingClerkBanner channelId={channelId} />}

      {/* Virtual background picker (floats above stage when open) */}
      {bgOpen && (
        <div className="shrink-0 border-b border-[hsl(220_40%_22%)] bg-[hsl(220_55%_11%)] px-4 py-2">
          <VirtualBackgroundPicker
            current={bgSel}
            onSelect={(sel) => { setBgSel(sel); setBgOpen(false); }}
            onClose={() => setBgOpen(false)}
          />
        </div>
      )}

      {/* Error banner */}
      {lk.error && (
        <div className="px-4 py-2 bg-[hsl(var(--vs-accent)/0.15)] border-b border-[hsl(var(--vs-accent)/0.4)] text-xs text-[hsl(var(--vs-accent))] text-center">
          {lk.error}
        </div>
      )}

      {/* Body: video stage + optional contract side-panel. */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 p-4">
          <CallVideoStage layout={effectiveLayout} me={me} others={stageOthers} />
        </div>
        {contractOpen && contractPdfUrl && hasChannel && (
          <ContractPanel
            title={contract?.title ?? "Contract"}
            channelId={channelId}
            pdfUrl={contractPdfUrl}
            width={panelWidth}
            onWidthChange={setPanelWidth}
            onClose={() => setContractOpen(false)}
          />
        )}
        {chatOpen && hasChannel && (
          <InCallChatPanel
            channelId={channelId!}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>

      {/* Hidden audio sink so the remote can be heard. */}
      <RemoteAudio participant={firstRemote} />

      {addOpen && <InCallAddDialog onClose={() => setAddOpen(false)} />}
    </div>
  );
}

// Drives the virtual-background processor in response to the chosen mode and
// camera state. Returns a stable async callback the overlay can fire from an
// effect. On any MediaPipe failure it reverts to the raw camera and toasts.
function useCallbackApplyBackground(
  lk: ReturnType<typeof useLiveKitRoom>,
  videoOn: boolean,
  bgSel: BgSelection,
  processorRef: React.MutableRefObject<VirtualBackgroundProcessor | null>,
) {
  return useMemo(() => {
    return async () => {
      // No effect when camera is off or "none" — make sure any processor is
      // torn down and the raw camera is restored.
      const teardown = async () => {
        if (processorRef.current) {
          processorRef.current.stop();
          processorRef.current = null;
          await lk.replaceCameraTrack(null);
        }
      };

      if (!videoOn || lk.status !== "connected") { await teardown(); return; }
      if (bgSel.mode.kind === "none") { await teardown(); return; }

      const raw = lk.getRawCameraTrack();
      if (!raw) return; // camera not published yet; effect re-runs on change

      try {
        // Reuse an existing processor by swapping its mode; otherwise spin up.
        if (processorRef.current) {
          await processorRef.current.setMode(bgSel.mode);
          return;
        }
        const proc = new VirtualBackgroundProcessor();
        const processed = await proc.start(raw, bgSel.mode);
        processorRef.current = proc;
        const ok = await lk.replaceCameraTrack(processed);
        if (!ok) { proc.stop(); processorRef.current = null; }
      } catch (err) {
        console.warn("[call] virtual background unavailable:", (err as Error).message);
        processorRef.current?.stop();
        processorRef.current = null;
        if (typeof window !== "undefined") {
          // Lightweight toast — no toast lib wired into this overlay.
          window.dispatchEvent(new CustomEvent("bulldog:toast", { detail: "Background effects unavailable" }));
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoOn, lk.status, bgSel.id, bgSel.mode.kind]);
}

/* ──────────────────────────────────────────────────────────────────────────
 * InCallAddDialog — picker shown when the caller taps the UserPlus
 * button on the active-call overlay. Lists org members (minus self and
 * deactivated), search bar, per-row App|Phone segmented control, and a
 * free-form phone number field. Submits to inviteToActiveCall() which
 * hits /api/calls/active/invite — server rings them into the live room.
 * ────────────────────────────────────────────────────────────────────────── */

function InCallAddDialog({ onClose }: { onClose: () => void }) {
  const { inviteToActiveCall } = useCalls();
  const { user } = useAuth();
  const meId = (user as ApiUser | null)?.id;

  const membersQ = useQuery<ApiUser[]>({ queryKey: ["/api/org/members"] });
  const allMembers = useMemo(
    () => (membersQ.data ?? []).filter((m) => m.id !== meId && !(m as { deactivated?: boolean }).deactivated),
    [membersQ.data, meId],
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [route, setRoute] = useState<Map<number, "app" | "phone">>(new Map());
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [emailAddresses, setEmailAddresses] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allMembers;
    return allMembers.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  }, [allMembers, query]);

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
    setRoute((prev) => {
      const next = new Map(prev);
      if (!next.has(id)) next.set(id, "app");
      return next;
    });
  };

  const setRouteFor = (id: number, r: "app" | "phone") => {
    setRoute((prev) => { const next = new Map(prev); next.set(id, r); return next; });
  };

  const addPhone = () => {
    const raw = phoneInput.trim();
    if (!raw) return;
    const normalized = raw.startsWith("+")
      ? "+" + raw.slice(1).replace(/\D/g, "")
      : "+1" + raw.replace(/\D/g, "");
    if (!/^\+\d{8,15}$/.test(normalized)) { setError("Enter a valid phone number"); return; }
    if (phoneNumbers.includes(normalized)) { setPhoneInput(""); return; }
    setPhoneNumbers((p) => [...p, normalized]);
    setPhoneInput("");
    setError(null);
  };

  const addEmail = () => {
    const raw = emailInput.trim().toLowerCase();
    if (!raw) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) { setError("Enter a valid email address"); return; }
    if (emailAddresses.includes(raw)) { setEmailInput(""); return; }
    setEmailAddresses((arr) => [...arr, raw]);
    setEmailInput("");
    setError(null);
  };

  const totalTargets = selected.size + phoneNumbers.length + emailAddresses.length;

  const submit = async () => {
    if (totalTargets === 0) { setError("Pick at least one person or phone number"); return; }
    const appIds: number[] = [];
    const phoneIds: number[] = [];
    for (const id of Array.from(selected)) {
      if (route.get(id) === "phone") phoneIds.push(id); else appIds.push(id);
    }
    setSubmitting(true);
    setError(null);
    setWarnings([]);
    try {
      const resp = await inviteToActiveCall({
        inviteeIds: appIds, phoneInviteeIds: phoneIds, phoneNumbers, emailAddresses,
      });
      const allWarnings = [...(resp.dialWarnings ?? []), ...(resp.emailWarnings ?? [])];
      if (allWarnings.length > 0) {
        setWarnings(allWarnings);
        // Keep the dialog open so the user can see the warnings;
        // they can close manually.
      } else {
        onClose();
      }
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Failed to add people");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      data-testid="dialog-in-call-add"
    >
      <div
        className="w-full md:w-[520px] md:max-w-[92vw] max-h-[92vh] flex flex-col bg-[hsl(220_55%_13%)] border border-[hsl(220_40%_25%)] md:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[hsl(220_40%_22%)] flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-display text-white">Add to this call</div>
            <div className="text-[10px] text-[hsl(0_0%_60%)] font-mono uppercase tracking-wider">
              Ring more people into the live room
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-[hsl(0_0%_70%)] hover:text-white hover:bg-black/30"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 py-2 border-b border-[hsl(220_40%_22%)] shrink-0">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)]">
            <Search className="w-4 h-4 text-[hsl(0_0%_55%)] shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members…"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-[hsl(0_0%_50%)] outline-none"
              data-testid="input-in-call-add-search"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {membersQ.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-vs-blue" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-xs text-[hsl(0_0%_60%)] py-6">No members match “{query}”</div>
          ) : (
            <ul className="px-2 py-2 flex flex-col gap-1">
              {filtered.map((m) => {
                const isSel = selected.has(m.id);
                const r = route.get(m.id) ?? "app";
                const hasPhone = !!(m.phone && m.phone.trim());
                return (
                  <li key={m.id}>
                    <div
                      className={[
                        "flex items-center gap-2 px-2 py-1.5 rounded-md",
                        isSel ? "bg-[hsl(220_50%_22%)] ring-1 ring-vs-blue/40" : "hover:bg-[hsl(220_45%_22%)]",
                      ].join(" ")}
                    >
                      <button
                        type="button"
                        onClick={() => toggleOne(m.id)}
                        className="flex-1 min-w-0 flex items-center gap-2 text-left"
                        data-testid={`in-call-add-row-${m.id}`}
                      >
                        <div className={[
                          "w-5 h-5 rounded-md border flex items-center justify-center shrink-0",
                          isSel ? "bg-vs-blue border-vs-blue text-[hsl(220_60%_9%)]" : "border-[hsl(0_0%_45%)]",
                        ].join(" ")}>
                          {isSel && <Check className="w-3 h-3" strokeWidth={3} />}
                        </div>
                        <Avatar member={{ name: m.name, hue: m.hue }} size={28} />
                        <div className="min-w-0">
                          <div className="text-sm text-white truncate">{m.name}</div>
                          <div className="text-[10px] text-[hsl(0_0%_60%)] truncate">{m.email}</div>
                        </div>
                      </button>
                      {isSel && (
                        <div className="flex items-center gap-0.5 shrink-0 bg-[hsl(220_60%_11%)] rounded-md p-0.5 border border-[hsl(220_40%_25%)]">
                          <button
                            type="button"
                            onClick={() => setRouteFor(m.id, "app")}
                            className={[
                              "px-2 py-1 rounded text-[11px] font-mono uppercase tracking-wider flex items-center gap-1",
                              r === "app" ? "bg-vs-blue text-[hsl(220_60%_9%)]" : "text-[hsl(0_0%_65%)] hover:text-white",
                            ].join(" ")}
                            title="Ring in the app"
                          >
                            <Video className="w-3 h-3" /> App
                          </button>
                          <button
                            type="button"
                            onClick={() => hasPhone && setRouteFor(m.id, "phone")}
                            disabled={!hasPhone}
                            className={[
                              "px-2 py-1 rounded text-[11px] font-mono uppercase tracking-wider flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed",
                              r === "phone" ? "bg-vs-red text-white" : "text-[hsl(0_0%_65%)] hover:text-white",
                            ].join(" ")}
                            title={hasPhone ? "Dial their cell" : "No phone on file"}
                          >
                            <PhoneCall className="w-3 h-3" /> Phone
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="shrink-0 px-3 py-2 border-t border-[hsl(220_40%_22%)] bg-[hsl(220_55%_11%)] flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider font-mono text-[hsl(0_0%_55%)]">Or dial a phone number</div>
          <div className="flex items-center gap-2">
            <input
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhone(); } }}
              placeholder="+1 555 123 4567"
              inputMode="tel"
              className="flex-1 bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-2 py-1.5 text-sm text-white placeholder:text-[hsl(0_0%_45%)] outline-none focus:border-vs-blue"
              data-testid="input-in-call-add-phone"
            />
            <button
              type="button"
              onClick={addPhone}
              className="px-3 py-1.5 rounded-md bg-[hsl(220_45%_27%)] hover:bg-[hsl(220_45%_32%)] text-white text-sm"
            >
              Add
            </button>
          </div>
          {phoneNumbers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {phoneNumbers.map((p) => (
                <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-vs-red/15 border border-vs-red/40 text-[hsl(var(--vs-accent))]">
                  {p}
                  <button type="button" onClick={() => setPhoneNumbers((arr) => arr.filter((x) => x !== p))} className="hover:text-white" aria-label={`Remove ${p}`}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="text-[10px] uppercase tracking-wider font-mono text-[hsl(0_0%_55%)] mt-1">Or email a join link</div>
          <div className="flex items-center gap-2">
            <input
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
              placeholder="guest@example.com"
              type="email"
              inputMode="email"
              className="flex-1 bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] rounded-md px-2 py-1.5 text-sm text-white placeholder:text-[hsl(0_0%_45%)] outline-none focus:border-vs-blue"
              data-testid="input-in-call-add-email"
            />
            <button
              type="button"
              onClick={addEmail}
              className="px-3 py-1.5 rounded-md bg-[hsl(220_45%_27%)] hover:bg-[hsl(220_45%_32%)] text-white text-sm"
            >
              Add
            </button>
          </div>
          {emailAddresses.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {emailAddresses.map((e) => (
                <span key={e} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-vs-blue/15 border border-vs-blue/40 text-vs-blue-light">
                  {e}
                  <button type="button" onClick={() => setEmailAddresses((arr) => arr.filter((x) => x !== e))} className="hover:text-white" aria-label={`Remove ${e}`}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {warnings.length > 0 && (
          <div className="shrink-0 px-3 py-2 bg-[hsl(40_80%_45%/0.12)] border-t border-[hsl(40_80%_45%/0.4)] text-xs text-[hsl(40_80%_75%)]">
            {warnings.map((w, i) => <div key={i}>• {w}</div>)}
          </div>
        )}
        {error && (
          <div className="shrink-0 px-3 py-2 bg-[hsl(var(--vs-accent)/0.15)] border-t border-[hsl(var(--vs-accent)/0.4)] text-xs text-[hsl(var(--vs-accent))]">{error}</div>
        )}

        <div className="shrink-0 px-3 py-3 border-t border-[hsl(220_40%_22%)] bg-[hsl(220_55%_13%)] flex items-center justify-between gap-2">
          <span className="text-[11px] text-[hsl(0_0%_60%)] font-mono">
            {totalTargets > 0 ? `${totalTargets} to add` : "Pick people or phone numbers"}
          </span>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm text-[hsl(0_0%_75%)] hover:text-white">
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || totalTargets === 0}
              className="px-4 py-1.5 rounded-md bg-vs-red hover:bg-[hsl(var(--vs-red-bright))] text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              data-testid="button-in-call-add-submit"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Ring them
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RemoteAudio({ participant }: { participant: RoomParticipantState | null }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    return attachTrack(participant?.audioTrack ?? null, ref.current);
  }, [participant?.audioTrack]);
  return <audio ref={ref} autoPlay className="sr-only" />;
}

function CtrlBtn({
  on, onClick, onIcon, offIcon, title, testid, disabled,
}: {
  on: boolean;
  onClick(): void;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  title: string;
  testid?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${title} (not connected yet)` : title}
      data-testid={testid}
      className={[
        "w-12 h-12 rounded-full flex items-center justify-center transition-all",
        disabled ? "opacity-40 cursor-not-allowed" : "",
        on
          ? "bg-[hsl(220_45%_27%)] hover:bg-[hsl(220_45%_32%)] text-white"
          : "bg-[hsl(var(--vs-accent)/0.25)] hover:bg-[hsl(var(--vs-accent)/0.35)] text-[hsl(var(--vs-accent))] ring-1 ring-[hsl(var(--vs-accent)/0.4)]",
      ].join(" ")}
    >
      {on ? onIcon : offIcon}
    </button>
  );
}

/** Teams-style top-bar button: icon on top + small label underneath. */
function TopBarBtn({
  icon, label, active, onClick, disabled, testid,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick(): void;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testid}
      title={label}
      className={[
        "flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md transition-colors min-w-[48px]",
        disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-[hsl(220_50%_20%)]",
        active ? "text-white" : "text-[hsl(0_0%_70%)]",
      ].join(" ")}
    >
      {icon}
      <span className="text-[10px] font-medium whitespace-nowrap">{label}</span>
    </button>
  );
}

/* ────────────────── Brief "missed/declined" toast ────────────────── */

function EndedToast() {
  const { lastEnded, clearLastEnded } = useCalls();
  useEffect(() => {
    if (!lastEnded) return;
    const id = setTimeout(() => clearLastEnded(), 4000);
    return () => clearTimeout(id);
  }, [lastEnded, clearLastEnded]);

  if (!lastEnded) return null;

  const label = lastEnded.reason === "missed" ? "Missed call"
    : lastEnded.reason === "declined" ? "Call declined"
    : "Call ended";

  return (
    <div className="fixed bottom-6 right-6 z-[110] max-w-xs px-4 py-3 rounded-lg bg-[hsl(220_60%_14%)] border border-[hsl(220_40%_25%)] shadow-2xl text-white flex items-center gap-3" data-testid="toast-call-ended">
      <PhoneOff className="w-4 h-4 text-vs-red shrink-0" />
      <div className="min-w-0">
        <div className="text-xs font-mono uppercase tracking-wider text-[hsl(0_0%_65%)]">{label}</div>
        <div className="text-sm font-semibold truncate">{lastEnded.otherName}</div>
      </div>
    </div>
  );
}
