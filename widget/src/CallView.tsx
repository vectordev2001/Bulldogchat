import { useEffect, useState } from "react";
import {
  LiveKitRoom,
  useParticipants,
  useLocalParticipant,
  VideoTrack,
  useTracks,
  RoomAudioRenderer,
  StartAudio,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import type { ActiveCall } from "./state";
import type { ChatApiClient } from "./api";

// ── CallView ──────────────────────────────────────────────────────────────────
// Compact video call panel that renders inside the widget.
// Layout: a ~220px tall video area with small tiles, + a controls row.

interface CallViewProps {
  call: ActiveCall;
  api: ChatApiClient;
  onCallEnded: () => void;
}

export function CallView({ call, api, onCallEnded }: CallViewProps) {
  const [ending, setEnding] = useState(false);

  const handleEnd = async () => {
    if (ending) return;
    setEnding(true);
    try {
      await api.endCall(call.callId);
    } catch {
      /* best-effort */
    } finally {
      onCallEnded();
    }
  };

  return (
    <LiveKitRoom
      token={call.token}
      serverUrl={call.wsUrl}
      connect
      video
      audio
      onDisconnected={onCallEnded}
      className="bcw-flex bcw-flex-col bcw-flex-1 bcw-min-h-0 bcw-bg-[hsl(220,60%,6%)]"
    >
      <CallRoomInner onEnd={handleEnd} ending={ending} />
    </LiveKitRoom>
  );
}

function CallRoomInner({ onEnd, ending }: { onEnd: () => void; ending: boolean }) {
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const cameraTracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }]);
  const screenTracks = useTracks([{ source: Track.Source.ScreenShare, withPlaceholder: false }]);

  // Belt-and-suspenders: ensure the mic is actually publishing after the
  // LiveKit connection is established. `<LiveKitRoom audio />` requests the
  // mic at connect time, but in some browsers (Safari, iOS webview, and
  // Chrome after a permission prompt bounce) that initial publish can silently
  // fail. Re-attempting on mount makes the mic reliably available so the
  // other participant can hear you.
  useEffect(() => {
    if (!localParticipant) return;
    localParticipant
      .setMicrophoneEnabled(true)
      .catch((err) => console.warn("[widget] enable mic failed", err));
  }, [localParticipant]);

  const toggleMic = async () => {
    await localParticipant.setMicrophoneEnabled(!micOn);
    setMicOn((v) => !v);
  };

  const toggleCam = async () => {
    await localParticipant.setCameraEnabled(!camOn);
    setCamOn((v) => !v);
  };

  return (
    <div className="bcw-flex bcw-flex-col bcw-flex-1 bcw-min-h-0">
      {/* Video tile grid — max 4 tiles, 2-col */}
      <div
        className="bcw-flex-1 bcw-grid bcw-gap-1 bcw-p-1.5 bcw-min-h-0"
        style={{ gridTemplateColumns: participants.length > 1 ? "1fr 1fr" : "1fr" }}
      >
        {cameraTracks.slice(0, 4).map((trackRef) => (
          <div
            key={trackRef.participant.identity}
            className="bcw-relative bcw-rounded-md bcw-overflow-hidden bcw-bg-[hsl(220,60%,9%)] bcw-aspect-video"
          >
            {trackRef.publication && (trackRef.publication.isSubscribed || trackRef.participant === localParticipant) ? (
              <VideoTrack
                trackRef={{
                  participant: trackRef.participant,
                  publication: trackRef.publication,
                  source: trackRef.source,
                }}
                className="bcw-w-full bcw-h-full bcw-object-cover"
              />
            ) : (
              <ParticipantPlaceholder name={trackRef.participant.name ?? trackRef.participant.identity} />
            )}
            <span className="bcw-absolute bcw-bottom-1 bcw-left-1.5 bcw-text-[10px] bcw-text-white/70 bcw-bg-black/40 bcw-rounded bcw-px-1">
              {trackRef.participant.name ?? trackRef.participant.identity}
              {trackRef.participant === localParticipant ? " (you)" : ""}
            </span>
          </div>
        ))}
      </div>

      {/* Remote audio renderer — attaches every remote participant's
          microphone track to a hidden <audio> element and calls .play() so
          browsers actually output the sound. This is the correct primitive
          for a small call UI; the old code subscribed camera tracks as
          <AudioTrack>, which does nothing because camera tracks are video. */}
      <RoomAudioRenderer />

      {/* If the browser blocks autoplay (Safari, background tab, etc.),
          StartAudio surfaces a small overlay button the user taps to unlock
          audio. Invisible in the DOM when audio playback is already allowed. */}
      <StartAudio
        label="Click to enable audio"
        className="bcw-absolute bcw-top-2 bcw-left-1/2 bcw-transform bcw--translate-x-1/2 bcw-px-3 bcw-py-1.5 bcw-rounded-full bcw-bg-white/95 bcw-text-black bcw-text-xs bcw-font-semibold bcw-shadow-lg bcw-z-10"
      />

      {/* Controls */}
      <div className="bcw-h-12 bcw-flex bcw-items-center bcw-justify-center bcw-gap-3 bcw-border-t bcw-border-black/40 bcw-shrink-0 bcw-bg-[hsl(220,60%,8%)]">
        <CallControlBtn active={micOn} onClick={toggleMic} title={micOn ? "Mute mic" : "Unmute mic"}>
          {micOn ? <MicOnIcon /> : <MicOffIcon />}
        </CallControlBtn>
        <CallControlBtn active={camOn} onClick={toggleCam} title={camOn ? "Stop camera" : "Start camera"}>
          {camOn ? <CamOnIcon /> : <CamOffIcon />}
        </CallControlBtn>
        <button
          type="button"
          onClick={onEnd}
          disabled={ending}
          className="bcw-w-9 bcw-h-9 bcw-rounded-full bcw-bg-red-600 bcw-flex bcw-items-center bcw-justify-center bcw-text-white hover:bcw-bg-red-700 disabled:bcw-opacity-50"
          title="End call"
        >
          <HangUpIcon />
        </button>
      </div>
    </div>
  );
}

function CallControlBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`bcw-w-9 bcw-h-9 bcw-rounded-full bcw-flex bcw-items-center bcw-justify-center bcw-text-white bcw-transition-colors ${
        active
          ? "bcw-bg-white/15 hover:bcw-bg-white/25"
          : "bcw-bg-bcw-navy-light hover:bcw-bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

function ParticipantPlaceholder({ name }: { name: string }) {
  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="bcw-w-full bcw-h-full bcw-flex bcw-items-center bcw-justify-center bcw-bg-[hsl(220,60%,12%)]">
      <span className="bcw-text-lg bcw-font-semibold bcw-text-white/60">{initials}</span>
    </div>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────

function MicOnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
    </svg>
  );
}
function MicOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v4M8 23h8" />
    </svg>
  );
}
function CamOnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}
function CamOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8" />
    </svg>
  );
}
function HangUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" />
    </svg>
  );
}
