/**
 * useLiveKitRoom — React hook that turns a LiveKit token + ws URL into
 * a live, two-way audio/video/screen-share session inside the chat
 * voice channel.
 *
 * Responsibilities:
 *   - Connect to the LiveKit room when given a token; disconnect on
 *     unmount or when the channel changes.
 *   - Manage local tracks (mic, camera, screen-share) and reflect the
 *     parent's intent flags (myMicMuted, myVideoOn, myScreenSharing).
 *   - Expose the live participant list with `isSpeaking`, `videoTrack`,
 *     `screenTrack` so the VoiceChannelView can render real remote
 *     tiles instead of a demo array.
 *   - Surface connection state + last error so the UI can show a
 *     spinner / failure banner.
 *
 * This hook is intentionally framework-agnostic at the LiveKit level:
 * it talks directly to the `Room` instance from livekit-client. We do
 * not pull in `@livekit/components-react` because we want full control
 * over render layout (the existing UI is custom and quite polished
 * already).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  Track,
  LocalParticipant,
  RemoteParticipant,
  Participant,
  ConnectionState,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
  type RemoteTrack,
  type TrackPublication,
} from "livekit-client";

export interface RoomParticipantState {
  /** Numeric user id parsed from LiveKit identity `u_<id>`. */
  userId: number;
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  micMuted: boolean;
  /** Camera video track to attach to a <video> element. */
  videoTrack: Track | null;
  /** Screen-share video track. */
  screenTrack: Track | null;
  /** Remote microphone audio track to attach to a hidden <audio> element. Always null for the local participant (we never play our own mic). */
  audioTrack: Track | null;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";

export interface LiveKitHookResult {
  status: ConnectionStatus;
  error: string | null;
  participants: RoomParticipantState[];
  /** True when local mic is published and unmuted. */
  micPublished: boolean;
  /** True when local camera is published. */
  cameraPublished: boolean;
  /** True when local screen-share is published. */
  screenPublished: boolean;
}

interface Args {
  /** When null/undefined the hook stays idle (used to disable the call). */
  token: string | null | undefined;
  wsUrl: string | null | undefined;
  /** Stable id for the call; used to force reconnect on channel change. */
  roomKey: string | null | undefined;

  /** Desired state — parent toggles these, hook reconciles tracks. */
  micMuted: boolean;
  videoOn: boolean;
  screenSharing: boolean;

  /** Called when the user revokes a permission so the parent can flip its toggles back off. */
  onTrackError?: (kind: "mic" | "camera" | "screen", err: unknown) => void;
}

