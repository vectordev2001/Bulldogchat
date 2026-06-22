import { useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  createLocalVideoTrack,
  createLocalAudioTrack,
  type LocalVideoTrack,
  type LocalAudioTrack,
} from "livekit-client";
import {
  Mic, MicOff, Video, VideoOff, Sparkles, Settings, Aperture, Loader2, VideoOff as VideoOffIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BulldogWordmark, PlatformLogo } from "@/components/BulldogLogo";
import { ThemeToggle } from "@/components/MeetingThemeToggle";
import { useToast } from "@/hooks/use-toast";
import {
  useMeeting, parseOrigin, getHashSearch, ORIGIN_BANNER, type Origin,
} from "@/lib/meeting";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { VirtualBackgroundProcessor } from "@/lib/virtual-background";
import {
  VirtualBackgroundPicker,
  loadSavedSelection,
  type BgSelection,
} from "@/components/call/VirtualBackgroundPicker";
import { MeetSettingsModal } from "@/components/call/MeetSettingsModal";
import { blurSupported, loadDevicePrefs, saveDevicePrefs, type DevicePrefs } from "@/lib/meet-devices";

interface MeetingMeta {
  code: string;
  title: string | null;
  status: string;
  recordingEnabled: boolean;
  transcriptEnabled: boolean;
  waitingRoom: boolean;
  scheduledStartAt: number | null;
}

interface JoinResponse {
  token: string;
  identity: string;
  roomName: string;
  ws_url: string;
  meeting: MeetingMeta;
}

type KnockStatus = "pending" | "admitted" | "denied" | "expired" | "cancelled";

interface KnockResponse {
  knockId?: string;
  status?: KnockStatus;
  pollIntervalMs?: number;
  // Waiting-room-off shortcut: full join payload alongside `admitted: true`.
  admitted?: boolean;
  token?: string;
  identity?: string;
  roomName?: string;
  ws_url?: string;
  meeting?: MeetingMeta;
}

type LobbyState =
  | { phase: "idle" }
  | { phase: "waiting"; knockId: string; pollIntervalMs: number; displayName: string }
  | { phase: "denied" }
  | { phase: "expired"; displayName: string };

