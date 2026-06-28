import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  LiveKitRoom,
  useTracks,
  VideoTrack,
  useParticipants,
  useLocalParticipant,
  useRoomContext,
  useChat,
  useDataChannel,
  RoomAudioRenderer,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  Track,
  ConnectionQuality,
  LocalVideoTrack,
  VideoPresets,
  type Participant,
  type Room as LkRoom,
  type RoomOptions,
} from "livekit-client";
import "@livekit/components-styles";
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, Hand, MessageSquare, Users, Sparkles,
  X, Smile, PhoneOff, Send, MicOff as MicOffIcon, Aperture, Settings, DoorOpen, Check, UserPlus,
} from "lucide-react";
import { BulldogMark, PlatformLogo, initials } from "@/components/BulldogLogo";
import { ThemeToggle } from "@/components/MeetingThemeToggle";
import { useToast } from "@/hooks/use-toast";
import { useMeeting, ORIGIN_CHIP } from "@/lib/meeting";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { VirtualBackgroundProcessor } from "@/lib/virtual-background";
import {
  VirtualBackgroundPicker,
  loadSavedSelection,
  type BgSelection,
} from "@/components/call/VirtualBackgroundPicker";
import { MeetSettingsModal } from "@/components/call/MeetSettingsModal";
import { DeviceSelector } from "@/components/call/DeviceSelector";
import { SharingFloatingBar, type SharingAnnotationTool } from "@/components/call/SharingFloatingBar";
import { InviteToMeetingDialog } from "@/components/call/InviteToMeetingDialog";
import { ScreenShareAnnotator, annotationsSupported } from "@/lib/screen-share-annotator";
import { blurSupported, loadDevicePrefs, saveDevicePrefs, type DevicePrefs } from "@/lib/meet-devices";
import { loadMeetPrefs, saveMeetPrefs, MEET_PREFS_EVENT, emitMeetPrefsChanged, type MeetPrefs } from "@/lib/meet-prefs";

const REACTIONS = ["👍", "❤️", "😂", "🎉", "👏"];
type SidebarTab = "chat" | "participants" | "transcript";

interface FloatingReaction {
  id: number;
  emoji: string;
  left: number;
}

interface LobbyKnock {
  id: string;
  displayName: string;
  createdAt: number;
}