function userIdFromIdentity(identity: string): number {
  // Server mints identity as `u_<id>` (see server/livekit.ts).
  const m = identity.match(/^u_(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function snapshotParticipant(p: Participant, isLocal: boolean): RoomParticipantState {
  let videoTrack: Track | null = null;
  let screenTrack: Track | null = null;
  let audioTrack: Track | null = null;
  let micMuted = true;

  // p.getTrackPublications() returns local + remote publications in
  // a unified shape.
  const pubs = p.getTrackPublications();
  for (const pub of pubs) {
    if (pub.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
      // For remote, `isMuted` reflects the publisher's intent. For local
      // it's true when we've muted the track explicitly.
      micMuted = pub.isMuted || !pub.track;
      // Only expose remote audio — playing the local mic back would
      // cause feedback. The track on a remote publication is the
      // subscribed RemoteAudioTrack, which is attachable to <audio>.
      if (!isLocal && pub.track) audioTrack = pub.track;
    }
    if (pub.kind === Track.Kind.Video && pub.track) {
      if (pub.source === Track.Source.ScreenShare) screenTrack = pub.track;
      else if (pub.source === Track.Source.Camera) videoTrack = pub.track;
    }
  }

  return {
    userId: userIdFromIdentity(p.identity),
    identity: p.identity,
    name: p.name || p.identity,
    isLocal,
    isSpeaking: p.isSpeaking,
    audioLevel: p.audioLevel,
    micMuted,
    videoTrack,
    screenTrack,
    audioTrack,
  };
}

export function useLiveKitRoom(args: Args): LiveKitHookResult {
  const { token, wsUrl, roomKey, micMuted, videoOn, screenSharing, onTrackError } = args;

  // We hold the Room across renders via a ref so React strict mode's
  // double-invoke doesn't double-connect, and so toggle effects can
  // address the same instance the connect effect created.
  const roomRef = useRef<Room | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const cameraTrackRef = useRef<LocalVideoTrack | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<RoomParticipantState[]>([]);
  const [micPublished, setMicPublished] = useState(false);
  const [cameraPublished, setCameraPublished] = useState(false);
  const [screenPublished, setScreenPublished] = useState(false);

  // Helper: re-derive the participant array from the current room state.
  // We keep a stable closure via useCallback so event handlers can be
  // safely added/removed without re-binding every render.
  const refreshParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipants([]);
      return;
    }
    const list: RoomParticipantState[] = [];
    list.push(snapshotParticipant(room.localParticipant, true));
    // Use Array.from() to avoid downlevelIteration requirements on the
    // strict tsconfig target shared by the client + server build.
    Array.from(room.remoteParticipants.values()).forEach((rp) => {
      list.push(snapshotParticipant(rp, false));
    });
    setParticipants(list);
  }, []);

  // --- Connect / disconnect lifecycle -------------------------------------
  useEffect(() => {
    // No token => stay disconnected.
    if (!token || !wsUrl) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    const room = new Room({
      // Adaptive stream lowers resolution for tiles not in view, saving
      // bandwidth on mobile. Dynacast disables unused simulcast layers
      // server-side.
      adaptiveStream: true,
      dynacast: true,
    });
    roomRef.current = room;

    // ── Event wiring. Every event that can change the participant
    // snapshot triggers refreshParticipants(). We deliberately route
    // everything through one re-render path so the UI stays consistent.
    const onUpdate = () => {
      if (cancelled) return;
      refreshParticipants();
    };
    const onSpeaking = () => onUpdate();
    const onState = (state: ConnectionState) => {
      if (cancelled) return;
      switch (state) {
        case ConnectionState.Connected:
          setStatus("connected");
          setError(null);
          break;
        case ConnectionState.Reconnecting:
          setStatus("reconnecting");
          break;
        case ConnectionState.Disconnected:
          setStatus("disconnected");
          break;
        case ConnectionState.Connecting:
          setStatus("connecting");
          break;
      }
    };

    room
      .on(RoomEvent.ParticipantConnected, onUpdate)
      .on(RoomEvent.ParticipantDisconnected, onUpdate)
      .on(RoomEvent.TrackSubscribed, onUpdate)
      .on(RoomEvent.TrackUnsubscribed, onUpdate)
      .on(RoomEvent.TrackPublished, onUpdate)
      .on(RoomEvent.TrackUnpublished, onUpdate)
      .on(RoomEvent.LocalTrackPublished, onUpdate)
      .on(RoomEvent.LocalTrackUnpublished, onUpdate)
      .on(RoomEvent.TrackMuted, onUpdate)
      .on(RoomEvent.TrackUnmuted, onUpdate)
      .on(RoomEvent.ActiveSpeakersChanged, onSpeaking)
      .on(RoomEvent.ConnectionStateChanged, onState)
      .on(RoomEvent.Disconnected, () => {
        if (cancelled) return;
        setStatus("disconnected");
      });

    setStatus("connecting");
    setError(null);
    room
      .connect(wsUrl, token)
      .then(() => {
        if (cancelled) return;
        setStatus("connected");
        refreshParticipants();
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Could not connect to call";
        setError(msg);
        setStatus("failed");
      });

    // Cleanup: disconnect on unmount or when roomKey changes. Without
    // this we leak a ghost participant in the room until the LK
    // server times them out (~30s).
    return () => {
      cancelled = true;
      try {
        room.disconnect();
      } catch {
        /* ignore */
      }
      if (roomRef.current === room) roomRef.current = null;
      micTrackRef.current = null;
      cameraTrackRef.current = null;
      setMicPublished(false);
      setCameraPublished(false);
      setScreenPublished(false);
      setParticipants([]);
    };
    // We depend on roomKey (channel id) so switching channels tears
    // down and reconnects cleanly. token/wsUrl are derived from
    // roomKey but include them so a token refresh triggers reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, token, wsUrl]);

  // --- Mic reconciliation -------------------------------------------------
  useEffect(() => {
    const room = roomRef.current;
    if (!room || status !== "connected") return;

    let cancelled = false;
    (async () => {
      try {
        if (micMuted) {
          // Stop publishing the mic when muted instead of just muting
          // the track. This makes the browser drop the red recording
          // dot and feels safer to users than a "muted but live" mic.
          if (micTrackRef.current) {
            await room.localParticipant.unpublishTrack(micTrackRef.current);
            micTrackRef.current.stop();
            micTrackRef.current = null;
            if (!cancelled) setMicPublished(false);
          }
        } else {
          if (!micTrackRef.current) {
            const t = await createLocalAudioTrack({
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            });
            await room.localParticipant.publishTrack(t, { source: Track.Source.Microphone });
            if (cancelled) {
              t.stop();
              return;
            }
            micTrackRef.current = t;
            setMicPublished(true);
          }
        }
        refreshParticipants();
      } catch (err) {
        onTrackError?.("mic", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [micMuted, status, refreshParticipants, onTrackError]);

  // --- Camera reconciliation ---------------------------------------------
  useEffect(() => {
    const room = roomRef.current;
    if (!room || status !== "connected") return;

    let cancelled = false;
    (async () => {
      try {
        if (!videoOn) {
          if (cameraTrackRef.current) {
            await room.localParticipant.unpublishTrack(cameraTrackRef.current);
            cameraTrackRef.current.stop();
            cameraTrackRef.current = null;
            if (!cancelled) setCameraPublished(false);
          }
        } else {
          if (!cameraTrackRef.current) {
            const t = await createLocalVideoTrack({
              resolution: { width: 1280, height: 720, frameRate: 24 },
              facingMode: "user",
            });
            await room.localParticipant.publishTrack(t, { source: Track.Source.Camera });
            if (cancelled) {
              t.stop();
              return;
            }
            cameraTrackRef.current = t;
            setCameraPublished(true);
          }
        }
        refreshParticipants();
      } catch (err) {
        onTrackError?.("camera", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoOn, status, refreshParticipants, onTrackError]);

  // --- Screen share reconciliation ---------------------------------------
  useEffect(() => {
    const room = roomRef.current;
    if (!room || status !== "connected") return;

    let cancelled = false;
    (async () => {
      try {
        await room.localParticipant.setScreenShareEnabled(screenSharing, {
          audio: false, // Most field crews don't need system audio shared.
          resolution: { width: 1920, height: 1080, frameRate: 15 },
        });
        if (!cancelled) setScreenPublished(screenSharing);
        refreshParticipants();
      } catch (err) {
        onTrackError?.("screen", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [screenSharing, status, refreshParticipants, onTrackError]);

  return {
    status,
    error,
    participants,
    micPublished,
    cameraPublished,
    screenPublished,
  };
}

/**
 * Attach a LiveKit Track to an HTMLMediaElement (video or audio).
 * Use inside a useEffect to keep the lifecycle right.
 */
export function attachTrack(
  track: Track | null | undefined,
  element: HTMLMediaElement | null,
): () => void {
  if (!track || !element) return () => {};
  try {
    track.attach(element);
  } catch {
    /* ignore double-attach */
  }
  return () => {
    try {
      track.detach(element);
    } catch {
      /* ignore */
    }
  };
}
