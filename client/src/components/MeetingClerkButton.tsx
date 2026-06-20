// Phase 1.9.4 — AI clerk button + audio streamer.
//
// Lives in the call header next to Record. When started:
//   1. POST /api/channels/:id/meeting-notes/start          → noteId
//   2. getUserMedia({audio:true}) → MediaRecorder           → emit chunks
//   3. POST /api/meeting-notes/:id/audio  every ~2 seconds  → Deepgram
//   4. on stop: POST /api/meeting-notes/:id/stop            → BG pipeline
//
// The note's status (recording → transcribing → summarizing → rendering →
// uploading → uploaded) is polled by the parent (BulldogClerkNotesList).
// Here we just own the live capture lifecycle.

import { useEffect, useRef, useState, useCallback } from "react";
import { Bot, Square, Loader2, AlertTriangle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useMutation, useQuery } from "@tanstack/react-query";

interface Props {
  channelId: number;
  // Whether the current user is allowed to start/stop (admin/foreman).
  canControl: boolean;
  /** LiveKit room name for participant tracking. Passed when button is used inside a call. */
  roomName?: string;
  /**
   * Toolbar-style rendering: icon-on-top + small label underneath to match
   * the in-call top toolbar buttons. Defaults to false (the original pill).
   */
  compact?: boolean;
}

interface ClerkConfig {
  deepgramConfigured: boolean;
  anthropicConfigured: boolean;
  synologyConfigured: boolean;
  synologyEnabled: boolean;
}

interface NoteRow {
  id: number;
  channelId: number;
  status:
    | "recording"
    | "transcribing"
    | "summarizing"
    | "rendering"
    | "uploading"
    | "uploaded"
    | "failed";
  title?: string | null;
  errorMessage?: string | null;
  synologyStatus?: string | null;
}

