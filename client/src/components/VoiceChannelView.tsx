import { useEffect, useRef, useState } from "react";
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, Hand, Settings, PhoneOff,
  Volume2, MoreHorizontal, ScreenShareOff, Signal, Users, Loader2, AlertTriangle, Sparkles,
  Circle, Square, Play, History,
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
  const lk = useLiveKitRoom({
    token: livekitInfo?.token ?? null,
    wsUrl: livekitInfo?.wsUrl ?? null,
    roomKey: livekitInfo ? String(channel.id) : null,
    micMuted: myMicMuted,
    videoOn: myVideoOn,
    screenSharing: myScreenSharing,
    onTrackError: (kind, err) => {
      // Surface device errors in the existing error banner so the user
      // knows why their mic/camera/screen toggle didn't take effect.
      const msg = err instanceof Error ? err.message : String(err);
      setError(`${kind === "mic" ? "Microphone" : kind === "camera" ? "Camera" : "Screen share"} error: ${msg}`);
    },
  });

  // Build the display participant list. Real mode = derive from LiveKit
  // participants and enrich with org-member metadata. Demo mode = a
  // deterministic subset of org members for the stage so users still
  // see a populated UI when LK isn't configured.
  const callParticipants: CallParticipant[] = (() => {
    if (livekitInfo && lk.participants.length > 0) {
      // Real mode: LiveKit is the source of truth for who's in the call.
      return lk.participants.map((p): CallParticipant => {
        const member = orgMembers.find(u => u.id === p.userId);
        return {
          id: p.userId || (p.isLocal ? me.id : 0),
          name: member?.name ?? p.name,
          hue: member?.hue ?? 210,
          role: member?.role ?? "field",
          title: member?.title ?? null,
          live: p,
        };
      });
    }
    // Demo mode: pick a deterministic subset of org members for the stage.
    const others = orgMembers.filter(u => u.id !== me.id).slice(0, 4);
    return [
      { id: me.id, name: me.name, hue: me.hue, role: me.role, title: me.title, live: null },
      ...others.map(u => ({ id: u.id, name: u.name, hue: u.hue, role: u.role, title: u.title, live: null })),
    ];
  })();

  // Live timer
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [channel.id]);

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
    <section className="flex-1 flex flex-col min-w-0 bg-[hsl(232_65%_8%)] relative">
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

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 p-6 overflow-y-auto">
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
              return (
                <ParticipantTile
                  key={m.id || m.live?.identity}
                  member={m}
                  isMe={isMe}
                  muted={muted}
                  hasVideo={hasVideo}
                  speaking={speaking}
                  isHandRaised={isMe && myHandRaised}
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
      <div className="shrink-0 px-6 py-3 border-t border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)] flex items-center justify-center gap-2" data-testid="bar-call-controls">
        <CallButton on={!myMicMuted} onClick={onToggleMic} title={myMicMuted ? "Unmute" : "Mute"}
          disabled={!!livekitInfo && lk.status !== "connected"}
          activeIcon={<Mic className="w-5 h-5" />} inactiveIcon={<MicOff className="w-5 h-5" />} testid="button-call-mic" />
        <CallButton on={myVideoOn} onClick={onToggleVideo} title={myVideoOn ? "Stop video" : "Start video"}
          disabled={!!livekitInfo && lk.status !== "connected"}
          activeIcon={<Video className="w-5 h-5" />} inactiveIcon={<VideoOff className="w-5 h-5" />} testid="button-call-video" />
        <CallButton on={myScreenSharing} onClick={onToggleScreen} title={myScreenSharing ? "Stop sharing" : "Share screen"}
          disabled={!!livekitInfo && lk.status !== "connected"}
          activeIcon={<MonitorUp className="w-5 h-5" />} inactiveIcon={<ScreenShareOff className="w-5 h-5" />} testid="button-call-screen" />
        <CallButton on={myHandRaised} onClick={onToggleHand} title={myHandRaised ? "Lower hand" : "Raise hand"}
          activeIcon={<Hand className="w-5 h-5" />} inactiveIcon={<Hand className="w-5 h-5" />} testid="button-call-hand" />
        <CallButton on={false} neutral title="More" activeIcon={<MoreHorizontal className="w-5 h-5" />} inactiveIcon={<MoreHorizontal className="w-5 h-5" />} testid="button-call-more" />
        <CallButton on={false} neutral title="Settings" activeIcon={<Settings className="w-5 h-5" />} inactiveIcon={<Settings className="w-5 h-5" />} testid="button-call-settings" />
        <div className="w-3" />
        <button
          type="button"
          onClick={onLeave}
          title="Leave call"
          data-testid="button-call-leave"
          className="h-11 px-5 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center gap-2 transition-colors shadow-lg shadow-red-900/30"
        >
          <PhoneOff className="w-4 h-4" />
          <span className="text-sm font-semibold">Leave</span>
        </button>
      </div>
    </section>
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

/** Full-width screen-share video sized to fit the preview region. */
function ScreenShareVideo({ track }: { track: Track | null }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    return attachTrack(track, ref.current);
  }, [track]);
  if (!track) {
    return <div className="aspect-video w-full bg-[hsl(232_55%_11%)] flex items-center justify-center text-xs text-[hsl(0_0%_55%)]">Waiting for screen…</div>;
  }
  return <video ref={ref} autoPlay playsInline muted className="w-full max-h-[480px] object-contain bg-black" />;
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
  on, onClick, title, activeIcon, inactiveIcon, neutral, testid, disabled,
}: {
  on: boolean;
  onClick?: () => void;
  title: string;
  activeIcon: React.ReactNode;
  inactiveIcon: React.ReactNode;
  neutral?: boolean;
  testid?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={disabled ? `${title} (waiting for call to connect)` : title}
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
