import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, Hand, Settings, PhoneOff,
  Volume2, MoreHorizontal, ScreenShareOff, Signal, Users, Loader2, AlertTriangle, Sparkles,
  Circle, Square, Play, History, UserPlus, Phone, X, Search,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { motion } from "framer-motion";
import type { ApiChannel, ApiUser, ApiRecording, VoiceTokenResponse } from "@/types/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  useLiveKitRoom,
  attachTrack,
  type RoomParticipantState,
} from "@/lib/useLiveKitRoom";
import type { Track } from "livekit-client";

interface Props {
  channel: ApiChannel;
  me: ApiUser;
  orgMembers: ApiUser[];
  myMicMuted: boolean;
  myVideoOn: boolean;
  myScreenSharing: boolean;
  myHandRaised: boolean;
  onToggleMic: () => void;
  onToggleVideo: () => void;
  onToggleScreen: () => void;
  onToggleHand: () => void;
  onLeave: () => void;
}

/**
 * Display-friendly participant the tile component needs. We blend the
 * live LiveKit participant (which only knows user id + tracks) with the
 * cached org-member directory (name, hue, role, title) so the tiles
 * keep their custom Vector look even with real WebRTC tracks attached.
 */
interface CallParticipant {
  id: number;
  name: string;
  hue: number;
  role: ApiUser["role"];
  title: string | null;
  // Real LiveKit state (null when in demo/preview mode):
  live: RoomParticipantState | null;
  /** Hand raised, sourced from LiveKit attributes in real mode. */
  handRaised?: boolean;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ROLE_LABEL: Record<ApiUser["role"], string> = {
  admin: "Admin", foreman: "Foreman", office: "Office", field: "Field Crew", safety: "Safety",
};

export function VoiceChannelView(props: Props) {
  const { channel, me, orgMembers, myMicMuted, myVideoOn, myScreenSharing, myHandRaised,
    onToggleMic, onToggleVideo, onToggleScreen, onToggleHand, onLeave } = props;

  const [previewMode, setPreviewMode] = useState<boolean | null>(null);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [livekitInfo, setLivekitInfo] = useState<{ token: string; wsUrl: string; roomName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  const canRecord = me.role === "admin" || me.role === "foreman";
  const [showPast, setShowPast] = useState(false);
  const recordingsQ = useQuery<ApiRecording[]>({
    queryKey: ["/api/channels", channel.id, "recordings"],
    enabled: !!channel.id,
    refetchInterval: 8000,
  });
  const activeRec = (recordingsQ.data ?? []).find((r) => r.status === "recording" || r.status === "starting");
  const startRec = useMutation({
    mutationFn: async () => apiRequest<any>("POST", `/api/channels/${channel.id}/recording/start`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/channels", channel.id, "recordings"] }),
  });
  const stopRec = useMutation({
    mutationFn: async () => apiRequest<any>("POST", `/api/channels/${channel.id}/recording/stop`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/channels", channel.id, "recordings"] }),
  });

  // Fetch a LiveKit token for this channel. If the server returns 503
  // with preview_mode (no LK creds) or omits token, we render the
  // demo stage instead of a real call.
  useEffect(() => {
    let cancelled = false;
    setPreviewMode(null);
    setLivekitInfo(null);
    setError(null);
    (async () => {
      try {
        const res = await apiRequest<VoiceTokenResponse>("POST", `/api/channels/${channel.id}/voice/token`);
        if (cancelled) return;
        if (res.token && res.ws_url) {
          setPreviewMode(false);
          setLivekitInfo({ token: res.token, wsUrl: res.ws_url, roomName: res.room_name ?? "" });
        } else {
          setPreviewMode(true);
          setPreviewMessage(res.message ?? "Demo mode.");
        }
      } catch (e: any) {
        if (cancelled) return;
        if (e?.status === 503 && e?.body?.preview_mode) {
          setPreviewMode(true);
          setPreviewMessage(e.body.message ?? "LiveKit not configured.");
        } else {
          setError(e?.body?.message ?? "Could not join voice channel.");
          setPreviewMode(true); // still show stage so user can leave
        }
      }
    })();
    return () => { cancelled = true; };
  }, [channel.id]);

  // --- Live LiveKit session ----------------------------------------------
  // The hook stays "idle" when token/wsUrl are null (preview mode).
  // IMPORTANT: stabilize this callback. The hook holds it in effect deps;
  // if we pass a fresh closure on every render the camera/mic/screen
  // reconciliation effects re-run on every render, which can publish the
  // track repeatedly and freeze the page. useCallback with [] keeps a
  // single stable reference for the life of the component.
  const onTrackError = useCallback((kind: "mic" | "camera" | "screen", err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    setError(`${kind === "mic" ? "Microphone" : kind === "camera" ? "Camera" : "Screen share"} error: ${msg}`);
  }, []);

  const lk = useLiveKitRoom({
    token: livekitInfo?.token ?? null,
    wsUrl: livekitInfo?.wsUrl ?? null,
    roomKey: livekitInfo ? String(channel.id) : null,
    micMuted: myMicMuted,
    videoOn: myVideoOn,
    screenSharing: myScreenSharing,
    onTrackError,
  });

  // Build the display participant list. Real mode = derive from LiveKit
  // participants and enrich with org-member metadata. Demo mode = a
  // deterministic subset of org members for the stage so users still
  // see a populated UI when LK isn't configured.
  const callParticipants: CallParticipant[] = (() => {
    // Real mode (livekitInfo present): LiveKit is the ONLY source of truth
    // for who is in the call. While the room is still connecting and the
    // participant list hasn't populated yet, show just the local user so
    // we don't briefly render ghost org members from the demo fallback.
    if (livekitInfo) {
      if (lk.participants.length > 0) {
        return lk.participants.map((p): CallParticipant => {
          const member = orgMembers.find(u => u.id === p.userId);
          return {
            id: p.userId || (p.isLocal ? me.id : 0),
            name: member?.name ?? p.name,
            hue: member?.hue ?? 210,
            role: member?.role ?? "field",
            title: member?.title ?? null,
            live: p,
            handRaised: p.handRaised,
          };
        });
      }
      // LK connecting: show only me so we don't flash ghosts.
      return [{ id: me.id, name: me.name, hue: me.hue, role: me.role, title: me.title, live: null, handRaised: myHandRaised }];
    }
    // Demo mode (no LK creds): show a deterministic subset of org members
    // so the stage is populated for screenshots / admin previews.
    const others = orgMembers.filter(u => u.id !== me.id).slice(0, 4);
    return [
      { id: me.id, name: me.name, hue: me.hue, role: me.role, title: me.title, live: null, handRaised: myHandRaised },
      ...others.map(u => ({ id: u.id, name: u.name, hue: u.hue, role: u.role, title: u.title, live: null, handRaised: false })),
    ];
  })();

  // Live timer
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [channel.id]);

  // Auto dial-absent: once the call has been live for ~30s, automatically
  // phone-bridge any channel member who is offline (or hasn't joined yet),
  // has a phone number, and isn't in DND. We fire this exactly once per
  // call session (per channel.id mount) so re-renders don't re-ring.
  // Admin/foreman only — server enforces the role check; on 403 we just
  // silently skip without spamming the UI.
  const dialAbsentFiredRef = useRef(false);
  const [dialAbsentToast, setDialAbsentToast] = useState<string | null>(null);
  useEffect(() => {
    dialAbsentFiredRef.current = false;
    setDialAbsentToast(null);
  }, [channel.id]);
  useEffect(() => {
    if (previewMode !== false) return; // only auto-dial in real LK mode
    if (lk.status !== "connected") return; // wait until we're truly in the room
    if (dialAbsentFiredRef.current) return;
    if (me.role !== "admin" && me.role !== "foreman") return; // gated client-side too
    const timer = setTimeout(async () => {
      dialAbsentFiredRef.current = true;
      try {
        const res = await apiRequest<{ dialed: number; skipped: number; warnings?: string[] }>(
          "POST",
          `/api/channels/${channel.id}/dial-absent`,
        );
        if (res.dialed > 0) {
          setDialAbsentToast(
            `Ringing ${res.dialed} absent ${res.dialed === 1 ? "member" : "members"} by phone…`,
          );
          setTimeout(() => setDialAbsentToast(null), 5000);
        }
      } catch (e: any) {
        // 403 (not admin) or 503 (no Twilio): fail quietly. Admins can
        // still hit the Invite modal to phone-bridge manually.
        if (e?.status && e.status !== 403 && e.status !== 503) {
          console.warn("[dial-absent] failed:", e);
        }
      }
    }, 30_000);
    return () => clearTimeout(timer);
  }, [previewMode, lk.status, channel.id, me.role]);

  // Mock speaking simulation — only in preview/demo mode. In real mode
  // LiveKit drives `isSpeaking` directly through ActiveSpeakersChanged.
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  useEffect(() => {
    if (previewMode === false) return; // real LiveKit handles it
    if (callParticipants.length === 0) return;
    const id = setInterval(() => {
      const candidates = callParticipants.filter((m) => m.id !== me.id || !myMicMuted);
      if (candidates.length === 0) return setSpeakingId(null);
      const next = candidates[Math.floor(Math.random() * candidates.length)];
      setSpeakingId(next.id);
      setTimeout(() => setSpeakingId(null), 1100 + Math.random() * 800);
    }, 2400);
    return () => clearInterval(id);
  }, [previewMode, callParticipants.length, me.id, myMicMuted]);

  // Pick a screen sharer to feature: any participant who has an active
  // screen-share track wins; fall back to demo behaviour when offline.
  const realScreenSharer = callParticipants.find(p => p.live?.screenTrack);
  const screenSharerId = realScreenSharer
    ? realScreenSharer.id
    : (previewMode ? callParticipants.find(m => m.id !== me.id)?.id : undefined);

  // While preview mode, deterministically pretend the first 2 non-me
  // tiles have video on. In real mode this is driven by the participant's
  // videoTrack presence.
  const previewVideoIds = callParticipants.filter(m => m.id !== me.id).slice(0, 2).map(m => m.id);

  if (previewMode === null) {
    return (
      <section className="flex-1 flex items-center justify-center bg-[hsl(232_65%_8%)] text-white">
        <div className="text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-vs-blue" />
          <div className="mt-2 text-xs font-mono uppercase tracking-[0.16em] text-[hsl(0_0%_60%)]">Connecting to {channel.name}…</div>
        </div>
      </section>
    );
  }

  // Connection status from LiveKit hook (only meaningful in real mode).
  const lkConnecting = livekitInfo && (lk.status === "connecting" || lk.status === "reconnecting");
  const lkFailed = livekitInfo && lk.status === "failed";

  return (
    <section className="flex-1 flex flex-col min-w-0 min-h-0 bg-[hsl(232_65%_8%)] relative">
      {/* Header */}
      <header className="h-14 px-4 max-md:pl-14 flex items-center gap-3 border-b border-[hsl(232_40%_22%)] shrink-0 bg-[hsl(232_60%_12%)]/60 backdrop-blur-sm">
        <Volume2 className="w-5 h-5 text-vs-red shrink-0" />
        <div className="font-display text-white text-base truncate" data-testid="text-voice-channel-name">{channel.name}</div>
        <span className="text-xs text-[hsl(0_0%_65%)] hidden sm:inline whitespace-nowrap">· {callParticipants.length} on the line</span>

        <div className="ml-auto flex items-center gap-3 shrink-0">
          <div className="hidden md:flex items-center gap-1.5 text-xs">
            <Signal className={`w-3.5 h-3.5 ${lk.status === "connected" ? "text-vs-green" : lkConnecting ? "text-vs-amber" : "text-vs-green"}`} />
            <span className={`font-mono whitespace-nowrap ${lk.status === "connected" ? "text-vs-green" : lkConnecting ? "text-vs-amber" : "text-vs-green"}`}>
              {lkConnecting ? "Connecting…" : lkFailed ? "Failed" : "Stable · 42ms"}
            </span>
          </div>
          <span className="w-px h-5 bg-[hsl(232_40%_22%)] hidden md:inline-block" />
          <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-[hsl(2_70%_55%/0.15)] border border-[hsl(2_70%_55%/0.35)] whitespace-nowrap" data-testid="indicator-live">
            <span className="w-2 h-2 rounded-full bg-vs-red live-blink" />
            <span className="text-[11px] font-mono font-bold text-[hsl(2_85%_72%)] tracking-wider">LIVE</span>
            <span className="text-[11px] font-mono text-white">{formatDuration(elapsed)}</span>
          </div>
          {activeRec && (
            <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-vs-red text-white whitespace-nowrap shadow-md" data-testid="indicator-recording">
              <Circle className="w-2 h-2 fill-white live-blink" />
              <span className="text-[11px] font-mono font-bold tracking-wider">REC</span>
            </div>
          )}
          {canRecord && (
            activeRec ? (
              <button type="button" onClick={() => stopRec.mutate()} disabled={stopRec.isPending} className="px-2 py-1 rounded-md text-xs bg-vs-red/20 border border-vs-red/40 text-[hsl(2_85%_72%)] hover:bg-vs-red/30 flex items-center gap-1.5 whitespace-nowrap" title="Stop recording" data-testid="button-stop-recording">
                <Square className="w-3 h-3 fill-current" /> Stop
              </button>
            ) : (
              <button type="button" onClick={() => startRec.mutate()} disabled={startRec.isPending} className="px-2 py-1 rounded-md text-xs bg-[hsl(232_50%_18%)] border border-[hsl(232_40%_25%)] hover:border-vs-red hover:text-vs-red text-[hsl(0_0%_80%)] flex items-center gap-1.5 whitespace-nowrap" title="Start recording (admin/foreman)" data-testid="button-start-recording">
                <Circle className="w-3 h-3" /> Record
              </button>
            )
          )}
          <button type="button" onClick={() => setShowPast((v) => !v)} className="px-2 py-1 rounded-md text-xs bg-[hsl(232_50%_18%)] border border-[hsl(232_40%_25%)] hover:border-vs-blue hover:text-vs-blue-light text-[hsl(0_0%_80%)] flex items-center gap-1.5 whitespace-nowrap" title="Past recordings" data-testid="button-past-recordings">
            <History className="w-3 h-3" /> Past
          </button>
        </div>
      </header>

      {/* Preview banner */}
      {previewMode && (
        <div className="px-4 py-2 bg-[hsl(218_100%_68%/0.12)] border-b border-[hsl(218_100%_68%/0.3)] flex items-center gap-2 text-xs" data-testid="banner-demo-mode">
          <Sparkles className="w-3.5 h-3.5 text-vs-blue shrink-0" />
          <div className="text-[hsl(0_0%_85%)]">
            <span className="text-vs-blue-light font-semibold">Demo mode · </span>
            {previewMessage ?? "Add LiveKit credentials to enable real calls."}
          </div>
        </div>
      )}
      {lkConnecting && !previewMode && (
        <div className="px-4 py-2 bg-[hsl(40_90%_55%/0.1)] border-b border-[hsl(40_90%_55%/0.3)] flex items-center gap-2 text-xs" data-testid="banner-lk-connecting">
          <Loader2 className="w-3.5 h-3.5 text-vs-amber animate-spin" />
          <span className="text-[hsl(40_85%_75%)]">Connecting to call…</span>
        </div>
      )}
      {(error || lk.error) && !previewMode && (
        <div className="px-4 py-2 bg-[hsl(2_70%_55%/0.12)] border-b border-[hsl(2_70%_55%/0.4)] flex items-center gap-2 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 text-vs-red" />
          <span className="text-[hsl(2_85%_75%)]">{error ?? lk.error}</span>
        </div>
      )}
      {dialAbsentToast && (
        <div
          className="px-4 py-2 bg-[hsl(218_100%_68%/0.12)] border-b border-[hsl(218_100%_68%/0.35)] flex items-center gap-2 text-xs"
          data-testid="banner-dial-absent"
        >
          <Phone className="w-3.5 h-3.5 text-vs-blue-light" />
          <span className="text-[hsl(218_100%_82%)]">{dialAbsentToast}</span>
        </div>
      )}

      {/* Privacy: mic-on indicator. Always visible whenever the local mic is
          publishing audio so you cannot accidentally forget you're hot. */}
      {lk.micPublished && (
        <div
          className="px-4 py-2 bg-gradient-to-r from-vs-red/30 via-vs-red/20 to-vs-red/10 border-b-2 border-vs-red flex items-center justify-center gap-3 text-xs shadow-[0_2px_12px_-2px_rgba(220,38,38,0.5)]"
          data-testid="banner-mic-on"
        >
          <span className="relative flex w-2.5 h-2.5">
            <span className="absolute inset-0 rounded-full bg-vs-red opacity-75 animate-ping" />
            <span className="relative inline-flex w-2.5 h-2.5 rounded-full bg-vs-red" />
          </span>
          <Mic className="w-4 h-4 text-white" />
          <span className="font-mono font-bold tracking-wider text-white uppercase text-[11px]">Mic On — You can be heard</span>
          <button
            type="button"
            onClick={() => {
              void lk.toggleMic().then((nowMuted) => {
                if (nowMuted !== myMicMuted) onToggleMic();
              });
            }}
            className="ml-2 px-2 py-0.5 rounded bg-white/15 hover:bg-white/25 text-white font-mono text-[10px] uppercase tracking-wider transition-colors"
            data-testid="button-quick-mute"
          >
            Mute
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 p-6 overflow-y-auto pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:pb-6">
          <div className={[
            "grid gap-4 max-w-5xl mx-auto",
            callParticipants.length <= 2 ? "grid-cols-1 sm:grid-cols-2"
              : callParticipants.length <= 4 ? "grid-cols-2"
              : "grid-cols-2 lg:grid-cols-3",
          ].join(" ")}>
            {callParticipants.map((m) => {
              const isMe = m.id === me.id;
              // In real mode use LiveKit's view of mic/video/speaking;
              // in demo mode fall back to local toggle + deterministic mock.
              const muted = m.live
                ? m.live.micMuted
                : (isMe ? myMicMuted : false);
              const hasVideo = m.live
                ? !!m.live.videoTrack
                : (isMe ? myVideoOn : previewVideoIds.includes(m.id));
              const speaking = m.live
                ? (m.live.isSpeaking && !m.live.micMuted)
                : (speakingId === m.id && !muted);
              // Hand-raise: real participants come from LiveKit attribute;
              // for the local user in preview mode we fall back to the UI flag.
              const handUp = m.live
                ? m.live.handRaised
                : (isMe ? myHandRaised : false);
              return (
                <ParticipantTile
                  key={m.id || m.live?.identity}
                  member={m}
                  isMe={isMe}
                  muted={muted}
                  hasVideo={hasVideo}
                  speaking={speaking}
                  isHandRaised={handUp}
                />
              );
            })}
          </div>

          {/* Hidden audio sinks: LiveKit doesn't auto-play remote audio,
              so we mount one <audio> per remote participant and attach
              their mic publication. Autoplay-with-sound is allowed once
              the user has clicked Join, which is how they got here. */}
          <RemoteAudioMixer participants={callParticipants} myId={me.id} />

          {/* Screen-share preview region. In real mode the largest video
              attaches to the screenTrack; in demo mode we keep the
              existing notice line. */}
          {realScreenSharer ? (
            // Bound the screen-share preview to ~45vh so it can't push the
            // bottom call-controls bar off-screen on phones. On larger
            // screens we cap it at 480px. Without this, an aspect-video
            // 16:9 surface filling 100% width of a phone (~720px tall on
            // a 9:19.5 viewport) eats the entire vertical budget and the
            // mic/cam/leave row disappears below the fold.
            <div className="max-w-5xl mx-auto mt-4 rounded-lg overflow-hidden border border-[hsl(218_100%_68%/0.4)] bg-black">
              <div className="px-4 py-2 bg-[hsl(218_100%_68%/0.1)] border-b border-[hsl(218_100%_68%/0.3)] flex items-center gap-3 text-sm">
                <MonitorUp className="w-4 h-4 text-vs-blue" />
                <span className="font-semibold text-vs-blue-light">
                  {realScreenSharer.id === me.id ? "You are " : `${realScreenSharer.name} is `}
                </span>
                <span className="text-white">sharing screen</span>
                <span className="ml-auto text-[hsl(0_0%_65%)] text-xs">{channel.topic ?? "Live"}</span>
              </div>
              <ScreenShareVideo track={realScreenSharer.live?.screenTrack ?? null} />
            </div>
          ) : (myScreenSharing || screenSharerId) && (
            <div className="max-w-5xl mx-auto mt-4 px-4 py-3 rounded-lg bg-[hsl(218_100%_68%/0.1)] border border-[hsl(218_100%_68%/0.3)] flex items-center gap-3">
              <MonitorUp className="w-5 h-5 text-vs-blue" />
              <div className="text-sm text-white">
                <span className="font-semibold text-vs-blue-light">
                  {myScreenSharing ? "You are " : `${callParticipants.find(p => p.id === screenSharerId)?.name ?? "Someone"} is `}
                </span>
                sharing screen — <span className="text-[hsl(0_0%_75%)]">{channel.topic ?? "Field briefing"}</span>
              </div>
            </div>
          )}

          {showPast && (
            <PastRecordingsPanel recordings={recordingsQ.data ?? []} />
          )}
          {startRec.isError && (
            <div className="max-w-5xl mx-auto mt-4 px-4 py-2 rounded-md bg-vs-red/10 border border-vs-red/30 text-xs text-[hsl(2_85%_75%)]" data-testid="banner-recording-error">
              Recording failed to start. Ensure LiveKit credentials and S3 storage are configured.
            </div>
          )}
          {livekitInfo && lk.status === "connected" && (
            <div className="max-w-5xl mx-auto mt-4 px-4 py-2 rounded-md bg-[hsl(145_60%_48%/0.1)] border border-[hsl(145_60%_48%/0.3)] text-xs font-mono text-vs-green flex items-center gap-2" data-testid="banner-livekit-connected">
              <Signal className="w-3.5 h-3.5" />
              LiveKit room <span className="text-white">{livekitInfo.roomName}</span> · {lk.participants.length} live · {lk.micPublished ? "mic on" : "mic off"}
              {lk.cameraPublished && " · cam on"}
              {lk.screenPublished && " · screen on"}
            </div>
          )}
        </div>

        <CallSidebar fullCallList={callParticipants} screenSharerId={screenSharerId ?? null} previewMode={!!previewMode} />
      </div>

      {/* Bottom control bar */}
      {/* Mic/Cam/Screen buttons are gated on the LiveKit room being in the
          "connected" state. iOS Safari needs the gesture-driven publish to
          fire AFTER the room is connected; before that the reconcile
          effects skip the call and the toggle silently does nothing. We
          surface the wait state on the buttons + an inline strip so the
          user can see what's happening. */}
      {!!livekitInfo && lk.status !== "connected" && (
        <div className="shrink-0 px-4 py-1.5 bg-[hsl(232_55%_14%)] border-t border-[hsl(232_40%_22%)] flex items-center justify-center gap-2 text-[11px] font-mono" data-testid="banner-call-waiting">
          {lk.status === "connecting" || lk.status === "reconnecting" ? (
            <><Loader2 className="w-3 h-3 animate-spin text-vs-amber" /><span className="text-vs-amber uppercase tracking-wider">{lk.status === "reconnecting" ? "Reconnecting" : "Connecting to call"}…</span><span className="text-[hsl(0_0%_55%)]">mic & video unlock when ready</span></>
          ) : lk.status === "failed" ? (
            <><AlertTriangle className="w-3 h-3 text-[hsl(2_85%_72%)]" /><span className="text-[hsl(2_85%_72%)] uppercase tracking-wider">Call failed</span><span className="text-[hsl(0_0%_55%)]">{lk.error ?? "Tap Leave and rejoin"}</span></>
          ) : (
            <><Loader2 className="w-3 h-3 animate-spin text-[hsl(0_0%_55%)]" /><span className="text-[hsl(0_0%_55%)] uppercase tracking-wider">Waiting for media…</span></>
          )}
        </div>
      )}
      {/* Bottom control bar.
          iPhone PWA: we use `sticky bottom-0` so the bar is glued to the
          viewport bottom regardless of how flex sizing in the parent
          chain resolves. Even if a sibling overflows the section, this
          bar still paints in view. `z-30` keeps it above the participant
          grid / screen-share preview. We also explicitly pad the bottom
          by env(safe-area-inset-bottom) so the home indicator on iPhones
          doesn't sit on top of the buttons.

          iPhone width budget (~360px usable): with full padding + gap +
          7 h-11 buttons + an Invite pill, the row was ~550px wide, which
          forced iOS to scale the page out. We tighten padding/gap on
          mobile and hide disabled placeholder buttons (More / Settings)
          so the essentials fit at native scale. */}
      <div className="fixed sm:sticky left-0 right-0 bottom-0 z-40 shrink-0 px-2 sm:px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)] flex items-center justify-center gap-1 sm:gap-2 flex-wrap" data-testid="bar-call-controls">
        <CallButton
          on={!myMicMuted}
          // iOS Safari mic gesture path: same pattern as camera. The
          // hook's toggleMic() does getUserMedia synchronously inside
          // this click handler when running on iOS.
          onClick={() => {
            void lk.toggleMic().then((nowMuted) => {
              if (nowMuted !== myMicMuted) onToggleMic();
            });
          }}
          title={myMicMuted ? "Unmute" : "Mute"}
          activeIcon={<Mic className="w-5 h-5" />} inactiveIcon={<MicOff className="w-5 h-5" />} testid="button-call-mic" />
        <CallButton
          on={myVideoOn}
          // iOS Safari: invoke lk.toggleCamera() SYNCHRONOUSLY inside the
          // user-gesture click. It performs getUserMedia inside the gesture
          // window (which iOS requires), then we mirror the resulting
          // desired state back into the parent. Non-iOS browsers fall
          // through to the declarative reconciliation effect.
          onClick={() => {
            // Fire-and-forget: lk.toggleCamera() returns a promise but the
            // critical getUserMedia call inside it is synchronous from this
            // click handler's perspective.
            void lk.toggleCamera().then((nowOn) => {
              if (nowOn !== myVideoOn) onToggleVideo();
            });
          }}
          title={myVideoOn ? "Stop video" : "Start video"}
          activeIcon={<Video className="w-5 h-5" />} inactiveIcon={<VideoOff className="w-5 h-5" />} testid="button-call-video" />
        {/* Screen-share button. iOS Safari/PWA WebView does NOT support
            getDisplayMedia at all — hide instead of letting users tap a
            button that throws "getDisplayMedia not supported". */}
        {lk.screenShareSupported && (
          <CallButton on={myScreenSharing} onClick={onToggleScreen} title={myScreenSharing ? "Stop sharing" : "Share screen"}
            activeIcon={<MonitorUp className="w-5 h-5" />} inactiveIcon={<ScreenShareOff className="w-5 h-5" />} testid="button-call-screen" />
        )}
        <CallButton on={myHandRaised}
          onClick={() => {
            // Sync to LiveKit so other participants see the hand. We also
            // flip the parent flag so the local UI stays consistent even
            // before the attribute echoes back from the server.
            const next = !myHandRaised;
            lk.setHandRaised(next);
            onToggleHand();
          }}
          title={myHandRaised ? "Lower hand" : "Raise hand"}
          activeIcon={<Hand className="w-5 h-5" />} inactiveIcon={<Hand className="w-5 h-5" />} testid="button-call-hand" />
        <button
          type="button"
          onClick={() => setShowInvite(true)}
          title="Invite to call"
          data-testid="button-call-invite"
          className="h-11 px-2 sm:px-3 rounded-full bg-[hsl(232_50%_18%)] hover:bg-[hsl(232_50%_24%)] text-white flex items-center gap-1.5 transition-colors"
        >
          <UserPlus className="w-4 h-4" />
          <span className="text-xs font-semibold hidden sm:inline">Invite</span>
        </button>
        {/* Disabled placeholder buttons (More, Settings) live on desktop only.
            They were eating the iPhone width budget and forcing the page to
            scale down. */}
        <CallButton on={false} neutral disabled title="More — coming soon" activeIcon={<MoreHorizontal className="w-5 h-5" />} inactiveIcon={<MoreHorizontal className="w-5 h-5" />} testid="button-call-more" className="hidden sm:flex" />
        <CallButton on={false} neutral disabled title="Settings — coming soon" activeIcon={<Settings className="w-5 h-5" />} inactiveIcon={<Settings className="w-5 h-5" />} testid="button-call-settings" className="hidden sm:flex" />
        <div className="hidden sm:block w-3" />
        <button
          type="button"
          onClick={() => {
            // Hard-leave: clear LiveKit info first so the hook's cleanup
            // effect tears down the room (stops mic/cam, releases iOS audio
            // session), then reset the local control flags so the next time
            // we join we start from a clean state, then let the parent route
            // us back to the default channel.
            setLivekitInfo(null);
            // If we were holding the hand up, drop it before we go so it
            // doesn't carry over to the next room.
            if (myHandRaised) onToggleHand();
            if (!myMicMuted) onToggleMic();
            if (myVideoOn) onToggleVideo();
            if (myScreenSharing) onToggleScreen();
            onLeave();
          }}
          title="Leave call"
          data-testid="button-call-leave"
          className="h-11 px-5 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center gap-2 transition-colors shadow-lg shadow-red-900/30"
        >
          <PhoneOff className="w-4 h-4" />
          <span className="text-sm font-semibold">Leave</span>
        </button>
      </div>

      {showInvite && (
        <InviteModal
          channelId={channel.id}
          channelName={channel.name}
          me={me}
          orgMembers={orgMembers}
          inCallIds={callParticipants.map(p => p.id).filter(Boolean)}
          onClose={() => setShowInvite(false)}
        />
      )}
    </section>
  );
}

/**
 * Invite modal — shows org members with online/offline status; for online
 * members it sends a PWA push "ringing" notification, for offline members
 * with a phone number it triggers a Twilio SIP dial-out that bridges them
 * into the LiveKit room.
 */
function InviteModal({
  channelId, channelName, me, orgMembers, inCallIds, onClose,
}: {
  channelId: number;
  channelName: string;
  me: ApiUser;
  orgMembers: ApiUser[];
  inCallIds: number[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>([]);
  const [phoneInput, setPhoneInput] = useState("");

  // Filter out the current user and people already in the call. We do
  // NOT filter by online status here so admins can phone-bridge offline
  // members in the same picker.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orgMembers
      .filter(u => u.id !== me.id && !inCallIds.includes(u.id))
      .filter(u => !q || u.name.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q))
      .sort((a, b) => {
        // Online users first so the most likely invites surface at top.
        const ao = (a.status === "online" ? 0 : 1);
        const bo = (b.status === "online" ? 0 : 1);
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      });
  }, [orgMembers, me.id, inCallIds, query]);

  const inviteMutation = useMutation({
    mutationFn: async () => apiRequest<{ invited: number; dialed: number; warnings?: string[] }>(
      "POST",
      `/api/channels/${channelId}/invite`,
      {
        userIds: Array.from(picked),
        phoneNumbers: phoneNumbers,
      },
    ),
    onSuccess: (res) => {
      // Briefly show the count then close. We could surface warnings
      // but for a field-crew app a green check is enough; admins can
      // check the server log if a dial-out fails.
      onClose();
    },
  });

  function togglePick(id: number) {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addPhone() {
    const raw = phoneInput.trim();
    if (!raw) return;
    // Normalize: keep + and digits only. Twilio rejects formatted numbers.
    const cleaned = raw.startsWith("+") ? "+" + raw.slice(1).replace(/\D/g, "") : "+1" + raw.replace(/\D/g, "");
    if (cleaned.length < 9) return;
    if (phoneNumbers.includes(cleaned)) { setPhoneInput(""); return; }
    setPhoneNumbers(prev => [...prev, cleaned]);
    setPhoneInput("");
  }

  const totalSelected = picked.size + phoneNumbers.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="modal-invite-overlay"
    >
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col bg-[hsl(232_55%_13%)] border border-[hsl(232_40%_22%)] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="modal-invite"
      >
        <div className="px-5 py-4 border-b border-[hsl(232_40%_22%)] flex items-center justify-between">
          <div>
            <div className="text-base font-display text-white">Invite to {channelName}</div>
            <div className="text-[11px] font-mono uppercase tracking-wider text-[hsl(0_0%_55%)]">Push to online users · Phone-bridge for offline</div>
          </div>
          <button type="button" onClick={onClose} className="w-8 h-8 rounded-md hover:bg-[hsl(232_45%_22%)] flex items-center justify-center text-[hsl(0_0%_70%)]" title="Close" data-testid="button-invite-close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)]">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(0_0%_55%)]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              className="w-full h-9 pl-8 pr-3 rounded-md bg-[hsl(232_50%_18%)] border border-[hsl(232_40%_25%)] text-white text-sm placeholder:text-[hsl(0_0%_45%)] focus:outline-none focus:border-vs-blue"
              data-testid="input-invite-search"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {candidates.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-[hsl(0_0%_55%)]" data-testid="text-invite-empty">
              No one to invite— everyone is already on the line.
            </div>
          ) : (
            candidates.map(u => {
              const online = u.status === "online";
              const checked = picked.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => togglePick(u.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left hover:bg-[hsl(232_45%_18%)] ${checked ? "bg-[hsl(218_100%_68%/0.12)] ring-1 ring-[hsl(218_100%_68%/0.4)]" : ""}`}
                  data-testid={`button-invite-pick-${u.id}`}
                >
                  <Avatar member={u} size={28} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white truncate flex items-center gap-2">
                      {u.name}
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${online ? "bg-vs-green" : "bg-[hsl(0_0%_40%)]"}`} />
                    </div>
                    <div className="text-[11px] text-[hsl(0_0%_60%)] truncate flex items-center gap-2">
                      {online ? <span className="text-vs-green">Online · will receive push</span> : (
                        // PublicUser from the chat API doesn't include phone
                        // — the server resolves the phone from auth at
                        // invite time. Show a hint instead of the number.
                        <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> Offline · phone-bridge if available</span>
                      )}
                    </div>
                  </div>
                  <span className={`w-5 h-5 rounded border flex items-center justify-center ${checked ? "bg-vs-blue border-vs-blue" : "border-[hsl(232_40%_30%)]"}`}>
                    {checked && <span className="text-[10px] text-white font-bold">✓</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="px-5 py-3 border-t border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)]">
          <div className="text-[11px] font-mono uppercase tracking-wider text-[hsl(0_0%_55%)] mb-1.5">Or dial a phone number</div>
          <div className="flex items-center gap-2">
            <input
              type="tel"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPhone(); } }}
              placeholder="+1 555 123 4567"
              className="flex-1 h-9 px-3 rounded-md bg-[hsl(232_50%_18%)] border border-[hsl(232_40%_25%)] text-white text-sm placeholder:text-[hsl(0_0%_45%)] focus:outline-none focus:border-vs-blue"
              data-testid="input-invite-phone"
            />
            <button type="button" onClick={addPhone} className="h-9 px-3 rounded-md bg-[hsl(232_50%_18%)] hover:bg-[hsl(232_50%_24%)] text-white text-xs font-semibold" data-testid="button-invite-phone-add">
              Add
            </button>
          </div>
          {phoneNumbers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {phoneNumbers.map(p => (
                <span key={p} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[hsl(218_100%_68%/0.15)] border border-[hsl(218_100%_68%/0.35)] text-vs-blue-light text-[11px] font-mono">
                  {p}
                  <button type="button" onClick={() => setPhoneNumbers(prev => prev.filter(x => x !== p))} className="hover:text-white" title="Remove">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[hsl(232_40%_22%)] flex items-center justify-between bg-[hsl(232_55%_13%)]">
          <div className="text-xs text-[hsl(0_0%_70%)]">
            {totalSelected === 0 ? "Nothing selected" : `${totalSelected} to invite`}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="h-9 px-4 rounded-md bg-[hsl(232_45%_18%)] hover:bg-[hsl(232_45%_24%)] text-white text-sm" data-testid="button-invite-cancel">Cancel</button>
            <button
              type="button"
              onClick={() => inviteMutation.mutate()}
              disabled={totalSelected === 0 || inviteMutation.isPending}
              className="h-9 px-4 rounded-md bg-vs-blue hover:bg-vs-blue-light disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold flex items-center gap-1.5"
              data-testid="button-invite-send"
            >
              {inviteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              Send invites
            </button>
          </div>
        </div>
        {inviteMutation.isError && (
          <div className="px-5 pb-3 text-[11px] text-[hsl(2_85%_72%)]" data-testid="text-invite-error">
            Invite failed — check server logs or try again.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Mounts a <video> element bound to a LiveKit camera track. We use a
 * ref + effect rather than a JSX prop so React can manage attach/detach
 * lifecycle exactly once per track change. If `track` is null we render
 * a placeholder gradient (the parent tile already provides one).
 */
function LiveVideo({ track, mirror }: { track: Track | null; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    return attachTrack(track, ref.current);
  }, [track]);
  if (!track) return null;
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted // remote audio handled by RemoteAudioMixer; mute video element to avoid duplicate output
      className="absolute inset-0 w-full h-full object-cover"
      style={{ transform: mirror ? "scaleX(-1)" : undefined }}
    />
  );
}

/** Full-width screen-share video sized to fit the preview region.
 *  Hard cap at 45vh on mobile so the bottom call-controls bar stays
 *  on-screen even when a presenter is sharing.
 */
function ScreenShareVideo({ track }: { track: Track | null }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    return attachTrack(track, ref.current);
  }, [track]);
  if (!track) {
    return <div className="w-full max-h-[45vh] sm:max-h-[480px] aspect-video bg-[hsl(232_55%_11%)] flex items-center justify-center text-xs text-[hsl(0_0%_55%)]">Waiting for screen…</div>;
  }
  return <video ref={ref} autoPlay playsInline muted className="w-full max-h-[45vh] sm:max-h-[480px] object-contain bg-black" />;
}

/**
 * One hidden <audio> per remote participant so their mic track plays
 * through speakers. We exclude the local participant — playing your
 * own mic back would create feedback. Browsers permit autoplay-with-
 * sound after a user gesture; clicking Join counts as one.
 */
function RemoteAudioMixer({ participants, myId }: { participants: CallParticipant[]; myId: number }) {
  return (
    <div aria-hidden className="sr-only">
      {participants
        .filter(p => p.live && !p.live.isLocal && p.id !== myId)
        .map(p => (
          <RemoteAudioSink key={p.live!.identity} participant={p.live!} />
        ))}
    </div>
  );
}

function RemoteAudioSink({ participant }: { participant: RoomParticipantState }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  // Re-attach whenever the publisher swaps tracks (republish on unmute,
  // network reconnect, etc.). The hook re-renders the snapshot on
  // TrackSubscribed/Unsubscribed so `audioTrack` always reflects the
  // currently subscribed RemoteAudioTrack.
  useEffect(() => {
    if (!ref.current) return;
    return attachTrack(participant.audioTrack, ref.current);
  }, [participant.audioTrack]);
  return <audio ref={ref} autoPlay data-identity={participant.identity} />;
}

function ParticipantTile({
  member, isMe, muted, hasVideo, speaking, isHandRaised,
}: {
  member: CallParticipant;
  isMe: boolean;
  muted: boolean;
  hasVideo: boolean;
  speaking: boolean;
  isHandRaised: boolean;
}) {
  const liveVideoTrack = member.live?.videoTrack ?? null;
  return (
    <motion.div
      layout
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className={[
        "relative aspect-video rounded-xl overflow-hidden border-2 transition-colors",
        speaking ? "border-vs-blue shadow-lg" : "border-[hsl(232_40%_25%)]",
      ].join(" ")}
      style={{
        background: hasVideo && !liveVideoTrack
          ? `linear-gradient(135deg, hsl(${member.hue} 60% 22%) 0%, hsl(${(member.hue + 40) % 360} 50% 12%) 100%)`
          : "hsl(232 55% 11%)",
      }}
      data-testid={`tile-${member.id}`}
    >
      {/* Real camera track (real mode) */}
      {liveVideoTrack && (
        <LiveVideo track={liveVideoTrack} mirror={isMe} />
      )}
      {/* Demo "video" placeholder when no real track */}
      {hasVideo && !liveVideoTrack && (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg viewBox="0 0 200 100" className="absolute inset-0 w-full h-full">
            <defs>
              <radialGradient id={`vl-${member.id}`} cx="50%" cy="35%" r="50%">
                <stop offset="0%" stopColor={`hsl(${member.hue} 80% 70%)`} stopOpacity="0.5" />
                <stop offset="100%" stopColor={`hsl(${member.hue} 70% 30%)`} stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect width="200" height="100" fill={`url(#vl-${member.id})`} />
          </svg>
          <div
            className="relative w-24 h-24 rounded-full flex items-center justify-center font-display text-3xl"
            style={{
              background: `linear-gradient(135deg, hsl(${member.hue} 80% 65%), hsl(${(member.hue + 25) % 360} 70% 35%))`,
              color: "hsl(232 60% 9%)",
              boxShadow: "0 8px 30px hsl(0 0% 0% / 0.4)",
            }}
          >
            {member.name.split(/\s+/).slice(0, 2).map(s => s[0] ?? "").join("").toUpperCase()}
          </div>
        </div>
      )}
      {/* No-video fallback (avatar) */}
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={speaking ? "speaking-ring rounded-full" : ""}>
            <Avatar member={{ name: member.name, hue: member.hue }} size={88} ring={speaking ? "blue" : "none"} />
          </div>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/80 to-transparent flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-white truncate">
            {member.name}{isMe && <span className="text-vs-red"> (you)</span>}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isHandRaised && (
            <span className="w-6 h-6 rounded-full bg-[hsl(35_100%_60%)] flex items-center justify-center" title="Hand raised">
              <Hand className="w-3.5 h-3.5 text-[hsl(232_60%_9%)]" />
            </span>
          )}
          <span
            className={[
              "w-6 h-6 rounded-full flex items-center justify-center",
              muted ? "bg-vs-red text-white"
                : speaking ? "bg-vs-blue text-[hsl(232_60%_9%)]"
                : "bg-[hsl(232_45%_27%)] text-[hsl(0_0%_85%)]",
            ].join(" ")}
            title={muted ? "Muted" : speaking ? "Speaking" : "Live mic"}
          >
            {muted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          </span>
        </div>
      </div>

      <div className="absolute top-2 left-2">
        <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-sm backdrop-blur-sm bg-[hsl(232_60%_9%/0.7)] text-white">
          {ROLE_LABEL[member.role]}
        </span>
      </div>
    </motion.div>
  );
}

function CallButton({
  on, onClick, title, activeIcon, inactiveIcon, neutral, testid, disabled, className,
}: {
  on: boolean;
  onClick?: () => void;
  title: string;
  activeIcon: React.ReactNode;
  inactiveIcon: React.ReactNode;
  neutral?: boolean;
  testid?: string;
  disabled?: boolean;
  /** Extra utility classes (e.g. `hidden sm:flex` to hide on mobile). */
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // If the title already explains the disabled reason (e.g. "— coming soon"),
      // use it as-is; otherwise default to the call-connect hint.
      title={disabled && !/(coming soon|—)/i.test(title) ? `${title} (waiting for call to connect)` : title}
      data-testid={testid}
      disabled={disabled}
      aria-disabled={disabled}
      className={[
        "w-11 h-11 rounded-full flex items-center justify-center transition-all",
        disabled
          ? "bg-[hsl(232_45%_18%)] text-[hsl(0_0%_45%)] cursor-not-allowed opacity-60"
          : neutral
            ? "bg-[hsl(232_45%_27%)] hover:bg-[hsl(232_45%_32%)] text-[hsl(0_0%_85%)]"
            : on
              ? "bg-[hsl(232_45%_27%)] hover:bg-[hsl(232_45%_32%)] text-white"
              : "bg-[hsl(2_70%_55%/0.2)] hover:bg-[hsl(2_70%_55%/0.3)] text-[hsl(2_85%_72%)] ring-1 ring-[hsl(2_70%_55%/0.4)]",
        className ?? "",
      ].join(" ")}
    >
      {on || neutral ? activeIcon : inactiveIcon}
    </button>
  );
}

function CallSidebar({
  fullCallList, screenSharerId, previewMode,
}: { fullCallList: CallParticipant[]; screenSharerId: number | null; previewMode: boolean }) {
  return (
    <aside className="w-[260px] shrink-0 vs-navy border-l border-black/40 hidden lg:flex flex-col" data-testid="sidebar-call">
      <div className="px-4 py-3 border-b border-black/30">
        <div className="text-[10px] uppercase tracking-[0.16em] text-vs-red font-bold">On Call</div>
        <div className="text-sm text-white mt-0.5 flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5" /> {fullCallList.length} participants
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        {screenSharerId && (
          <div className="px-2 py-1.5 mb-2 rounded-md bg-[hsl(218_100%_68%/0.1)] border border-[hsl(218_100%_68%/0.3)]">
            <div className="text-[9px] uppercase tracking-wider text-vs-blue-light font-bold">Sharing screen</div>
            <div className="text-xs text-white mt-0.5">{fullCallList.find(m => m.id === screenSharerId)?.name}</div>
          </div>
        )}
        {fullCallList.map((m) => (
          <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[hsl(232_45%_27%)] transition-colors">
            <Avatar member={{ name: m.name, hue: m.hue }} size={28} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-white truncate">{m.name}</div>
              <div className="text-[10px] text-[hsl(0_0%_60%)] truncate font-mono">{m.title || ROLE_LABEL[m.role]}</div>
            </div>
            <Mic className={`w-3 h-3 shrink-0 ${m.live?.micMuted === false ? "text-vs-green" : m.live ? "text-[hsl(0_0%_45%)]" : "text-vs-green"}`} />
          </div>
        ))}
      </div>

      <div className="px-3 py-3 border-t border-black/30 text-[10px] text-[hsl(0_0%_55%)] space-y-1 font-mono">
        <div className="flex justify-between"><span>Codec</span><span className="text-vs-green">Opus 48k</span></div>
        <div className="flex justify-between"><span>Bitrate</span><span className="text-white">96 kbps</span></div>
        <div className="flex justify-between"><span>Backend</span><span className={previewMode ? "text-vs-amber" : "text-vs-green"}>{previewMode ? "Demo" : "LiveKit"}</span></div>
        <div className="flex justify-between"><span>Encryption</span><span className="text-vs-red">E2EE · DTLS-SRTP</span></div>
      </div>
    </aside>
  );
}

function fmtBytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDur(secs: number | null): string {
  if (!secs) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function PastRecordingsPanel({ recordings }: { recordings: ApiRecording[] }) {
  const completed = recordings.filter(r => r.status === "completed" || r.status === "finalizing" || r.status === "failed").sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return (
    <div className="max-w-5xl mx-auto mt-4 rounded-lg bg-[hsl(232_50%_14%)] border border-[hsl(232_40%_22%)] overflow-hidden" data-testid="panel-past-recordings">
      <div className="px-4 py-2 border-b border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)] flex items-center gap-2">
        <History className="w-4 h-4 text-vs-blue-light" />
        <div className="text-sm font-display text-white">Past Recordings</div>
        <span className="text-[11px] text-[hsl(0_0%_55%)] font-mono ml-auto">{completed.length} files</span>
      </div>
      {completed.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-[hsl(0_0%_55%)]">No past recordings for this channel yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)]">
            <tr>
              <th className="text-left px-4 py-2">Started</th>
              <th className="text-left px-4 py-2">Duration</th>
              <th className="text-left px-4 py-2">Size</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {completed.map(r => (
              <tr key={r.id} className="border-t border-[hsl(232_40%_22%)]" data-testid={`recording-row-${r.id}`}>
                <td className="px-4 py-2 text-white text-xs font-mono">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="px-4 py-2 text-[hsl(0_0%_75%)] font-mono text-xs">{fmtDur(r.durationSeconds)}</td>
                <td className="px-4 py-2 text-[hsl(0_0%_75%)] font-mono text-xs">{fmtBytes(r.sizeBytes)}</td>
                <td className="px-4 py-2">
                  <span className={`text-[10px] uppercase font-mono px-2 py-0.5 rounded border ${r.status === "completed" ? "bg-vs-green/15 text-vs-green border-vs-green/30" : r.status === "failed" ? "bg-vs-red/15 text-[hsl(2_85%_72%)] border-vs-red/30" : "bg-vs-blue/15 text-vs-blue-light border-vs-blue/30"}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-vs-blue-light hover:text-white" data-testid={`btn-play-recording-${r.id}`}>
                      <Play className="w-3 h-3" /> Play
                    </a>
                  ) : (
                    <span className="text-xs text-[hsl(0_0%_45%)]">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
