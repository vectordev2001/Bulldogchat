/**
 * CallOverlays — full-screen UI for incoming, outgoing, and active 1:1
 * calls. Mounts once at the app root so the modal appears no matter
 * which page the user is on when the phone rings.
 */
import { useEffect, useRef } from "react";
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, MonitorUp, Loader2, Volume2 } from "lucide-react";
import { useCalls } from "@/lib/CallContext";
import { useLiveKitRoom, attachTrack } from "@/lib/useLiveKitRoom";
import { useState } from "react";
import { Avatar } from "./Avatar";
import type { Track } from "livekit-client";
import type { RoomParticipantState } from "@/lib/useLiveKitRoom";

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
      <div className="w-full max-w-sm rounded-2xl bg-[hsl(232_60%_12%)] border border-[hsl(232_40%_22%)] p-6 shadow-2xl text-center">
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
            className="h-14 w-14 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center justify-center shadow-lg transition-colors"
            title="Decline"
            data-testid="button-decline-call"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
          <button
            type="button"
            onClick={() => { void acceptIncoming(); }}
            className="h-14 w-14 rounded-full bg-vs-green hover:bg-[hsl(145_60%_55%)] text-[hsl(232_60%_9%)] flex items-center justify-center shadow-lg transition-colors"
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
      <div className="w-full max-w-sm rounded-2xl bg-[hsl(232_60%_12%)] border border-[hsl(232_40%_22%)] p-6 shadow-2xl text-center">
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
          className="h-12 px-6 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center gap-2 mx-auto shadow-lg transition-colors"
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

function ActiveCallOverlay() {
  const { active, endActive } = useCalls();
  const [micMuted, setMicMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(active?.kind === "video");
  const [screenSharing, setScreenSharing] = useState(false);

  // Reset toggles when the call changes.
  useEffect(() => {
    setMicMuted(false);
    setVideoOn(active?.kind === "video");
    setScreenSharing(false);
  }, [active?.callId, active?.kind]);

  const lk = useLiveKitRoom({
    token: active?.token ?? null,
    wsUrl: active?.wsUrl ?? null,
    roomKey: active ? `direct-${active.callId}` : null,
    micMuted,
    videoOn,
    screenSharing,
    onTrackError: (kind, err) => {
      console.warn(`[call] ${kind} error`, err);
      if (kind === "camera") setVideoOn(false);
      if (kind === "screen") setScreenSharing(false);
    },
  });

  if (!active) return null;

  const other = lk.participants.find(p => !p.isLocal) ?? null;
  const me = lk.participants.find(p => p.isLocal) ?? null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-[hsl(232_65%_8%)] text-white" data-testid="overlay-active-call">
      {/* Header */}
      <header className="h-14 px-4 flex items-center gap-3 border-b border-[hsl(232_40%_22%)] shrink-0 bg-[hsl(232_60%_12%)]/60 backdrop-blur-sm">
        <Volume2 className="w-5 h-5 text-vs-blue shrink-0" />
        <div className="font-display text-white text-base truncate">{active.otherName}</div>
        <span className="text-xs text-[hsl(0_0%_65%)] font-mono whitespace-nowrap hidden sm:inline">
          · {active.kind === "video" ? "Video" : "Voice"} call
        </span>
        <div className="ml-auto text-xs font-mono text-[hsl(0_0%_65%)] whitespace-nowrap">
          {lk.status === "connecting" || lk.status === "reconnecting" ? "Connecting…"
            : lk.status === "failed" ? <span className="text-vs-red">Connection failed</span>
            : <span className="text-vs-green">Connected</span>}
        </div>
      </header>

      {/* Body: two tiles (you + them). Larger remote tile if video. */}
      <div className="flex-1 min-h-0 p-6 flex items-center justify-center">
        <div className="w-full max-w-4xl grid gap-4 grid-cols-1 sm:grid-cols-2">
          <CallTile name={active.otherName} hue={active.otherHue} participant={other} isMe={false} kind={active.kind} />
          <CallTile name="You" hue={210} participant={me} isMe={true} kind={active.kind} muted={micMuted} videoOff={!videoOn} />
        </div>
      </div>

      {/* Hidden audio sink so the remote can be heard. */}
      <RemoteAudio participant={other} />

      {/* Error banner */}
      {lk.error && (
        <div className="px-4 py-2 bg-[hsl(2_70%_55%/0.15)] border-y border-[hsl(2_70%_55%/0.4)] text-xs text-[hsl(2_85%_75%)] text-center">
          {lk.error}
        </div>
      )}

      {/* Controls */}
      <div className="shrink-0 px-6 py-4 border-t border-[hsl(232_40%_22%)] bg-[hsl(232_55%_11%)] flex items-center justify-center gap-3">
        <CtrlBtn on={!micMuted} onClick={() => setMicMuted(m => !m)} onIcon={<Mic className="w-5 h-5" />} offIcon={<MicOff className="w-5 h-5" />} title={micMuted ? "Unmute" : "Mute"} testid="call-mic" />
        <CtrlBtn on={videoOn} onClick={() => setVideoOn(v => !v)} onIcon={<Video className="w-5 h-5" />} offIcon={<VideoOff className="w-5 h-5" />} title={videoOn ? "Stop video" : "Start video"} testid="call-video" />
        <CtrlBtn on={screenSharing} onClick={() => setScreenSharing(s => !s)} onIcon={<MonitorUp className="w-5 h-5" />} offIcon={<MonitorUp className="w-5 h-5" />} title={screenSharing ? "Stop sharing" : "Share screen"} testid="call-screen" />
        <div className="w-3" />
        <button
          type="button"
          onClick={() => { void endActive(); }}
          className="h-12 px-6 rounded-full bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white flex items-center gap-2 shadow-lg transition-colors"
          data-testid="button-end-call"
        >
          <PhoneOff className="w-4 h-4" />
          <span className="text-sm font-semibold">End</span>
        </button>
      </div>
    </div>
  );
}

