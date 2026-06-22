import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useLocation, useRoute } from "wouter";
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
import { Track, ConnectionQuality, LocalVideoTrack, type Participant, type Room as LkRoom } from "livekit-client";
import "@livekit/components-styles";
import {
  Mic, MicOff, Video, VideoOff, MonitorUp, Hand, MessageSquare, Users, Sparkles,
  X, Smile, PhoneOff, Send, MicOff as MicOffIcon, Aperture, Settings,
} from "lucide-react";
import { BulldogMark, PlatformLogo, initials } from "@/components/BulldogLogo";
import { ThemeToggle } from "@/components/MeetingThemeToggle";
import { useToast } from "@/hooks/use-toast";
import { useMeeting, ORIGIN_CHIP } from "@/lib/meeting";
import { apiRequest } from "@/lib/queryClient";
import { VirtualBackgroundProcessor } from "@/lib/virtual-background";
import {
  VirtualBackgroundPicker,
  loadSavedSelection,
  type BgSelection,
} from "@/components/call/VirtualBackgroundPicker";
import { MeetSettingsModal } from "@/components/call/MeetSettingsModal";
import { blurSupported, loadDevicePrefs, saveDevicePrefs, type DevicePrefs } from "@/lib/meet-devices";

const REACTIONS = ["👍", "❤️", "😂", "🎉", "👏"];
type SidebarTab = "chat" | "participants" | "transcript";

interface FloatingReaction {
  id: number;
  emoji: string;
  left: number;
}

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

  return (
    <LiveKitRoom
      serverUrl={m.wsUrl}
      token={m.token}
      connect={true}
      video={m.camEnabled}
      audio={m.micEnabled}
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

  // Apply any persisted device selection once the room is connected.
  useEffect(() => {
    void applyDevicePrefsToRoom(room, devicePrefs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

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

  const origin = m.origin;
  const chipLabel = ORIGIN_CHIP[origin];

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  const remoteScreenShare = tracks.some(
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

  const toggleShare = async () => {
    if (remoteScreenShare) {
      toast({ title: "Someone is already sharing", description: "Only one screen share at a time." });
      return;
    }
    try {
      const next = !sharing;
      await localParticipant?.setScreenShareEnabled(next);
      setSharing(next);
      if (next) toast({ title: "Screen share started" });
    } catch {
      toast({ title: "Screen share cancelled" });
      setSharing(false);
    }
  };

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
  };

  const openTab = (tab: SidebarTab) => setSidebar((cur) => (cur === tab ? null : tab));

  const cameraTracks = tracks.filter(
    (t) => t.source === Track.Source.Camera || t.source === Track.Source.ScreenShare,
  );

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

        <MeetingSidebar tab={sidebar} onClose={() => setSidebar(null)} participants={participants} localIdentity={localParticipant?.identity} />
      </div>

      {/* BOTTOM CONTROL BAR */}
      <div className="shrink-0 px-3 pb-4 pt-2 sm:px-4">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-1.5 rounded-2xl bg-[hsl(220_16%_12%)] px-3 py-2.5 shadow-lg ring-1 ring-white/10">
          <BarBtn testid="bar-mic" active={micOn} danger={!micOn} onClick={toggleMic} label={micOn ? "Mute" : "Unmute"}>
            {micOn ? <Mic size={18} /> : <MicOff size={18} />}
          </BarBtn>
          <BarBtn testid="bar-cam" active={camOn} danger={!camOn} onClick={toggleCam} label={camOn ? "Stop video" : "Start video"}>
            {camOn ? <Video size={18} /> : <VideoOff size={18} />}
          </BarBtn>
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

          <BarBtn testid="bar-settings" active={settingsOpen} onClick={() => setSettingsOpen(true)} label="Settings">
            <Settings size={18} />
          </BarBtn>

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
    </div>
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

      <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/10" />

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
  tab, onClose, participants, localIdentity,
}: {
  tab: SidebarTab | null;
  onClose: () => void;
  participants: Participant[];
  localIdentity?: string;
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
            {tab === "participants" && <ParticipantsTab participants={participants} localIdentity={localIdentity} />}
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

function ParticipantsTab({ participants, localIdentity }: { participants: Participant[]; localIdentity?: string }) {
  return (
    <div className="h-full overflow-y-auto px-2 py-2" data-testid="participants-list">
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