export function MeetingClerkButton({ channelId, canControl, roomName, compact }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const uploadInFlightRef = useRef<boolean>(false);

  // Pull current notes so we re-sync if the user reloaded mid-session.
  const notesQ = useQuery<NoteRow[]>({
    queryKey: ["/api/channels", channelId, "meeting-notes"],
    enabled: !!channelId,
    refetchInterval: 5000,
  });
  const activeFromServer = (notesQ.data ?? []).find(n =>
    ["recording", "transcribing", "summarizing", "rendering", "uploading"].includes(n.status),
  );

  // If the server says a session is live but we don't have a local recorder,
  // we still expose a "Stop" button so the user isn't stuck.
  useEffect(() => {
    if (activeFromServer && activeNoteId !== activeFromServer.id) {
      setActiveNoteId(activeFromServer.id);
    }
    if (!activeFromServer && activeNoteId && !mediaRecorderRef.current) {
      // The session ended on the server (different tab? crash?). Clear local.
      setActiveNoteId(null);
    }
  }, [activeFromServer?.id]);

  const configQ = useQuery<ClerkConfig>({
    queryKey: ["/api/meeting-clerk/config"],
    staleTime: 60_000,
  });

  // Upload a single chunk. We serialize uploads with a simple in-flight flag
  // so chunks arrive in order; MediaRecorder fires `dataavailable` faster
  // than network round-trips can complete on flaky connections.
  const uploadChunk = useCallback(async (noteId: number, blob: Blob) => {
    if (uploadInFlightRef.current) {
      // Drop overlapping chunks rather than queue forever; the recorder is
      // already configured to slice every 2s so we never lose much.
      return;
    }
    uploadInFlightRef.current = true;
    try {
      const buf = await blob.arrayBuffer();
      const res = await fetch(`/api/meeting-notes/${noteId}/audio`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: buf,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn("[clerk] audio upload failed:", res.status, text);
      }
    } catch (err) {
      console.warn("[clerk] audio upload error:", (err as Error).message);
    } finally {
      uploadInFlightRef.current = false;
    }
  }, []);

  const stopLocalCapture = useCallback(() => {
    try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
    mediaRecorderRef.current = null;
    try {
      streamRef.current?.getTracks().forEach(t => t.stop());
    } catch { /* ignore */ }
    streamRef.current = null;
  }, []);

  const startMutation = useMutation({
    mutationFn: async () => {
      // 1) Ask the server to create a note + open the Deepgram session.
      // Include roomName if available so the server can track actual call participants.
      const res = await apiRequest<{ noteId: number; status: string }>(
        "POST",
        `/api/channels/${channelId}/meeting-notes/start`,
        roomName ? { roomName } : undefined,
      );
      const noteId = res.noteId;

      // 2) Get the mic (browser will prompt for permission the first time).
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        // Tell the server to abandon the session so it doesn't sit "recording".
        await apiRequest("POST", `/api/meeting-notes/${noteId}/stop`).catch(() => null);
        throw new Error("Microphone permission denied. The clerk needs mic access to take notes.");
      }
      streamRef.current = stream;

      // 3) Wire up MediaRecorder. We slice on the 2-second mark so Deepgram
      // sees a steady drip of audio rather than huge bursts.
      const mimeCandidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ];
      let mime = "";
      for (const m of mimeCandidates) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
          mime = m; break;
        }
      }
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          uploadChunk(noteId, ev.data);
        }
      };
      recorder.onerror = (ev) => {
        console.warn("[clerk] MediaRecorder error:", (ev as any).error);
      };
      recorder.start(2000); // 2-second slices
      return noteId;
    },
    onSuccess: (noteId) => {
      setError(null);
      setActiveNoteId(noteId);
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "meeting-notes"] });
    },
    onError: (err: Error) => {
      stopLocalCapture();
      setError(err.message || "Failed to start AI clerk");
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const noteId = activeNoteId;
      if (!noteId) return;
      // Flush any final chunk THEN tell the server we're done.
      try {
        const rec = mediaRecorderRef.current;
        if (rec && rec.state !== "inactive") {
          await new Promise<void>((resolve) => {
            rec.onstop = () => resolve();
            try { rec.requestData(); } catch { /* ignore */ }
            try { rec.stop(); } catch { /* ignore */ }
            // Hard timeout — don't hang forever on weird browsers.
            setTimeout(() => resolve(), 1500);
          });
        }
      } finally {
        stopLocalCapture();
      }
      // Give any in-flight upload a moment before posting /stop.
      await new Promise((r) => setTimeout(r, 400));
      await apiRequest("POST", `/api/meeting-notes/${noteId}/stop`);
    },
    onSuccess: () => {
      setActiveNoteId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/channels", channelId, "meeting-notes"] });
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to stop AI clerk");
    },
  });

  // Defensive cleanup on unmount — never leave the mic hot.
  useEffect(() => {
    return () => stopLocalCapture();
  }, [stopLocalCapture]);

  const isRecording = !!activeNoteId && activeFromServer?.status === "recording";
  const isProcessing = !!activeFromServer && ["transcribing", "summarizing", "rendering", "uploading"].includes(activeFromServer.status);

  if (!canControl && !isRecording && !isProcessing) {
    // Hide entirely for users who can't control and there's nothing happening.
    return null;
  }

  const cfg = configQ.data;
  const cfgWarning = cfg && (!cfg.deepgramConfigured || !cfg.anthropicConfigured || !cfg.synologyEnabled);

  // Compact toolbar mode: render an icon+label button matching TopBarBtn
  // styling so the AI clerk lives front-and-center alongside Camera/Mic.
  if (compact) {
    const baseClass = "flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md transition-colors min-w-[48px]";
    if (isRecording) {
      return (
        <button
          type="button"
          onClick={() => stopMutation.mutate()}
          disabled={stopMutation.isPending}
          className={`${baseClass} bg-vs-red/20 border border-vs-red/40 text-[hsl(var(--vs-accent))] hover:bg-vs-red/30`}
          title="Stop AI clerk"
          data-testid="button-stop-clerk"
        >
          <Square className="w-5 h-5 fill-current" />
          <span className="text-[10px] font-medium">Stop clerk</span>
        </button>
      );
    }
    if (isProcessing) {
      return (
        <div
          className={`${baseClass} bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] text-[hsl(0_0%_70%)]`}
          title={`Clerk ${activeFromServer?.status ?? "processing"}…`}
          data-testid="status-clerk-processing"
        >
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-[10px] font-medium capitalize">{activeFromServer?.status}…</span>
        </div>
      );
    }
    if (canControl) {
      return (
        <button
          type="button"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending}
          className={`${baseClass} text-[hsl(0_0%_80%)] hover:bg-[hsl(220_50%_20%)] hover:text-vs-blue-light`}
          title={cfgWarning ? "AI clerk (some integrations not configured — pipeline will still run)" : "Start AI clerk — records, transcribes, summarizes, files notes to Synology"}
          data-testid="button-start-clerk"
        >
          {startMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Bot className="w-5 h-5" />}
          <span className="text-[10px] font-medium">Clerk</span>
        </button>
      );
    }
    return null;
  }

  return (
    <div className="flex items-center gap-1.5">
      {isRecording ? (
        <button
          type="button"
          onClick={() => stopMutation.mutate()}
          disabled={stopMutation.isPending}
          className="px-2 py-1 rounded-md text-xs bg-vs-red/20 border border-vs-red/40 text-[hsl(var(--vs-accent))] hover:bg-vs-red/30 flex items-center gap-1.5 whitespace-nowrap"
          title="Stop AI clerk"
          data-testid="button-stop-clerk"
        >
          <Square className="w-3 h-3 fill-current" /> Stop clerk
        </button>
      ) : isProcessing ? (
        <div
          className="px-2 py-1 rounded-md text-xs bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] text-[hsl(0_0%_70%)] flex items-center gap-1.5 whitespace-nowrap"
          title={`Clerk ${activeFromServer?.status ?? "processing"}…`}
          data-testid="status-clerk-processing"
        >
          <Loader2 className="w-3 h-3 animate-spin" /> Clerk {activeFromServer?.status}…
        </div>
      ) : canControl ? (
        <button
          type="button"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending}
          className="px-2 py-1 rounded-md text-xs bg-[hsl(220_50%_18%)] border border-[hsl(220_40%_25%)] hover:border-vs-blue hover:text-vs-blue-light text-[hsl(0_0%_80%)] flex items-center gap-1.5 whitespace-nowrap"
          title={cfgWarning ? "AI clerk (some integrations not configured — pipeline will still run)" : "Start AI clerk — records, transcribes, summarizes, files notes to Synology"}
          data-testid="button-start-clerk"
        >
          {startMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bot className="w-3 h-3" />}
          Clerk
        </button>
      ) : null}
      {error && (
        <div
          className="flex items-center gap-1 text-[10px] text-[hsl(var(--vs-accent))] max-w-[180px] truncate"
          title={error}
        >
          <AlertTriangle className="w-3 h-3" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// Banner shown to every participant while a clerk is recording. Renders
// in the call panel so even users who didn't start the clerk see it.
export function MeetingClerkBanner({ channelId }: { channelId: number }) {
  const notesQ = useQuery<NoteRow[]>({
    queryKey: ["/api/channels", channelId, "meeting-notes"],
    enabled: !!channelId,
    refetchInterval: 5000,
  });
  const active = (notesQ.data ?? []).find(n =>
    ["recording", "transcribing", "summarizing", "rendering", "uploading"].includes(n.status),
  );
  if (!active) return null;

  const labels: Record<string, string> = {
    recording: "AI clerk is recording — transcription is live.",
    transcribing: "AI clerk is finalizing the transcript…",
    summarizing: "AI clerk is generating notes…",
    rendering: "AI clerk is composing the PDF…",
    uploading: "AI clerk is filing notes to Synology…",
  };
  const isLive = active.status === "recording";
  return (
    <div
      className={`px-4 py-2 border-b flex items-center gap-2 text-xs ${
        isLive
          ? "bg-[hsl(var(--vs-info)/0.12)] border-[hsl(var(--vs-info)/0.3)]"
          : "bg-[hsl(220_50%_18%)] border-[hsl(220_40%_25%)]"
      }`}
      data-testid="banner-clerk-active"
    >
      {isLive
        ? <Bot className="w-3.5 h-3.5 text-vs-blue-light shrink-0" />
        : <Loader2 className="w-3.5 h-3.5 text-vs-blue-light shrink-0 animate-spin" />
      }
      <span className="text-[hsl(0_0%_85%)]">{labels[active.status] ?? `Clerk ${active.status}…`}</span>
    </div>
  );
}
