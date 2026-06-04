/**
 * CallTile — a single participant tile (video or avatar) used by the
 * active-call video stage across all layouts.
 */
import { useEffect, useRef } from "react";
import { Mic, MicOff } from "lucide-react";
import { Avatar } from "../Avatar";
import { attachTrack } from "@/lib/useLiveKitRoom";
import type { RoomParticipantState } from "@/lib/useLiveKitRoom";

export function CallTile({
  name, hue, participant, isMe, muted, videoOff, compact,
}: {
  name: string;
  hue: number;
  participant: RoomParticipantState | null;
  isMe: boolean;
  muted?: boolean;
  videoOff?: boolean;
  /** Smaller avatar + label, for filmstrip/sidebar thumbnails. */
  compact?: boolean;
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
  const avatarSize = compact ? 56 : 128;

  return (
    <div
      className={[
        "relative w-full h-full rounded-2xl overflow-hidden border-2 transition-colors bg-[hsl(232_55%_11%)]",
        speaking ? "border-vs-blue shadow-xl" : "border-[hsl(232_40%_25%)]",
      ].join(" ")}
      data-testid={`call-tile-${isMe ? "me" : "them"}`}
    >
      {track && !videoOff && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: isMe ? "scaleX(-1)" : undefined }}
        />
      )}
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={speaking ? "speaking-ring rounded-full" : ""}>
            <Avatar member={{ name, hue }} size={avatarSize} ring={speaking ? "blue" : "none"} />
          </div>
        </div>
      )}
      <div className={[
        "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent flex items-center justify-between",
        compact ? "px-2 py-1" : "px-4 py-3",
      ].join(" ")}>
        <span className={compact ? "text-[11px] font-medium text-white truncate" : "text-sm font-semibold text-white"}>
          {name}{isMe && !compact && " (you)"}
        </span>
        {!compact && (
          <span
            className={[
              "w-7 h-7 rounded-full flex items-center justify-center shrink-0",
              isMuted ? "bg-vs-red text-white" : speaking ? "bg-vs-blue text-[hsl(232_60%_9%)]" : "bg-[hsl(232_45%_27%)] text-[hsl(0_0%_85%)]",
            ].join(" ")}
          >
            {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          </span>
        )}
      </div>
    </div>
  );
}