export default function Join() {
  const [, params] = useRoute("/m/:code");
  const [, navigate] = useLocation();
  const code = (params?.code ?? "").split("?")[0];
  const m = useMeeting();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const { user: authedUser } = useAuth();

  const [localName, setLocalName] = useState(m.displayName ?? "");
  const [joining, setJoining] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [lobby, setLobby] = useState<LobbyState>({ phase: "idle" });

  // GET /api/meetings/:code → { meeting: {...} }
  const { data, isLoading, isError, error } = useQuery<{ meeting: MeetingMeta }>({
    queryKey: ["/api/meetings", code],
    enabled: !!code,
  });
  const meta = data?.meeting;
  const notFound = isError && /(^|\s)404/.test(String((error as Error)?.message || ""));

  useEffect(() => {
    const origin = parseOrigin(getHashSearch());
    m.setOrigin(origin);
    m.setCode(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    if (meta?.title) m.setTitle(meta.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.title]);

  const origin: Origin = m.origin;

  // ---- live preview tracks ----
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrackRef = useRef<LocalVideoTrack | null>(null);
  const audioTrackRef = useRef<LocalAudioTrack | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [permDenied, setPermDenied] = useState(false);
  const [level, setLevel] = useState(0);

  // Background effects + device settings for the preview / carried into the call.
  const canBlur = blurSupported();
  const [bgOpen, setBgOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bgSel, setBgSel] = useState<BgSelection>(() =>
    canBlur ? loadSavedSelection() : { id: "none", mode: { kind: "none" } },
  );
  const [devicePrefs, setDevicePrefs] = useState<DevicePrefs>(() => loadDevicePrefs());
  const bgProcRef = useRef<VirtualBackgroundProcessor | null>(null);
  // Bumped whenever the preview camera track is replaced (device switch) so the
  // background effect re-runs against the fresh track.
  const [previewEpoch, setPreviewEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const vt = await createLocalVideoTrack();
        if (cancelled) { vt.stop(); return; }
        videoTrackRef.current = vt;
        if (videoRef.current) vt.attach(videoRef.current);
        setCamOn(true);
      } catch {
        setCamOn(false);
        setPermDenied(true);
      }

      try {
        const at = await createLocalAudioTrack();
        if (cancelled) { at.stop(); return; }
        audioTrackRef.current = at;
        setMicOn(true);
        startMeter(at);
      } catch {
        setMicOn(false);
        setPermDenied(true);
      }
    })();

    return () => {
      cancelled = true;
      stopMeter();
      videoTrackRef.current?.stop();
      audioTrackRef.current?.stop();
      videoTrackRef.current = null;
      audioTrackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startMeter(track: LocalAudioTrack) {
    try {
      const mst = track.mediaStreamTrack;
      const stream = new MediaStream([mst]);
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const dataArr = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(dataArr);
        let sum = 0;
        for (let i = 0; i < dataArr.length; i++) {
          const v = (dataArr[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArr.length);
        setLevel(Math.min(1, rms * 3.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* meter optional */
    }
  }

  function stopMeter() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  const toggleMic = () => {
    const at = audioTrackRef.current;
    if (!at) {
      toast({ title: "Microphone unavailable", description: "Permission was blocked." });
      return;
    }
    const next = !micOn;
    if (next) at.unmute(); else at.mute();
    setMicOn(next);
    if (!next) setLevel(0);
  };

  const toggleCam = () => {
    const vt = videoTrackRef.current;
    if (!vt) {
      toast({ title: "Camera unavailable", description: "Permission was blocked." });
      return;
    }
    const next = !camOn;
    if (next) vt.unmute(); else vt.mute();
    setCamOn(next);
  };

  // Apply / revert the background effect on the live preview. The processor
  // reads the raw camera MediaStreamTrack and produces a canvas track we
  // attach to the preview <video>. Reverting re-attaches the raw track.
  useEffect(() => {
    let cancelled = false;
    const apply = async () => {
      const vt = videoTrackRef.current;
      const videoEl = videoRef.current;
      if (!vt || !videoEl) return;

      if (!camOn || bgSel.mode.kind === "none" || !canBlur) {
        if (bgProcRef.current) {
          bgProcRef.current.stop();
          bgProcRef.current = null;
          vt.attach(videoEl); // restore raw preview
        }
        return;
      }

      try {
        if (bgProcRef.current) {
          await bgProcRef.current.setMode(bgSel.mode);
          return;
        }
        const proc = new VirtualBackgroundProcessor();
        const processed = await proc.start(vt.mediaStreamTrack, bgSel.mode);
        if (cancelled) { proc.stop(); return; }
        bgProcRef.current = proc;
        videoEl.srcObject = new MediaStream([processed]);
        await videoEl.play().catch(() => {});
      } catch (err) {
        console.warn("[meet] preview background unavailable:", (err as Error).message);
        bgProcRef.current?.stop();
        bgProcRef.current = null;
        setBgSel({ id: "none", mode: { kind: "none" } });
        vt.attach(videoEl);
        toast({ title: "Background effects unavailable", description: "Falling back to your camera." });
      }
    };
    void apply();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgSel.id, bgSel.mode.kind, camOn, previewEpoch]);

  useEffect(() => () => { bgProcRef.current?.stop(); bgProcRef.current = null; }, []);

  // Rebuild the preview camera/mic with a chosen device, persist the choice.
  const onDeviceChange = async (kind: keyof DevicePrefs, deviceId: string) => {
    const next = { ...devicePrefs, [kind]: deviceId };
    setDevicePrefs(next);
    saveDevicePrefs(next);

    try {
      if (kind === "videoInput") {
        // Tear down any active processor and swap the raw preview track. The
        // background effect re-runs (previewEpoch bump) and re-applies blur to
        // the new track if a selection is active.
        bgProcRef.current?.stop();
        bgProcRef.current = null;
        videoTrackRef.current?.stop();
        const vt = await createLocalVideoTrack({ deviceId });
        videoTrackRef.current = vt;
        if (videoRef.current) vt.attach(videoRef.current);
        setCamOn(true);
        setPreviewEpoch((n) => n + 1);
      } else if (kind === "audioInput") {
        stopMeter();
        audioTrackRef.current?.stop();
        const at = await createLocalAudioTrack({ deviceId });
        audioTrackRef.current = at;
        setMicOn(true);
        startMeter(at);
      } else if (kind === "audioOutput") {
        const videoEl = videoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
        await videoEl?.setSinkId?.(deviceId);
      }
    } catch {
      toast({ title: "Couldn't switch device", variant: "destructive" });
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function stopPreview() {
    stopMeter();
    videoTrackRef.current?.stop();
    audioTrackRef.current?.stop();
    videoTrackRef.current = null;
    audioTrackRef.current = null;
  }

  // Finalize a join from a token payload: stash result + navigate into the room.
  const finalizeJoin = (
    p: { token: string; ws_url: string; roomName: string; identity: string },
    name: string,
  ) => {
    stopPreview();
    m.setJoinResult({
      token: p.token,
      wsUrl: p.ws_url,
      room: p.roomName,
      identity: p.identity,
      role: "participant",
      displayName: name,
      origin,
    });
    m.setCode(code);
    navigate(`/r/${code}`);
  };

  const handleJoinError = (e: unknown) => {
    const msg = String((e as Error)?.message || "");
    if (msg.includes("409")) {
      toast({ title: "Meeting ended", description: "This meeting is no longer available.", variant: "destructive" });
    } else if (msg.includes("404")) {
      toast({ title: "Meeting ended", description: "This meeting is no longer available.", variant: "destructive" });
    } else if (msg.includes("403") || msg.includes("401")) {
      toast({ title: "Sign-in required", description: "This meeting doesn't allow guests. Please sign in.", variant: "destructive" });
    } else if (msg.includes("429")) {
      toast({ title: "Too many attempts", description: "Please wait a moment and try again.", variant: "destructive" });
    } else if (msg.includes("400")) {
      setNameError("That name was rejected. Use 1–60 characters.");
    } else {
      toast({ title: "Connection problem", description: "Couldn't reach the meeting. Try again.", variant: "destructive" });
    }
  };

  const join = async () => {
    const name = localName.trim();
    if (name.length < 1 || name.length > 60) {
      setNameError("Please enter a name (1–60 characters).");
      inputRef.current?.focus();
      return;
    }
    setNameError(null);
    setJoining(true);

    m.setMicEnabled(micOn);
    m.setCamEnabled(camOn);

    // Authed org members bypass the lobby entirely (existing flow).
    if (authedUser) {
      try {
        const data = await apiRequest<JoinResponse>("POST", `/api/meetings/${code}/join`, {
          guestName: name,
        });
        finalizeJoin(data, name);
      } catch (e) {
        handleJoinError(e);
        setJoining(false);
      }
      return;
    }

    // Anonymous guests knock. The server decides whether to admit immediately
    // (waiting room off) or queue us for host approval.
    try {
      const data = await apiRequest<KnockResponse>("POST", `/api/meetings/${code}/knock`, {
        displayName: name,
      });
      if (data.admitted && data.token && data.ws_url && data.roomName && data.identity) {
        finalizeJoin(data as Required<KnockResponse>, name);
        return;
      }
      if (data.knockId) {
        setLobby({
          phase: "waiting",
          knockId: data.knockId,
          pollIntervalMs: data.pollIntervalMs ?? 2000,
          displayName: name,
        });
        return;
      }
      toast({ title: "Connection problem", description: "Couldn't reach the meeting. Try again.", variant: "destructive" });
      setJoining(false);
    } catch (e) {
      handleJoinError(e);
      setJoining(false);
    }
  };

  // Poll the knock while in the waiting room; transition on a host decision.
  useEffect(() => {
    if (lobby.phase !== "waiting") return;
    let cancelled = false;
    const { knockId, pollIntervalMs, displayName } = lobby;

    const poll = async () => {
      try {
        const data = await apiRequest<KnockResponse>("GET", `/api/meetings/${code}/knock/${knockId}`);
        if (cancelled) return;
        if (data.status === "admitted" && data.token && data.ws_url && data.roomName && data.identity) {
          finalizeJoin(data as Required<KnockResponse>, displayName);
        } else if (data.status === "denied") {
          setLobby({ phase: "denied" });
          setJoining(false);
        } else if (data.status === "expired") {
          setLobby({ phase: "expired", displayName });
          setJoining(false);
        } else if (data.status === "cancelled") {
          setLobby({ phase: "idle" });
          setJoining(false);
        }
        // pending / admitted-already-issued → keep polling.
      } catch {
        // Transient network error — keep polling on the next tick.
      }
    };

    void poll();
    const id = setInterval(poll, pollIntervalMs);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.phase, lobby.phase === "waiting" ? lobby.knockId : null]);

  const cancelKnock = async () => {
    if (lobby.phase !== "waiting") return;
    const { knockId } = lobby;
    setLobby({ phase: "idle" });
    setJoining(false);
    try {
      await apiRequest("DELETE", `/api/meetings/${code}/knock/${knockId}`);
    } catch {
      /* best-effort */
    }
  };

  const createNew = async () => {
    setCreatingNew(true);
    try {
      const data = await apiRequest<{ meeting: { code: string } }>("POST", "/api/meetings", {
        kind: "scheduled",
        title: "Quick meeting",
        allowGuests: true,
      });
      navigate(`/m/${data.meeting.code}?from=bulldog`);
    } catch {
      toast({ title: "Couldn't create meeting", description: "Please sign in to start a new meeting.", variant: "destructive" });
      setCreatingNew(false);
    }
  };

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="flex items-center justify-between px-5 py-4 sm:px-8">
          <BulldogWordmark />
          <ThemeToggle />
        </header>
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-5 pb-16 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <VideoOffIcon size={22} />
          </div>
          <h1 className="font-display text-xl font-bold tracking-tight" data-testid="text-not-found">
            Meeting not found
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The code <span className="font-mono">{code}</span> doesn't match an active meeting. It may have ended.
          </p>
          <Button
            data-testid="button-create-new"
            onClick={createNew}
            disabled={creatingNew}
            className="mt-6 h-12 gap-2 px-6 text-base font-semibold"
          >
            {creatingNew ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
            Create a new meeting
          </Button>
        </main>
      </div>
    );
  }

  const title = meta?.title ?? (isLoading ? "Loading…" : "Meeting");

  if (lobby.phase !== "idle") {
    return (
      <WaitingRoom
        state={lobby}
        meetingTitle={meta?.title ?? "Meeting"}
        onCancel={cancelKnock}
        onRetry={() => { setLobby({ phase: "idle" }); setJoining(false); void join(); }}
        onBack={() => { setLobby({ phase: "idle" }); setJoining(false); }}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <BulldogWordmark />
        <ThemeToggle />
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-5 pb-10 sm:px-8 lg:flex-row lg:items-center lg:gap-10">
        {/* LEFT: live camera preview */}
        <section className="flex flex-col gap-4 lg:w-[55%]">
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-slate-900 ring-1 ring-black/10 dark:ring-white/10">
            <video
              ref={videoRef}
              data-testid="video-self-preview"
              autoPlay
              playsInline
              muted
              className={`h-full w-full object-cover ${camOn ? "" : "hidden"}`}
              style={{ transform: "scaleX(-1)" }}
            />
            {!camOn && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-800 text-slate-300">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-600 font-display text-2xl font-semibold text-white">
                  {(localName.trim() || "You").slice(0, 2).toUpperCase()}
                </div>
                <span className="text-sm">{permDenied ? "Camera blocked" : "Camera off"}</span>
              </div>
            )}
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/45 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Preview
            </div>
          </div>

          {permDenied && (
            <div
              className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
              data-testid="text-perm-warning"
            >
              Camera/mic blocked — you can still join audio-only or unblock permissions and reload.
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ControlBtn
                testid="button-toggle-mic"
                tone={micOn ? "neutral" : "danger"}
                onClick={toggleMic}
                label={micOn ? "Mute" : "Unmute"}
              >
                {micOn ? <Mic size={18} /> : <MicOff size={18} />}
              </ControlBtn>
              <ControlBtn
                testid="button-toggle-cam"
                tone={camOn ? "neutral" : "danger"}
                onClick={toggleCam}
                label={camOn ? "Stop video" : "Start video"}
              >
                {camOn ? <Video size={18} /> : <VideoOff size={18} />}
              </ControlBtn>
              <div className="relative">
                <ControlBtn
                  testid="button-toggle-blur"
                  tone={bgSel.id !== "none" ? "accent" : "neutral"}
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
                </ControlBtn>
                {bgOpen && canBlur && (
                  <VirtualBackgroundPicker
                    current={bgSel}
                    onSelect={(sel) => setBgSel(sel)}
                    onClose={() => setBgOpen(false)}
                  />
                )}
              </div>
              <ControlBtn
                testid="button-settings"
                tone="neutral"
                onClick={() => setSettingsOpen(true)}
                label="Settings"
              >
                <Settings size={18} />
              </ControlBtn>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
              <span className="text-xs text-muted-foreground">Mic</span>
              <LiveMeter active={micOn} level={level} testid="meter-audio" />
            </div>
          </div>
        </section>

        {/* RIGHT: join card */}
        <section className="lg:w-[45%]">
          <div className="rounded-2xl border border-card-border bg-card p-6 shadow-sm sm:p-7">
            <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5">
              <span className="mt-0.5 shrink-0">
                <PlatformLogo origin={origin} size={18} />
              </span>
              <p className="text-xs leading-relaxed text-muted-foreground" data-testid="text-origin-banner">
                {ORIGIN_BANNER[origin]}
              </p>
            </div>

            <div className="text-xs font-medium uppercase tracking-wide text-primary">Joining meeting</div>
            <h1 className="mt-1 font-display text-xl font-bold tracking-tight" data-testid="text-meeting-title">
              {title}
            </h1>
            <div className="mt-1 font-mono text-sm text-muted-foreground" data-testid="text-meeting-code">
              {code}
            </div>
            {meta?.waitingRoom && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-400/15 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300" data-testid="badge-waiting-room">
                Waiting room enabled
              </div>
            )}

            <label htmlFor="join-name" className="mt-6 block text-sm font-medium">
              Your name
            </label>
            <Input
              id="join-name"
              ref={inputRef}
              data-testid="input-name"
              value={localName}
              maxLength={60}
              onChange={(e) => { setLocalName(e.target.value); if (nameError) setNameError(null); }}
              onKeyDown={(e) => e.key === "Enter" && join()}
              placeholder="e.g. Josh Bieler"
              className="mt-1.5 h-12 text-base"
            />
            {nameError && (
              <p className="mt-1.5 text-xs font-medium text-destructive" data-testid="text-name-error">
                {nameError}
              </p>
            )}

            <Button
              data-testid="button-join"
              onClick={join}
              disabled={joining || localName.trim().length < 1}
              className="mt-5 h-12 w-full gap-2 text-base font-semibold"
            >
              {joining ? <><Loader2 size={18} className="animate-spin" /> Joining…</> : "Join meeting"}
            </Button>

            <div className="mt-5 flex items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
              <Sparkles size={13} className="mt-0.5 shrink-0 text-primary" />
              <span>This meeting may be recorded and transcribed by AI.</span>
            </div>
          </div>
        </section>
      </main>

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

/** Waiting-room screen shown to guests after they knock a lobby-gated meeting. */
function WaitingRoom({
  state, meetingTitle, onCancel, onRetry, onBack,
}: {
  state: LobbyState;
  meetingTitle: string;
  onCancel: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <BulldogWordmark />
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-5 pb-16 text-center">
        <div className="w-full rounded-2xl border border-card-border bg-card p-7 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-primary">{meetingTitle}</div>

          {state.phase === "waiting" && (
            <>
              <div className="mx-auto mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-primary">
                <Loader2 size={24} className="animate-spin" />
              </div>
              <h1 className="mt-4 font-display text-xl font-bold tracking-tight" data-testid="text-waiting-title">
                Waiting for the host to let you in…
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                You'll join automatically once you're admitted. Joining as{" "}
                <span className="font-medium text-foreground" data-testid="text-waiting-name">{state.displayName}</span>.
              </p>
              <Button
                data-testid="button-cancel-knock"
                variant="outline"
                onClick={onCancel}
                className="mt-6 h-11 w-full font-semibold"
              >
                Cancel
              </Button>
            </>
          )}

          {state.phase === "denied" && (
            <>
              <div className="mx-auto mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <VideoOffIcon size={22} />
              </div>
              <h1 className="mt-4 font-display text-xl font-bold tracking-tight" data-testid="text-denied-title">
                The host didn't let you in.
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                You can head back and try again later.
              </p>
              <Button
                data-testid="button-back-prejoin"
                variant="outline"
                onClick={onBack}
                className="mt-6 h-11 w-full font-semibold"
              >
                Back
              </Button>
            </>
          )}

          {state.phase === "expired" && (
            <>
              <div className="mx-auto mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-amber-400/15 text-amber-600 dark:text-amber-400">
                <Loader2 size={22} />
              </div>
              <h1 className="mt-4 font-display text-xl font-bold tracking-tight" data-testid="text-expired-title">
                Knock timed out — try again.
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                No one let you in this time. You can knock again.
              </p>
              <Button
                data-testid="button-retry-knock"
                onClick={onRetry}
                className="mt-6 h-11 w-full font-semibold"
              >
                Knock again
              </Button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/** Real audio meter driven by the live mic RMS level. */
function LiveMeter({ active, level, testid }: { active: boolean; level: number; testid?: string }) {
  const bars = 8;
  return (
    <div data-testid={testid} className="flex h-7 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: bars }).map((_, i) => {
        const threshold = (i + 1) / bars;
        const lit = active && level >= threshold * 0.85;
        const h = active ? Math.max(12, Math.min(100, level * 130 - i * 6 + 18)) : 12;
        return (
          <span
            key={i}
            className={`w-[3px] rounded-full transition-[height,background-color] duration-75 ease-out ${
              lit || (active && h > 16) ? "bg-primary" : "bg-muted-foreground/40"
            }`}
            style={{ height: `${active ? h : 12}%` }}
          />
        );
      })}
    </div>
  );
}

function ControlBtn({
  children, tone, onClick, label, testid,
}: {
  children: React.ReactNode;
  tone: "neutral" | "accent" | "danger";
  onClick: () => void;
  label: string;
  testid: string;
}) {
  const toneClass =
    tone === "danger"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : tone === "accent"
        ? "border-primary/40 bg-primary/10 text-primary"
        : "border-border bg-card text-foreground";
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors duration-200 hover-elevate ${toneClass}`}
    >
      {children}
    </button>
  );
}
