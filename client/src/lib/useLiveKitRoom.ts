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
  LocalVideoTrack,
  LocalAudioTrack,
  type RemoteTrack,
  type TrackPublication,
} from "livekit-client";

// Detect iOS Safari (including iPadOS-as-desktop). iOS Safari is the only
// platform where we need the user-gesture-preserving camera path.
function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPad in "desktop site" mode reports Mac UA but has touch points.
  return ua.includes("Mac") && (navigator as any).maxTouchPoints > 1;
}

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
  /**
   * iOS-safe camera enable. MUST be called synchronously from inside
   * a user-gesture handler (onClick/onTouchEnd) — it acquires the
   * MediaStream inside the gesture and then hands the resulting track
   * to LiveKit. Returns the new desired state (true=on, false=off).
   * On non-iOS browsers this is a thin wrapper over setCameraEnabled.
   */
  toggleCamera: () => Promise<boolean>;
  /**
   * iOS-safe mic toggle. Same rules as toggleCamera — must run inside
   * a user gesture so the audio MediaStream is acquired while iOS
   * still considers the call "in-gesture". Returns the new muted state
   * (true=muted, false=unmuted).
   */
  toggleMic: () => Promise<boolean>;
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
  // Promise chain that serializes camera enable/disable ops. iOS Safari
  // hangs if two setCameraEnabled() calls overlap; we await the prior
  // op before firing the next one.
  const cameraOpRef = useRef<Promise<void> | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<RoomParticipantState[]>([]);
  const [micPublished, setMicPublished] = useState(false);
  const [cameraPublished, setCameraPublished] = useState(false);
  const [screenPublished, setScreenPublished] = useState(false);

  // We track "desired video" inside the hook (mirrored from props) so the
  // imperative iOS path can flip it without going through React state.
  // The reconciliation effect respects this when isIOS=true to avoid
  // double-firing the camera path.
  const desiredVideoRef = useRef(videoOn);
  useEffect(() => { desiredVideoRef.current = videoOn; }, [videoOn]);
  // Same idea for mic. We mirror micMuted so the imperative iOS path
  // can read the latest desired state without stale closures.
  const desiredMicMutedRef = useRef(micMuted);
  useEffect(() => { desiredMicMutedRef.current = micMuted; }, [micMuted]);

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

  // --- Detect iOS once (used by both mic and camera paths) ---------------
  const isIOS = detectIOS();

  // --- Mic reconciliation -------------------------------------------------
  // Same iOS gesture problem as camera: setMicrophoneEnabled() invokes
  // getUserMedia({audio:true}) in a microtask. By the time it runs, iOS
  // has already torn down the gesture context. Result: audio track is
  // returned but produces no frames, publish hangs forever, WebView
  // locks up.
  //
  // On iOS we drive mic state imperatively via toggleMic(). Off-path
  // (mute) is safe to do here — no permission, no getUserMedia.
  useEffect(() => {
    if (isIOS && !micMuted) return; // unmute on iOS goes through toggleMic

    const room = roomRef.current;
    if (!room || status !== "connected") return;

    let cancelled = false;
    (async () => {
      try {
        if (micMuted) {
          // Mute path: if a manually-published iOS track exists, fully
          // unpublish it so we don't keep the mic LED on.
          if (micTrackRef.current) {
            try { await room.localParticipant.unpublishTrack(micTrackRef.current); } catch { /* ignore */ }
            try { micTrackRef.current.stop(); } catch { /* ignore */ }
            micTrackRef.current = null;
          }
          await room.localParticipant.setMicrophoneEnabled(false);
          if (cancelled) return;
          setMicPublished(false);
          refreshParticipants();
          return;
        }

        // Non-iOS unmute path.
        await room.localParticipant.setMicrophoneEnabled(true, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
        if (cancelled) return;
        const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
        micTrackRef.current = (pub?.track as LocalAudioTrack | undefined) ?? null;
        setMicPublished(!!micTrackRef.current);
        refreshParticipants();
      } catch (err) {
        if (!cancelled) onTrackError?.("mic", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [micMuted, status, refreshParticipants, onTrackError, isIOS]);

  // --- iOS-safe imperative mic toggle ------------------------------------
  // MUST be called synchronously from a user-gesture handler on iOS.
  // getUserMedia({audio:true}) runs inside the gesture window, the
  // resulting MediaStreamTrack is wrapped in LocalAudioTrack and
  // published manually — bypassing setMicrophoneEnabled's microtask
  // race entirely. Returns the new muted state (true=muted).
  const toggleMic = useCallback(async (): Promise<boolean> => {
    const room = roomRef.current;
    // Use roomRef + room.state instead of the React `status` state. The
    // `status` closure can lag behind the actual room state because the
    // useCallback only re-creates when its deps change — so a user who
    // clicks the moment the room transitions to connected can see a
    // stale "not connected" error. room.state is always live.
    const roomConnected = !!room && (room as any).state === "connected";
    if (!room || !roomConnected) {
      onTrackError?.("mic", new Error("Call is still connecting — give it a second and tap again."));
      return desiredMicMutedRef.current;
    }

    // Muting (turn off): no gesture needed.
    if (!desiredMicMutedRef.current) {
      try {
        if (micTrackRef.current) {
          try { await room.localParticipant.unpublishTrack(micTrackRef.current); } catch { /* ignore */ }
          try { micTrackRef.current.stop(); } catch { /* ignore */ }
          micTrackRef.current = null;
        }
        await room.localParticipant.setMicrophoneEnabled(false);
        setMicPublished(false);
        refreshParticipants();
      } catch (err) {
        onTrackError?.("mic", err);
      }
      desiredMicMutedRef.current = true;
      return true;
    }

    // Unmuting. On non-iOS, just flip the flag; effect handles it.
    if (!isIOS) {
      desiredMicMutedRef.current = false;
      return false;
    }

    // iOS gesture-preserving path. NO awaits before getUserMedia.
    // CRITICAL: pass plain `audio: true` on iOS. WebKit PWA freezes hard
    // when given a constraints object (echoCancellation/noiseSuppression/
    // autoGainControl) — same flake we already work around for camera.
    // Apply the audio processing hints AFTER the track is published via
    // LiveKit's setAudioFilter / publish options instead.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch (err) {
      onTrackError?.("mic", err);
      return true; // stay muted
    }

    const msTrack = stream.getAudioTracks()[0];
    if (!msTrack) {
      onTrackError?.("mic", new Error("No mic track returned by iOS"));
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      return true;
    }

    try {
      const lkTrack = new LocalAudioTrack(msTrack);
      await room.localParticipant.publishTrack(lkTrack, {
        source: Track.Source.Microphone,
        name: "microphone",
        dtx: true,
        red: true,
      });
      micTrackRef.current = lkTrack;
      setMicPublished(true);
      desiredMicMutedRef.current = false;
      refreshParticipants();
      return false;
    } catch (err) {
      try { msTrack.stop(); } catch { /* ignore */ }
      onTrackError?.("mic", err);
      return true;
    }
  }, [status, isIOS, refreshParticipants, onTrackError]);

  // --- Camera reconciliation ---------------------------------------------
  // Hard-won lessons on iOS Safari (PWA + browser):
  //   * setCameraEnabled() internally calls getUserMedia in a microtask,
  //     which on iOS happens AFTER the user-gesture context expires.
  //     The permission prompt shows, the user taps Allow, and then
  //     getUserMedia returns a track whose MediaStream produces no
  //     frames — publish hangs forever and the WebView locks up.
  //   * Fix: on iOS, acquire the MediaStreamTrack via getUserMedia
  //     SYNCHRONOUSLY inside the click handler, then hand that track
  //     to LocalVideoTrack + publishTrack. Because the gesture is still
  //     active when getUserMedia is invoked, iOS returns a working track.
  //   * Non-iOS browsers (Chrome desktop, Android Chrome, Firefox) handle
  //     setCameraEnabled() correctly and keep the simpler path.
  //   * Off-path always uses setCameraEnabled(false) — no permission
  //     prompt, safe in any context.
  useEffect(() => {
    // On iOS we drive camera state imperatively via toggleCamera(); the
    // reconciliation effect would race against it. Off-state still flows
    // through here (no permission needed, no gesture race).
    if (isIOS && videoOn) return;

    const room = roomRef.current;
    if (!room || status !== "connected") return;

    let cancelled = false;
    (async () => {
      const prior = cameraOpRef.current;
      let release: () => void = () => {};
      const next = new Promise<void>((res) => (release = res));
      cameraOpRef.current = prior ? prior.then(() => next) : next;
      if (prior) {
        try { await prior; } catch { /* swallow */ }
      }
      if (cancelled) { release(); return; }

      try {
        if (!videoOn) {
          await room.localParticipant.setCameraEnabled(false);
          if (cancelled) return;
          // Also unpublish any manually-published iOS track.
          if (cameraTrackRef.current) {
            try {
              await room.localParticipant.unpublishTrack(cameraTrackRef.current);
            } catch { /* ignore */ }
            try { cameraTrackRef.current.stop(); } catch { /* ignore */ }
            cameraTrackRef.current = null;
          }
          setCameraPublished(false);
          refreshParticipants();
          return;
        }

        // Non-iOS "on" path: declarative setCameraEnabled with constraints.
        const isCoarsePointer =
          typeof window !== "undefined" &&
          window.matchMedia &&
          window.matchMedia("(pointer: coarse)").matches;
        const videoOpts = isCoarsePointer
          ? { resolution: { width: 640, height: 480, frameRate: 24 }, facingMode: "user" as const }
          : { resolution: { width: 1280, height: 720, frameRate: 24 }, facingMode: "user" as const };

        await Promise.race([
          room.localParticipant.setCameraEnabled(true, videoOpts),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Camera did not start in 15s. Check browser camera permissions.")),
              15_000,
            ),
          ),
        ]);
        if (cancelled) return;
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        cameraTrackRef.current = (pub?.track as LocalVideoTrack | undefined) ?? null;
        setCameraPublished(!!cameraTrackRef.current);
        refreshParticipants();
      } catch (err) {
        if (!cancelled) onTrackError?.("camera", err);
      } finally {
        release();
        if (cameraOpRef.current === next) cameraOpRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoOn, status, refreshParticipants, onTrackError, isIOS]);

  // --- iOS-safe imperative camera toggle ---------------------------------
  // Returns the new desired "on" state so the parent can sync its prop.
  //
  // On non-iOS: this is a no-op that just returns the inverted prop. The
  // reconciliation effect above does all the work via setCameraEnabled().
  // We deliberately do NOT touch desiredVideoRef here — the prop is the
  // single source of truth and the effect mirrors it into the ref.
  //
  // On iOS: getUserMedia is invoked synchronously inside the click gesture
  // and the resulting MediaStreamTrack is wrapped in LocalVideoTrack and
  // published manually — bypassing the microtask race that lock up WebKit.
  const toggleCamera = useCallback(async (): Promise<boolean> => {
    const currentlyOn = desiredVideoRef.current;
    const wantOn = !currentlyOn;

    const room = roomRef.current;
    // See toggleMic comment: rely on the live room.state, not the React
    // closure's `status` snapshot. Prevents the silent "nothing happens"
    // failure when the user taps right as connection completes.
    const roomConnected = !!room && (room as any).state === "connected";
    if (!room || !roomConnected) {
      onTrackError?.("camera", new Error("Call is still connecting — give it a second and tap again."));
      return currentlyOn;
    }

    // Turning OFF: easy on every platform.
    if (!wantOn) {
      // Optimistically tell the parent we're off. The reconciliation effect
      // will catch up via the prop change and run setCameraEnabled(false).
      return false;
    }

    // Turning ON.
    // Non-iOS: do nothing here. Return true so the parent flips its prop
    // and the reconciliation effect publishes via setCameraEnabled(true).
    // This is the path that previously got tangled with desiredVideoRef
    // drift — keep it simple.
    if (!isIOS) {
      return true;
    }

    // iOS gesture-preserving path. The hard requirement: getUserMedia must
    // be called from inside the user-gesture click handler, BEFORE any
    // await. The caller invokes us inside onClick, so we're inside that
    // gesture window now.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // No constraints on iOS — PWA WebKit is flaky with them. Plain
        // `true` lets iOS pick its best front camera.
        video: true,
        audio: false,
      });
    } catch (err) {
      onTrackError?.("camera", err);
      return false;
    }

    const msTrack = stream.getVideoTracks()[0];
    if (!msTrack) {
      onTrackError?.("camera", new Error("No camera track returned by iOS"));
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      return false;
    }

    try {
      const lkTrack = new LocalVideoTrack(msTrack);
      await room.localParticipant.publishTrack(lkTrack, {
        source: Track.Source.Camera,
        name: "camera",
      });
      cameraTrackRef.current = lkTrack;
      setCameraPublished(true);
      // Mirror into the ref so the reconciliation effect's iOS guard
      // (`if (isIOS && videoOn) return;`) keeps the parent prop from
      // double-publishing once it flips to true.
      desiredVideoRef.current = true;
      refreshParticipants();
      return true;
    } catch (err) {
      try { msTrack.stop(); } catch { /* ignore */ }
      onTrackError?.("camera", err);
      return false;
    }
  }, [status, isIOS, refreshParticipants, onTrackError]);

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
    toggleCamera,
    toggleMic,
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