// Room-level LiveKit options shared by every participant. Tuned for the
// "replace Teams" goal: smooth multi-user calls on mixed hardware
// (laptops + phones + tablets), good screen-share quality, low overall
// bandwidth so jobsite LTE doesn't choke.
//
// - `adaptiveStream`: subscriber-side; pause/resize tracks based on what's
//   actually visible. A 1×1 thumbnail won't subscribe to the HD layer.
// - `dynacast`: publisher-side; the SFU tells the publisher to stop
//   encoding simulcast layers no one is subscribing to. Critical for
//   mixed-power calls so weak peers don't get blasted with HD encodes
//   they can't render and the strong peer's uplink stays clean.
// - `publishDefaults.simulcast`: per-layer L/M/H encodes so receivers
//   pick independently. We switched off VP9 to VP8: VP9 was crashing
//   some webcam drivers and Safari < 17 has scattered VP9 hardware-
//   decode bugs. VP8 is universally supported and dynacast still keeps
//   bandwidth reasonable. Codec choice here is for camera video; screen
//   share has its own codec preference below.
// - `publishDefaults.screenShareEncoding`: bumped to 1.5 Mbps target /
//   3 Mbps max so shared text/code stays crisp. Default 1.5 Mbps is
//   often too low for Teams-style code review.
// - `publishDefaults.videoEncoding`: 1.2 Mbps target / 2.5 Mbps max for
//   the HD camera layer; simulcast Low and Mid auto-derive from this.
// - `publishDefaults.stopMicTrackOnMute`: false — keep the mic track alive
//   when muted so unmute is instant (no getUserMedia round trip, which
//   on Bluetooth audio can be 1–2 seconds).
// - `videoCaptureDefaults.resolution`: cap publisher capture at 720p.
//   Higher resolutions kill mobile uplinks for marginal quality gain at
//   tile size; users can opt into HD via the devices modal later.
// - `audioCaptureDefaults`: enable echoCancellation, noiseSuppression,
//   autoGainControl. Especially important on AirPods/Bluetooth where
//   raw mic audio is noisy.
const MEETING_ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  publishDefaults: {
    simulcast: true,
    videoCodec: "vp8",
    stopMicTrackOnMute: false,
    videoEncoding: {
      maxBitrate: 2_500_000,
      maxFramerate: 30,
    },
    screenShareEncoding: {
      maxBitrate: 3_000_000,
      maxFramerate: 15,
    },
  },
  videoCaptureDefaults: {
    resolution: VideoPresets.h720.resolution,
  },
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export default function Room() {
  const [, params] = useRoute("/r/:code");
  const [, navigate] = useLocation();
  const code = (params?.code ?? "").split("?")[0];
  const m = useMeeting();

  useEffect(() => {
    if (!m.token || !m.wsUrl) {
      navigate(`/m/${code}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!m.token || !m.wsUrl) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        Reconnecting…
      </div>
    );
  }

  // CRITICAL: We do NOT pass `video` / `audio` to <LiveKitRoom>. Those props
  // make the room call setCameraEnabled/setMicrophoneEnabled internally,
  // which triggers a fresh getUserMedia() inside a microtask — outside the
  // click-gesture window from the Join button. On iOS WebKit, the resulting
  // tracks come back frozen/silent until the user manually toggles.
  //
  // Instead, the prejoin route hands off its already-acquired LocalAudioTrack
  // and LocalVideoTrack via m.prejoinTracksRef, and we publish them directly
  // (see BulldogMeetingUI). If no prejoin tracks exist (e.g. user landed on
  // /r/<code> directly), we fall back to setMicrophone/CameraEnabled.
  return (
    <LiveKitRoom
      serverUrl={m.wsUrl}
      token={m.token}
      connect={true}
      video={false}
      audio={false}
      options={MEETING_ROOM_OPTIONS}
      onConnected={() => m.setConnectedAt(Date.now())}
      onDisconnected={() => navigate(`/end/${code}`)}
      onError={(err) => console.error("LiveKit error:", err)}
      className="h-screen"
      data-lk-theme="default"
    >
      <RoomAudioRenderer />
      <BulldogMeetingUI code={code} />
    </LiveKitRoom>
  );
}

function fmt(s: number) {
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}

/**
 * Drives the virtual-background processor against the live LiveKit Room camera
 * publication. We swap the raw camera track for the processor's canvas output
 * (and back) by unpublishing/republishing on the room's localParticipant.
 *
 * Returns an `apply` callback the UI invokes whenever the selection or camera
 * state changes. On any MediaPipe failure it reverts to the raw camera and
 * surfaces a toast — blur is best-effort, never fatal to the call.
 */
function useMeetBackground(
  room: LkRoom,
  camOn: boolean,
  bgSel: BgSelection,
  onError: () => void,
) {
  const processorRef = useRef<VirtualBackgroundProcessor | null>(null);
  // The raw camera MediaStreamTrack we segment from. Stashed so it survives
  // the unpublish/republish cycle (unpublish can stop the wrapper track).
  const rawTrackRef = useRef<MediaStreamTrack | null>(null);

  // Stop the processor and restore the raw camera publication.
  const teardown = useCallback(async () => {
    if (!processorRef.current) return;
    processorRef.current.stop();
    processorRef.current = null;
    const lp = room.localParticipant;
    const existing = lp.getTrackPublication(Track.Source.Camera);
    if (existing?.track) {
      try { await lp.unpublishTrack(existing.track as LocalVideoTrack, true); } catch { /* ignore */ }
    }
    const raw = rawTrackRef.current;
    if (raw && raw.readyState === "live") {
      try {
        const lkTrack = new LocalVideoTrack(raw);
        await lp.publishTrack(lkTrack, { source: Track.Source.Camera, name: "camera" });
      } catch { /* ignore */ }
    } else {
      try { await lp.setCameraEnabled(true); } catch { /* ignore */ }
    }
    rawTrackRef.current = null;
  }, [room]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const lp = room.localParticipant;
      if (!camOn || bgSel.mode.kind === "none") {
        await teardown();
        return;
      }
      const pub = lp.getTrackPublication(Track.Source.Camera);
      const raw = (pub?.track as { mediaStreamTrack?: MediaStreamTrack } | undefined)?.mediaStreamTrack;
      if (!raw) return; // camera not published yet; effect re-runs on change

      try {
        if (processorRef.current) {
          await processorRef.current.setMode(bgSel.mode);
          return;
        }
        rawTrackRef.current = raw;
        const proc = new VirtualBackgroundProcessor();
        const processed = await proc.start(raw, bgSel.mode);
        if (cancelled) { proc.stop(); return; }
        processorRef.current = proc;
        // Republish: drop the camera publication, publish the processed track.
        // stopOnUnpublish=false so the raw input track stays alive for the
        // processor to keep reading frames from.
        const existing = lp.getTrackPublication(Track.Source.Camera);
        if (existing?.track) {
          try { await lp.unpublishTrack(existing.track as LocalVideoTrack, false); } catch { /* ignore */ }
        }
        const lkTrack = new LocalVideoTrack(processed);
        await lp.publishTrack(lkTrack, { source: Track.Source.Camera, name: "camera" });
      } catch (err) {
        console.warn("[meet] virtual background unavailable:", (err as Error).message);
        processorRef.current?.stop();
        processorRef.current = null;
        onError();
        await teardown();
      }
    };
    void run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOn, bgSel.id, bgSel.mode.kind]);

  // Tear the pipeline down on unmount so we don't leak a running processor.
  useEffect(() => () => { void teardown(); }, [teardown]);
}

/** Apply persisted device selections to a live LiveKit room. */
async function applyDevicePrefsToRoom(room: LkRoom, prefs: DevicePrefs): Promise<void> {
  if (prefs.audioInput) {
    try { await room.switchActiveDevice("audioinput", prefs.audioInput); } catch { /* ignore */ }
  }
  if (prefs.videoInput) {
    try { await room.switchActiveDevice("videoinput", prefs.videoInput); } catch { /* ignore */ }
  }
  if (prefs.audioOutput) {
    try { await room.switchActiveDevice("audiooutput", prefs.audioOutput); } catch { /* ignore */ }
  }
}

function BulldogMeetingUI({ code }: { code: string }) {
  const [, navigate] = useLocation();
  const m = useMeeting();
  const { toast } = useToast();

  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();

  const [elapsed, setElapsed] = useState(0);
  const [sidebar, setSidebar] = useState<SidebarTab | null>(null);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const [showChip, setShowChip] = useState(true);
  const reactionId = useRef(0);

  const micOn = localParticipant?.isMicrophoneEnabled ?? false;
  const camOn = localParticipant?.isCameraEnabled ?? false;
  const [handRaised, setHandRaised] = useState(false);
  const [sharing, setSharing] = useState(false);

  // Annotation pipeline state. The annotator lives only while we're sharing
  // through the canvas pipeline (Chromium/Firefox). On Edge we fall back to
  // a plain LiveKit share and these stay null.
  const annotatorRef = useRef<ScreenShareAnnotator | null>(null);
  const sharingPubRef = useRef<LocalVideoTrack | null>(null);
  const [annTool, setAnnTool] = useState<SharingAnnotationTool>("off");
  // We snapshot this once per share session so the toolbar doesn't flicker
  // if the annotator is torn down mid-render.
  const [annAvailable, setAnnAvailable] = useState(false);
  // What kind of surface the user picked in the share dialog ("monitor" =
  // entire screen). We thread this into SharingFloatingBar so it knows
  // whether to auto-open the Document PiP toolbar.
  const [shareSurface, setShareSurface] = useState<"monitor" | "window" | "browser" | null>(null);

  // Background effects + device settings.
  const canBlur = useMemo(() => blurSupported(), []);
  const [bgOpen, setBgOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bgSel, setBgSel] = useState<BgSelection>(() =>
    canBlur ? loadSavedSelection() : { id: "none", mode: { kind: "none" } },
  );
  const [devicePrefs, setDevicePrefs] = useState<DevicePrefs>(() => loadDevicePrefs());

  useMeetBackground(room, camOn, canBlur ? bgSel : { id: "none", mode: { kind: "none" } }, () => {
    setBgSel({ id: "none", mode: { kind: "none" } });
    toast({ title: "Background effects unavailable", description: "Falling back to your camera.", variant: "destructive" });
  });

  // Apply audio output preference once the room is connected. Note: we do
  // NOT touch videoinput/audioinput here — the prejoin handoff already
  // publishes tracks on the user-selected devices, and calling
  // switchActiveDevice before the publish effect runs causes a race that
  // leaves the camera tile as a black box (the camera track gets detached
  // before it's been published).
  useEffect(() => {
    if (devicePrefs.audioOutput) {
      room.switchActiveDevice("audiooutput", devicePrefs.audioOutput).catch(() => { /* ignore */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // Publish mic/cam on room connect. STRONGLY PREFER the prejoin tracks
  // handed off via m.prejoinTracksRef — publishTrack on an already-acquired
  // LocalAudioTrack/LocalVideoTrack does NOT re-invoke getUserMedia, so it
  // preserves the click-gesture context iOS WebKit requires.
  //
  // Fallback path (no prejoin tracks): user navigated directly to /r/<code>.
  // Use setMicrophone/CameraEnabled; iOS may need a manual toggle in that
  // case, but that's the rarer flow.
  useEffect(() => {
    if (!localParticipant) return;
    const handed = m.prejoinTracksRef.current;
    // Take ownership exactly once — clear refs so a re-mount of this
    // component (e.g. Strict Mode double-invoke in dev) doesn't try to
    // publish the same track twice.
    m.prejoinTracksRef.current = { audio: null, video: null };

    const prefs = loadDevicePrefs();
    let cancelled = false;

    (async () => {
      // Defensive cleanup: unpublish ANY existing Camera/Microphone tracks
      // on the local participant BEFORE publishing fresh ones. This is the
      // "N tiles for one user" fix — when a prior tab/connection left
      // orphan publications attached to this identity in the LiveKit room,
      // reconnecting with the same identity inherits those publications.
      // useTracks(Camera, withPlaceholder:true) then renders one tile per
      // publication — so 1 real user = 6 tiles. Unpublishing first guarantees
      // exactly one published Camera + Microphone track per real publish.
      const stalePubs = Array.from(localParticipant.trackPublications.values()).filter(
        (pub) => pub.source === Track.Source.Camera || pub.source === Track.Source.Microphone,
      );
      if (stalePubs.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[meet] unpublishing ${stalePubs.length} stale local track(s) before re-publishing`);
      }
      for (const pub of stalePubs) {
        try {
          if (pub.track) {
            await localParticipant.unpublishTrack(pub.track, true);
          }
        } catch (e) {
          console.warn("[meet] failed to unpublish stale track:", e);
        }
      }
      if (cancelled) return;

      // ---- Audio ----
      if (handed.audio) {
        try {
          await localParticipant.publishTrack(handed.audio);
          // Apply mute state — setMicrophoneEnabled on an already-published
          // track only flips the enabled flag; no new getUserMedia.
          if (!cancelled) {
            await localParticipant.setMicrophoneEnabled(m.micEnabled);
          }
        } catch (e) {
          console.error("[meet] failed to publish prejoin mic:", e);
          // Last-resort fallback if publish fails.
          if (!cancelled) {
            void localParticipant.setMicrophoneEnabled(m.micEnabled, {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              ...(prefs.audioInput ? { deviceId: prefs.audioInput } : {}),
            }).catch(() => { /* best-effort */ });
          }
        }
      } else {
        // No prejoin handoff — fall back to the old behaviour.
        void localParticipant.setMicrophoneEnabled(m.micEnabled, {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(prefs.audioInput ? { deviceId: prefs.audioInput } : {}),
        }).catch(() => { /* best-effort */ });
      }

      // ---- Video ----
      if (handed.video) {
        try {
          await localParticipant.publishTrack(handed.video);
          if (!cancelled) {
            await localParticipant.setCameraEnabled(m.camEnabled);
          }
        } catch (e) {
          console.error("[meet] failed to publish prejoin camera:", e);
          if (!cancelled) {
            void localParticipant.setCameraEnabled(m.camEnabled, {
              ...(prefs.videoInput ? { deviceId: prefs.videoInput } : {}),
              resolution: { width: 1280, height: 720, frameRate: 30 },
            }).catch(() => { /* best-effort */ });
          }
        }
      } else {
        void localParticipant.setCameraEnabled(m.camEnabled, {
          ...(prefs.videoInput ? { deviceId: prefs.videoInput } : {}),
          resolution: { width: 1280, height: 720, frameRate: 30 },
        }).catch(() => { /* best-effort */ });
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!localParticipant]);

  const onDeviceChange = (kind: keyof DevicePrefs, deviceId: string) => {
    const next = { ...devicePrefs, [kind]: deviceId };
    setDevicePrefs(next);
    saveDevicePrefs(next);
    const map: Record<keyof DevicePrefs, MediaDeviceKind> = {
      audioInput: "audioinput",
      videoInput: "videoinput",
      audioOutput: "audiooutput",
    };
    room.switchActiveDevice(map[kind], deviceId).catch(() => {
      toast({ title: "Couldn't switch device", variant: "destructive" });
    });
  };

  // ── Host lobby (server-side waiting room) ──
  const { user: authedUser } = useAuth();
  const { data: meetingData } = useQuery<{ meeting: { waitingRoom: boolean; title?: string } }>({
    queryKey: ["/api/meetings", code],
    enabled: !!code,
  });
  const waitingRoomOn = meetingData?.meeting?.waitingRoom ?? false;
  // Only authed org members can act as a host; the GET /lobby endpoint is
  // org-gated server-side, so a 403 for cross-org users is handled gracefully.
  const isHost = !!authedUser;
  const lobbyEnabled = waitingRoomOn && isHost;

  const [lobbyOpen, setLobbyOpen] = useState(false);
  const [pending, setPending] = useState<LobbyKnock[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const knownKnockIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!lobbyEnabled) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await apiRequest<{ pending: LobbyKnock[] }>("GET", `/api/meetings/${code}/lobby`);
        if (cancelled) return;
        const list = data.pending ?? [];
        // Toast on genuinely new knocks (ids we haven't seen before).
        const fresh = list.filter((k) => !knownKnockIds.current.has(k.id));
        if (fresh.length > 0 && knownKnockIds.current.size > 0) {
          toast({ title: "Someone's waiting", description: `${fresh[0].displayName} wants to join.` });
        }
        knownKnockIds.current = new Set(list.map((k) => k.id));
        setPending(list);
      } catch {
        // 403 (cross-org) or transient error — leave the panel empty.
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobbyEnabled, code]);

  const decide = async (knockId: string, action: "admit" | "deny") => {
    setActing(knockId);
    setPending((cur) => cur.filter((k) => k.id !== knockId));
    try {
      await apiRequest("POST", `/api/meetings/${code}/lobby/${knockId}/${action}`);
    } catch {
      toast({ title: "Couldn't update the lobby", variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const origin = m.origin;
  const chipLabel = ORIGIN_CHIP[origin];

  // Screen-share detection still uses useTracks because (a) it has no
  // placeholder behavior to worry about, and (b) we want both subscribed
  // and unsubscribed states. The Camera tile grid is built below from
  // useParticipants() directly to avoid the useTracks(withPlaceholder:true)
  // multiplication bug that produced 7 tiles for 1 user.
  const screenShareTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false },
  );

  const remoteScreenShare = screenShareTracks.some(
    (t) =>
      t.source === Track.Source.ScreenShare &&
      t.participant?.identity !== localParticipant?.identity,
  );

  useEffect(() => {
    m.setParticipantCount(participants.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants.length]);

  useEffect(() => {
    const id = setInterval(() => {
      if (m.connectedAt) {
        setElapsed(Math.floor((Date.now() - m.connectedAt) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.connectedAt]);

  const { send: sendReaction } = useDataChannel("bulldog-reactions", (msg) => {
    try {
      const payload = JSON.parse(new TextDecoder().decode(msg.payload)) as {
        emoji: string;
      };
      spawnFloating(payload.emoji);
    } catch {
      /* ignore */
    }
  });

  function spawnFloating(emoji: string) {
    const id = reactionId.current++;
    setFloating((f) => [...f, { id, emoji, left: 20 + Math.random() * 60 }]);
    setTimeout(() => setFloating((f) => f.filter((r) => r.id !== id)), 2600);
  }

  const fireReaction = (emoji: string) => {
    spawnFloating(emoji);
    setReactionsOpen(false);
    try {
      const data = new TextEncoder().encode(
        JSON.stringify({ emoji, fromIdentity: localParticipant?.identity, timestamp: Date.now() }),
      );
      sendReaction(data, {});
    } catch {
      /* ignore */
    }
  };

  const toggleMic = () => localParticipant?.setMicrophoneEnabled(!micOn);
  const toggleCam = () => localParticipant?.setCameraEnabled(!camOn);

  // Stop helper used by both manual toggle and the native "Stop sharing" bar.
  // Tears down the annotator + unpublishes the manual track, then resets UI.
  const stopSharing = useCallback(async () => {
    const lp = localParticipant;
    const pub = sharingPubRef.current;
    if (lp && pub) {
      try { await lp.unpublishTrack(pub, true); } catch { /* ignore */ }
    }
    sharingPubRef.current = null;
    if (annotatorRef.current) {
      try { annotatorRef.current.stop(); } catch { /* ignore */ }
      annotatorRef.current = null;
    }
    // If LiveKit owns the track (fallback path), let it stop it.
    try { await lp?.setScreenShareEnabled(false); } catch { /* ignore */ }
    setSharing(false);
    setAnnTool("off");
    setAnnAvailable(false);
    setShareSurface(null);
  }, [localParticipant]);

  const toggleShare = async () => {
    if (sharing) {
      await stopSharing();
      return;
    }
    if (remoteScreenShare) {
      toast({ title: "Someone is already sharing", description: "Only one screen share at a time." });
      return;
    }
    const lp = localParticipant;
    if (!lp) return;

    // Edge / older browsers: canvas.captureStream is unreliable, so we skip
    // the annotation pipeline entirely and let LiveKit do its native flow.
    if (!annotationsSupported()) {
      try {
        await lp.setScreenShareEnabled(true);
        setSharing(true);
        setAnnAvailable(false);
        // We don't own the raw track in the fallback path, but we can read
        // the displaySurface off the LiveKit-published screen-share track.
        try {
          const pub = lp.getTrackPublication(Track.Source.ScreenShare);
          const raw = pub?.track?.mediaStreamTrack;
          type DS = MediaTrackSettings & { displaySurface?: string };
          const s = (raw?.getSettings?.() as DS | undefined)?.displaySurface;
          if (s === "monitor" || s === "window" || s === "browser") {
            setShareSurface(s);
          } else {
            setShareSurface(null);
          }
        } catch {
          setShareSurface(null);
        }
        toast({ title: "Screen share started" });
      } catch {
        toast({ title: "Screen share cancelled" });
        setSharing(false);
      }
      return;
    }

    // Annotation-capable path. We acquire the display media ourselves so we
    // can wrap it in a canvas, then publish the canvas output through LiveKit.
    try {
      const raw = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
      });
      const annotator = new ScreenShareAnnotator(raw);
      annotator.onTrackEnded = () => {
        // The user clicked the browser's native "Stop sharing" bar.
        void stopSharing();
      };
      annotator.start();
      const lkTrack = new LocalVideoTrack(annotator.outputTrack);
      await lp.publishTrack(lkTrack, {
        source: Track.Source.ScreenShare,
        name: "screen_share",
      });
      annotatorRef.current = annotator;
      sharingPubRef.current = lkTrack;
      setSharing(true);
      setAnnAvailable(true);
      setShareSurface(annotator.displaySurface);
      // Annotation hint depends on what the user picked. For window / browser-tab
      // shares the OS routes pointer events to the shared surface (not Bulldog),
      // so laser + highlighter only draw while the cursor is over the Bulldog
      // window itself. Make that explicit so users don't think it's broken.
      const surf = annotator.displaySurface;
      const isWholeScreen = surf === "monitor" || surf == null;
      toast({
        title: "Screen share started",
        description: isWholeScreen
          ? "Floating bar has laser pointer & highlighter — drag it anywhere."
          : "Laser & highlighter only draw while your cursor is over the Bulldog window. To annotate over your shared window, switch to sharing your whole screen.",
      });
    } catch (err) {
      // User cancelled the picker, or the annotator failed to initialize.
      // Either way: clean up anything we partially set up.
      if (annotatorRef.current) {
        try { annotatorRef.current.stop(); } catch { /* ignore */ }
        annotatorRef.current = null;
      }
      sharingPubRef.current = null;
      setSharing(false);
      setAnnAvailable(false);
      const cancelled = (err as DOMException | undefined)?.name === "NotAllowedError";
      toast({ title: cancelled ? "Screen share cancelled" : "Screen share failed" });
    }
  };

  // Push tool selection into the annotator whenever it changes.
  useEffect(() => {
    annotatorRef.current?.setTool(annTool);
  }, [annTool]);

  // Forward pointer movement (and highlighter drag) into the annotator using
  // normalized [0..1] coords relative to the viewport. We bind on window so
  // we still receive moves when the cursor is over child elements (LiveKit's
  // own DOM, the floating bar, etc.). The annotator ignores cursor input
  // when the tool is "off".
  useEffect(() => {
    if (!sharing || annTool === "off" || !annotatorRef.current) return;
    const ann = annotatorRef.current;
    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / Math.max(1, window.innerWidth);
      const ny = e.clientY / Math.max(1, window.innerHeight);
      ann.setCursor(nx, ny);
    };
    const onDown = (e: PointerEvent) => {
      if (annTool !== "highlighter") return;
      // Skip clicks that land on the floating toolbar so users can press
      // buttons (Clear / tool toggle) without starting a stroke.
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-testid="sharing-floating-bar"]')) return;
      ann.beginStroke();
    };
    const onUp = () => {
      if (annTool === "highlighter") ann.endStroke();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [sharing, annTool]);

  // Defensive: if the user navigates away while sharing, release the tracks.
  useEffect(() => {
    return () => {
      if (annotatorRef.current) {
        try { annotatorRef.current.stop(); } catch { /* ignore */ }
        annotatorRef.current = null;
      }
    };
  }, []);

  const toggleHand = async () => {
    const next = !handRaised;
    setHandRaised(next);
    try {
      await localParticipant?.setAttributes({ handRaised: next ? "true" : "" });
    } catch {
      /* attributes optional */
    }
  };

  const leave = () => {
    m.setLastDuration(elapsed);
    if (m.identity) {
      apiRequest("POST", `/api/meetings/${code}/leave`, { identity: m.identity }).catch(() => {});
    }
    room.disconnect();
    // After disconnect, send the user back to chat (the channel they came
    // from). The meeting was opened in a new window in most flows, so we
    // ALSO try window.close() — if this tab was script-opened (the new
    // window/tab path), it'll close cleanly. If it was a top-level
    // navigation (deep-link from SMS, refresh, etc.), close() is a no-op
    // and the route change to /#/ keeps the user productive instead of
    // stranded on a disconnected /r/<code> page.
    try { window.close(); } catch { /* ignore */ }
    // Hash-router setter — navigate to the chat home. window.close() above
    // either succeeds (and this never runs) or is a no-op (and we navigate).
    navigate("/");
  };

  const openTab = (tab: SidebarTab) => setSidebar((cur) => (cur === tab ? null : tab));

  // Render-from-participants: one Camera tile per participant in the room,
  // PLUS any active ScreenShare publications. This is the fix for the
  // "N tiles for 1 user" bug — useTracks(Camera, withPlaceholder:true) was
  // returning N entries for a single participant whenever the local
  // trackPublications map contained stale publications from prior failed
  // join attempts. By driving the grid off participants directly (the
  // same source the header counter uses), tile count is GUARANTEED to
  // equal the participant count.
  //
  // For each participant we look up their primary Camera publication via
  // getTrackPublication(); if absent we render a placeholder (camera off /
  // not yet published). StageTile and StripTile already handle both cases.
  const cameraTracks: TrackReferenceOrPlaceholder[] = useMemo(() => {
    const refs: TrackReferenceOrPlaceholder[] = [];
    for (const p of participants) {
      const pub = p.getTrackPublication(Track.Source.Camera);
      refs.push({
        participant: p,
        source: Track.Source.Camera,
        publication: pub,
      } as TrackReferenceOrPlaceholder);
    }
    // Add any active screen-share publications on top so they take the stage.
    for (const t of screenShareTracks) {
      refs.push(t);
    }
    return refs;
  }, [participants, screenShareTracks]);

  const sorted = useMemo(() => sortTracks(cameraTracks), [cameraTracks]);
  const main = sorted[0];
  const strip = sorted.slice(1);
  const title = m.title || "Meeting";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* TOP BAR */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-center gap-2">
            <BulldogMark size={24} />
            <span className="hidden font-display text-sm font-bold tracking-tight sm:inline">
              Bulldog <span className="text-primary">Meet</span>
            </span>
          </div>
          <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground" data-testid="text-meeting-code">
            {code}
          </span>
        </div>
        <div className="hidden flex-1 truncate text-center font-display text-sm font-semibold md:block" data-testid="text-meeting-title">
          {title}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm tabular-nums text-muted-foreground" data-testid="text-elapsed">
            {fmt(elapsed)}
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground" data-testid="text-participant-count">
            <Users size={13} /> {participants.length}
          </span>
          <ThemeToggle />
        </div>
      </header>

      {/* BODY */}
      <div className="flex min-h-0 flex-1">
        <main className="relative flex min-w-0 flex-1 flex-col p-3 sm:p-4">
          <AnimatePresence>
            {showChip && chipLabel && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="absolute left-5 top-5 z-20 flex items-center gap-2 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur"
                data-testid="chip-origin"
              >
                <PlatformLogo origin={origin} size={14} />
                <span>{chipLabel}</span>
                <button
                  data-testid="button-dismiss-chip"
                  onClick={() => setShowChip(false)}
                  aria-label="Dismiss"
                  className="ml-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X size={13} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* main stage */}
          <div className="relative min-h-0 flex-1">
            {main ? (
              <StageTile trackRef={main} />
            ) : (
              <div className="flex h-full items-center justify-center rounded-xl bg-slate-900 text-slate-400">
                Connecting to participants…
              </div>
            )}

            <AnimatePresence>
              {floating.map((r) => (
                <motion.div
                  key={r.id}
                  initial={{ opacity: 0, y: 0, scale: 0.6 }}
                  animate={{ opacity: 1, y: -260, scale: 1.3 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 2.4, ease: "easeOut" }}
                  className="pointer-events-none absolute bottom-6 z-30 text-4xl"
                  style={{ left: `${r.left}%` }}
                >
                  {r.emoji}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {strip.length > 0 && (
            <div className="mt-3 grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
              {strip.map((t, i) => (
                <div key={`${t.participant?.identity}-${t.source}-${i}`} className="aspect-video">
                  <StripTile trackRef={t} />
                </div>
              ))}
            </div>
          )}
        </main>

        <MeetingSidebar tab={sidebar} onClose={() => setSidebar(null)} participants={participants} localIdentity={localParticipant?.identity} code={code} meetingTitle={meetingData?.meeting?.title} />
      </div>

      {/* BOTTOM CONTROL BAR */}
      <div className="shrink-0 px-3 pb-4 pt-2 sm:px-4">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-1.5 rounded-2xl bg-[hsl(220_16%_12%)] px-3 py-2.5 shadow-lg ring-1 ring-white/10">
          {/* Mic + caret split-button (Teams-style). The caret opens a compact
              popover to switch between available microphones without leaving
              the call. The gear button on the right still shows the full
              Devices modal with camera+speaker as well. */}
          {/* Mic + camera with INLINE labeled device pills so users can see
              (and switch) the active device without leaving the call. The
              prior chevron caret was a 5px target; the pill shows the
              device label and acts as the switcher. The gear button on the
              right still opens the full Devices modal (mic+cam+speaker). */}
          <BarBtn testid="bar-mic" active={micOn} danger={!micOn} onClick={toggleMic} label={micOn ? "Mute" : "Unmute"}>
            {micOn ? <Mic size={18} /> : <MicOff size={18} />}
          </BarBtn>
          <DeviceSelector
            kind="audioInput"
            prefs={devicePrefs}
            onPick={(deviceId) => onDeviceChange("audioInput", deviceId)}
            variant="pill"
          />
          <BarBtn testid="bar-cam" active={camOn} danger={!camOn} onClick={toggleCam} label={camOn ? "Stop video" : "Start video"}>
            {camOn ? <Video size={18} /> : <VideoOff size={18} />}
          </BarBtn>
          <DeviceSelector
            kind="videoInput"
            prefs={devicePrefs}
            onPick={(deviceId) => onDeviceChange("videoInput", deviceId)}
            variant="pill"
          />
          <BarBtn
            testid="bar-share"
            active={sharing}
            onClick={toggleShare}
            label={remoteScreenShare ? "Someone is sharing" : "Share screen"}
          >
            <MonitorUp size={18} />
          </BarBtn>

          <div className="relative">
            <BarBtn
              testid="bar-background"
              active={bgOpen || bgSel.id !== "none"}
              onClick={() => {
                if (!canBlur) {
                  toast({ title: "Background effects unavailable", description: "Not supported on this browser." });
                  return;
                }
                setBgOpen((o) => !o);
              }}
              label={canBlur ? "Background effects" : "Background effects (unavailable on this device)"}
            >
              <Aperture size={18} />
            </BarBtn>
            <AnimatePresence>
              {bgOpen && canBlur && (
                <VirtualBackgroundPicker
                  current={bgSel}
                  onSelect={(sel) => setBgSel(sel)}
                  onClose={() => setBgOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>

          {/* Full Devices modal: mic + camera + speaker in one place. Now
              labeled 'Devices' so users find it without thinking it's the
              browser/account settings. */}
          <BarBtn testid="bar-settings" active={settingsOpen} onClick={() => setSettingsOpen(true)} label="Devices">
            <Settings size={18} />
          </BarBtn>

          {lobbyEnabled && (
            <div className="relative">
              <BarBtn testid="bar-lobby" active={lobbyOpen} onClick={() => setLobbyOpen((o) => !o)} label="Lobby">
                <DoorOpen size={18} />
              </BarBtn>
              {pending.length > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground ring-2 ring-[hsl(220_16%_12%)]"
                  data-testid="badge-lobby-count"
                >
                  {pending.length}
                </span>
              )}
              <AnimatePresence>
                {lobbyOpen && (
                  <LobbyPanel
                    pending={pending}
                    acting={acting}
                    onAdmit={(id) => decide(id, "admit")}
                    onDeny={(id) => decide(id, "deny")}
                    onClose={() => setLobbyOpen(false)}
                  />
                )}
              </AnimatePresence>
            </div>
          )}

          <div className="relative">
            <BarBtn testid="bar-reactions" active={reactionsOpen} onClick={() => setReactionsOpen((o) => !o)} label="Reactions">
              <Smile size={18} />
            </BarBtn>
            <AnimatePresence>
              {reactionsOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.95 }}
                  transition={{ duration: 0.18 }}
                  className="absolute bottom-14 left-1/2 flex -translate-x-1/2 gap-1 rounded-full border border-border bg-card px-2 py-1.5 shadow-lg"
                  data-testid="popover-reactions"
                >
                  {REACTIONS.map((e) => (
                    <button
                      key={e}
                      data-testid={`reaction-${e}`}
                      onClick={() => fireReaction(e)}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-xl hover-elevate"
                    >
                      {e}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <BarBtn testid="bar-hand" active={handRaised} onClick={toggleHand} label="Raise hand">
            <Hand size={18} />
          </BarBtn>
          <BarBtn testid="bar-chat" active={sidebar === "chat"} onClick={() => openTab("chat")} label="Chat">
            <MessageSquare size={18} />
          </BarBtn>
          <BarBtn testid="bar-participants" active={sidebar === "participants"} onClick={() => openTab("participants")} label="Participants">
            <Users size={18} />
          </BarBtn>
          <BarBtn testid="bar-ai-notes" active={sidebar === "transcript"} onClick={() => openTab("transcript")} label="AI Notes" highlight>
            <Sparkles size={18} />
          </BarBtn>

          <button
            data-testid="button-leave"
            onClick={leave}
            className="ml-1 flex h-10 items-center gap-2 rounded-full bg-destructive px-4 text-sm font-semibold text-destructive-foreground hover-elevate"
          >
            <PhoneOff size={16} /> Leave
          </button>
        </div>

        {handRaised && (
          <div className="mx-auto mt-2 w-fit rounded-full bg-amber-400/95 px-3 py-1 text-xs font-semibold text-amber-950" data-testid="badge-self-hand">
            ✋ You raised your hand
          </div>
        )}
      </div>

      {settingsOpen && (
        <MeetSettingsModal
          prefs={devicePrefs}
          onChange={onDeviceChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* While the user is screen-sharing, the picker / shared app usually
          covers the Bulldog tab. Render a draggable always-visible floating
          bar with the essential controls so they don't have to alt-tab back. */}
      {sharing && (
        <SharingFloatingBar
          micOn={micOn}
          camOn={camOn}
          onToggleMic={toggleMic}
          onToggleCam={toggleCam}
          onStopShare={toggleShare}
          annotationsAvailable={annAvailable}
          tool={annTool}
          onSetTool={setAnnTool}
          onClearAnnotations={() => annotatorRef.current?.clearStrokes()}
          displaySurface={shareSurface}
        />
      )}
    </div>
  );
}

function LobbyPanel({
  pending, acting, onAdmit, onDeny, onClose,
}: {
  pending: LobbyKnock[];
  acting: string | null;
  onAdmit: (id: string) => void;
  onDeny: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ duration: 0.18 }}
      className="absolute bottom-14 left-1/2 w-72 -translate-x-1/2 rounded-xl border border-border bg-card p-2 shadow-lg"
      data-testid="popover-lobby"
    >
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-sm font-semibold">Waiting room</span>
        <button
          data-testid="button-close-lobby"
          onClick={onClose}
          aria-label="Close lobby"
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover-elevate"
        >
          <X size={15} />
        </button>
      </div>
      {pending.length === 0 ? (
        <p className="px-2 py-4 text-center text-sm text-muted-foreground" data-testid="text-lobby-empty">
          No one is waiting.
        </p>
      ) : (
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {pending.map((k) => (
            <div key={k.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5" data-testid={`lobby-knock-${k.id}`}>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{k.displayName}</span>
              <button
                data-testid={`button-admit-${k.id}`}
                disabled={acting === k.id}
                onClick={() => onAdmit(k.id)}
                title="Admit"
                aria-label={`Admit ${k.displayName}`}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground hover-elevate disabled:opacity-50"
              >
                <Check size={15} />
              </button>
              <button
                data-testid={`button-deny-${k.id}`}
                disabled={acting === k.id}
                onClick={() => onDeny(k.id)}
                title="Deny"
                aria-label={`Deny ${k.displayName}`}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover-elevate disabled:opacity-50"
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function sortTracks(tracks: TrackReferenceOrPlaceholder[]): TrackReferenceOrPlaceholder[] {
  return [...tracks].sort((a, b) => {
    const aShare = a.source === Track.Source.ScreenShare ? 1 : 0;
    const bShare = b.source === Track.Source.ScreenShare ? 1 : 0;
    if (aShare !== bShare) return bShare - aShare;
    const aSpoke = a.participant?.lastSpokeAt?.getTime?.() ?? 0;
    const bSpoke = b.participant?.lastSpokeAt?.getTime?.() ?? 0;
    return bSpoke - aSpoke;
  });
}

function QualityDot({ p }: { p?: Participant }) {
  const q = p?.connectionQuality;
  const color =
    q === ConnectionQuality.Excellent || q === ConnectionQuality.Good
      ? "bg-emerald-400"
      : q === ConnectionQuality.Poor
        ? "bg-rose-400"
        : "bg-amber-400";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} title="Connection quality" />;
}

function TileChrome({
  trackRef, large,
}: { trackRef: TrackReferenceOrPlaceholder; large: boolean }) {
  const p = trackRef.participant;
  const name = p?.name || p?.identity || "Guest";
  const micEnabled = p?.isMicrophoneEnabled ?? false;
  const isShare = trackRef.source === Track.Source.ScreenShare;
  const handRaised = p?.attributes?.handRaised === "true";
  const speaking = p?.isSpeaking ?? false;
  const hasVideo =
    isTrackReference(trackRef) && !!trackRef.publication && !trackRef.publication.isMuted;

  // Subscribe to the local-only "stage glow" toggle (Settings → Stage glow).
  // Stored in localStorage; we re-read on the bulldog:meet-prefs-changed
  // window event so the toggle takes effect instantly across all open tiles.
  const [stageGlow, setStageGlow] = useState<boolean>(() => loadMeetPrefs().stageGlow);
  useEffect(() => {
    const onChange = () => setStageGlow(loadMeetPrefs().stageGlow);
    window.addEventListener(MEET_PREFS_EVENT, onChange);
    return () => window.removeEventListener(MEET_PREFS_EVENT, onChange);
  }, []);

  return (
    <div
      className={`relative h-full w-full overflow-hidden rounded-xl bg-slate-900 ring-1 ring-black/10 dark:ring-white/10 ${
        speaking ? "outline outline-2 outline-primary" : ""
      }`}
      data-testid={isShare ? "tile-screenshare" : `tile-${p?.identity}`}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef as any}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-800">
          <div className={`flex items-center justify-center rounded-full bg-slate-600 font-display font-semibold text-white ${large ? "h-20 w-20 text-2xl" : "h-10 w-10 text-sm"}`}>
            {initials(name)}
          </div>
        </div>
      )}

      {stageGlow && (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/10" />
      )}

      {handRaised && (
        <div className={`absolute ${large ? "left-3 top-3" : "left-1.5 top-1.5"} flex items-center gap-1 rounded-full bg-amber-400/95 px-2 py-0.5 text-xs font-semibold text-amber-950 shadow`}>
          <span aria-hidden>✋</span>
        </div>
      )}

      <div className={`absolute ${large ? "right-3 top-3" : "right-1.5 top-1.5"}`}>
        <QualityDot p={p} />
      </div>

      <div className={`absolute bottom-0 left-0 right-0 flex items-center justify-between gap-2 ${large ? "px-3 py-2" : "px-2 py-1"}`}>
        <span className={`truncate font-medium text-white drop-shadow ${large ? "text-sm" : "text-xs"}`}>
          {name}{isShare ? " · screen" : ""}
        </span>
        <span className={`flex shrink-0 items-center justify-center rounded-full ${micEnabled ? "bg-white/20 text-white" : "bg-rose-500/90 text-white"} ${large ? "h-6 w-6" : "h-5 w-5"}`}>
          {micEnabled ? <Mic size={large ? 13 : 11} /> : <MicOff size={large ? 13 : 11} />}
        </span>
      </div>
    </div>
  );
}

function StageTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  return <TileChrome trackRef={trackRef} large />;
}
function StripTile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  return <TileChrome trackRef={trackRef} large={false} />;
}

const TABS: { id: SidebarTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "participants", label: "Participants" },
  { id: "transcript", label: "Transcript" },
];

function MeetingSidebar({
  tab, onClose, participants, localIdentity, code, meetingTitle,
}: {
  tab: SidebarTab | null;
  onClose: () => void;
  participants: Participant[];
  localIdentity?: string;
  code: string;
  meetingTitle?: string;
}) {
  return (
    <AnimatePresence>
      {tab && (
        <motion.aside
          initial={{ x: 340 }}
          animate={{ x: 0 }}
          exit={{ x: 340 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-card"
          data-testid="sidebar"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-2">
            <div className="flex">
              {TABS.map((t) => (
                <span
                  key={t.id}
                  data-testid={`tab-${t.id}`}
                  className={`relative px-3 py-3 text-sm font-medium ${tab === t.id ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {t.label}
                  {tab === t.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
                </span>
              ))}
            </div>
            <button
              data-testid="button-close-sidebar"
              onClick={onClose}
              aria-label="Close panel"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover-elevate"
            >
              <X size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1">
            {tab === "chat" && <ChatTab localIdentity={localIdentity} />}
            {tab === "participants" && <ParticipantsTab participants={participants} localIdentity={localIdentity} code={code} meetingTitle={meetingTitle} />}
            {tab === "transcript" && <TranscriptTab />}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Avatar({ name }: { name: string }) {
  const colors = ["#0F766E", "#155E75", "#334155", "#0E7490", "#115E59"];
  const idx = name.charCodeAt(0) % colors.length;
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ background: colors[idx] }}
    >
      {initials(name)}
    </span>
  );
}

function ChatTab({ localIdentity }: { localIdentity?: string }) {
  const { chatMessages, send } = useChat();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft("");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" data-testid="chat-thread">
        {chatMessages.length === 0 && (
          <p className="mt-6 text-center text-sm text-muted-foreground">No messages yet. Say hello 👋</p>
        )}
        {chatMessages.map((msg, i) => {
          const isLocal = msg.from?.identity === localIdentity;
          const author = isLocal ? "You" : msg.from?.name || msg.from?.identity || "Guest";
          const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          return (
            <div key={msg.id ?? i} className="flex gap-2.5" data-testid={`message-${i}`}>
              <Avatar name={author} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold">{author}</span>
                  <span className="text-[11px] text-muted-foreground">{time}</span>
                </div>
                <p className="mt-0.5 break-words text-sm text-foreground/90">{msg.message}</p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5">
          <Smile size={18} className="text-muted-foreground" />
          <input
            data-testid="input-chat"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Send a message to everyone"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            data-testid="button-send"
            onClick={submit}
            aria-label="Send"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground hover-elevate"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ParticipantsTab({ participants, localIdentity, code, meetingTitle }: { participants: Participant[]; localIdentity?: string; code: string; meetingTitle?: string }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <div className="flex h-full flex-col" data-testid="participants-list">
      {/* Mid-meeting invite — opens a picker dialog that fires SMS
          invites via POST /api/meetings/:code/invite. */}
      <div className="shrink-0 px-2 pt-2">
        <button
          onClick={() => setInviteOpen(true)}
          data-testid="button-open-invite-dialog"
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-sm font-medium text-foreground hover-elevate"
        >
          <UserPlus size={14} />
          Invite people
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
      {participants.map((p) => {
        const name = (p.identity === localIdentity ? `${p.name || p.identity} (You)` : p.name || p.identity) || "Guest";
        const handRaised = p.attributes?.handRaised === "true";
        return (
          <div key={p.identity} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover-elevate" data-testid={`participant-${p.identity}`}>
            <Avatar name={name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{name}</span>
                {handRaised && <span title="Hand raised">✋</span>}
                {!p.isMicrophoneEnabled && <MicOffIcon size={13} className="shrink-0 text-muted-foreground" />}
              </div>
            </div>
            <QualityDot p={p} />
          </div>
        );
      })}
      </div>
      <InviteToMeetingDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        code={code}
        meetingTitle={meetingTitle}
      />
    </div>
  );
}

function TranscriptTab() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" data-testid="transcript-empty">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-primary">
        <Sparkles size={22} />
      </div>
      <h3 className="font-display text-base font-semibold">AI notes coming soon</h3>
      <p className="text-sm text-muted-foreground">
        Live transcript &amp; meeting summary will appear here. A summary is emailed to recipients
        when the meeting ends.
      </p>
    </div>
  );
}

function BarBtn({
  children, active, danger, highlight, onClick, label, testid,
}: {
  children: React.ReactNode;
  active: boolean;
  danger?: boolean;
  highlight?: boolean;
  onClick: () => void;
  label: string;
  testid: string;
}) {
  const base = "relative flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-200";
  let tone = "text-white/85 hover:bg-white/10";
  if (danger && active) tone = "bg-destructive text-destructive-foreground";
  else if (active) tone = "bg-white/15 text-white";
  if (highlight && !active) tone = "text-primary hover:bg-primary/15";

  return (
    <button data-testid={testid} onClick={onClick} title={label} aria-label={label} className={`${base} ${tone}`}>
      {children}
      {highlight && (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-[hsl(220_16%_12%)]" />
      )}
    </button>
  );
}