function CallTile({
  name, hue, participant, isMe, kind, muted, videoOff,
}: {
  name: string; hue: number;
  participant: RoomParticipantState | null;
  isMe: boolean;
  kind: "voice" | "video";
  muted?: boolean;
  videoOff?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = participant?.videoTrack ?? null;
  useEffect(() => {
    if (!videoRef.current) return;
    return attachTrack(track, videoRef.current);
  }, [track]);

  const speaking = participant?.isSpeaking && !participant?.micMuted;
  const isMuted = participant?.micMuted ?? (isMe ? !!muted : false);
  const hasVideo = !!track && !videoOff;

  return (
    <div
      className={[
        "relative aspect-video rounded-2xl overflow-hidden border-2 transition-colors bg-[hsl(232_55%_11%)]",
        speaking ? "border-vs-blue shadow-xl" : "border-[hsl(232_40%_25%)]",
      ].join(" ")}
      data-testid={`call-tile-${isMe ? "me" : "them"}`}
    >
      {track && !videoOff && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted // remote audio handled separately
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: isMe ? "scaleX(-1)" : undefined }}
        />
      )}
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={speaking ? "speaking-ring rounded-full" : ""}>
            <Avatar member={{ name, hue }} size={128} ring={speaking ? "blue" : "none"} />
          </div>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent flex items-center justify-between">
        <span className="text-sm font-semibold text-white">{name}{isMe && " (you)"}</span>
        <span
          className={[
            "w-7 h-7 rounded-full flex items-center justify-center",
            isMuted ? "bg-vs-red text-white" : speaking ? "bg-vs-blue text-[hsl(232_60%_9%)]" : "bg-[hsl(232_45%_27%)] text-[hsl(0_0%_85%)]",
          ].join(" ")}
        >
          {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
        </span>
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
  on, onClick, onIcon, offIcon, title, testid,
}: {
  on: boolean;
  onClick(): void;
  onIcon: React.ReactNode;
  offIcon: React.ReactNode;
  title: string;
  testid?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testid}
      className={[
        "w-12 h-12 rounded-full flex items-center justify-center transition-all",
        on
          ? "bg-[hsl(232_45%_27%)] hover:bg-[hsl(232_45%_32%)] text-white"
          : "bg-[hsl(2_70%_55%/0.25)] hover:bg-[hsl(2_70%_55%/0.35)] text-[hsl(2_85%_72%)] ring-1 ring-[hsl(2_70%_55%/0.4)]",
      ].join(" ")}
    >
      {on ? onIcon : offIcon}
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
    <div className="fixed bottom-6 right-6 z-[110] max-w-xs px-4 py-3 rounded-lg bg-[hsl(232_60%_14%)] border border-[hsl(232_40%_25%)] shadow-2xl text-white flex items-center gap-3" data-testid="toast-call-ended">
      <PhoneOff className="w-4 h-4 text-vs-red shrink-0" />
      <div className="min-w-0">
        <div className="text-xs font-mono uppercase tracking-wider text-[hsl(0_0%_65%)]">{label}</div>
        <div className="text-sm font-semibold truncate">{lastEnded.otherName}</div>
      </div>
    </div>
  );
}
