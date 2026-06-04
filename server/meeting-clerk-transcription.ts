// Phase 1.9.4 AI clerk — Deepgram live streaming session manager.
//
// Architecture
// ────────────
// Each active "clerk session" owns one Deepgram WebSocket connection.
// The browser captures the user's mic with MediaRecorder and POSTs short
// (~2s) audio chunks to /api/meeting-notes/:id/audio. The route hands the
// raw bytes to the session manager which forwards them straight to
// Deepgram's listen websocket. Deepgram pushes back interim + final
// transcripts which we accumulate into meeting_notes.transcript_text.
//
// We intentionally accept binary chunks (audio/webm-opus by default) over
// HTTP rather than running our own WebSocket fan-out — keeps the front-end
// trivial, plays nice with our existing session cookie auth, and avoids
// adding a WS server to the chat app. Latency is fine for note-taking
// (sub-3-second is plenty).
//
// Configuration
//   DEEPGRAM_API_KEY      — required for real transcription
//   DEEPGRAM_MODEL        — default "nova-3"
//   DEEPGRAM_LANGUAGE     — default "en-US"
//
// When DEEPGRAM_API_KEY is missing, sessions are accepted but no
// transcript is produced — the pipeline still flows end-to-end so the rest
// of the feature is testable.
//
// NOTE: `@deepgram/sdk` v5 exposes `new DeepgramClient({ apiKey })` and
// `await client.listen.v1.connect(opts)` which returns a live socket with
// on/sendMedia/sendCloseStream/connect/waitForOpen methods. We import it
// lazily so missing creds don't crash startup.

export interface TranscriptionSessionOpts {
  noteId: number;
  onDelta?: (delta: { text: string; isFinal: boolean; speaker?: number | null }) => void;
}

export interface TranscriptionSession {
  noteId: number;
  startedAt: Date;
  isOpen(): boolean;
  ingestAudio(chunk: Buffer): void;
  // Marks the end-of-utterance; waits a moment for trailing finals.
  close(): Promise<void>;
  // Returns the accumulated final transcript (with [speaker N] markers).
  getTranscript(): string;
}

const sessions = new Map<number, TranscriptionSession>();

export function isDeepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY?.trim());
}

export function getActiveSession(noteId: number): TranscriptionSession | undefined {
  return sessions.get(noteId);
}

export async function startTranscriptionSession(opts: TranscriptionSessionOpts): Promise<TranscriptionSession> {
  // Already-open session? Reuse (idempotent — handy if the FE retries).
  const existing = sessions.get(opts.noteId);
  if (existing && existing.isOpen()) return existing;

  if (!isDeepgramConfigured()) {
    // Stub session — accepts audio, produces nothing. Lets the rest of
    // the pipeline exercise its codepaths during local/no-key testing.
    const stub = makeStubSession(opts);
    sessions.set(opts.noteId, stub);
    return stub;
  }

  // Lazy-import — keeps cold start fast and avoids loading the WS deps
  // unless we actually plan to transcribe.
  //
  // @deepgram/sdk v5 rewrote the API: there is no `createClient`. Instead you
  // construct a `DeepgramClient` and open a live socket via
  // `await client.listen.v1.connect(opts)`. The returned socket exposes
  // `.on(event, cb)`, `.sendMedia(chunk)`, `.sendFinalize()` / `.sendCloseStream()`
  // and `.waitForOpen()`. Messages arrive on a single "message" event carrying
  // a discriminated union; we filter for `type === "Results"`.
  const dgMod: any = await import("@deepgram/sdk");
  const DeepgramClient = dgMod.DeepgramClient || dgMod.default?.DeepgramClient;
  if (!DeepgramClient) {
    console.warn("[meeting-clerk] @deepgram/sdk loaded but DeepgramClient missing; falling back to stub");
    const stub = makeStubSession(opts);
    sessions.set(opts.noteId, stub);
    return stub;
  }
  const client = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY! });

  const model = (process.env.DEEPGRAM_MODEL || "nova-3").trim();
  const language = (process.env.DEEPGRAM_LANGUAGE || "en-US").trim();

  const liveOpts = {
    model,
    language,
    smart_format: true,
    punctuate: true,
    diarize: true,
    interim_results: true,
    encoding: "opus", // matches MediaRecorder default (audio/webm; codecs=opus)
    // Deepgram auto-detects sample rate for opus.
  };

  let connection: any;
  try {
    connection = await client.listen.v1.connect(liveOpts);
  } catch (err) {
    console.warn("[meeting-clerk] deepgram live connect failed:", (err as Error).message);
    const stub = makeStubSession(opts);
    sessions.set(opts.noteId, stub);
    return stub;
  }

  let open = false;
  let openWaiters: Array<() => void> = [];
  let finalText = "";
  let lastSpeaker: number | null = null;
  const pending: Buffer[] = [];
  const startedAt = new Date();

  const flushPending = () => {
    while (pending.length > 0 && open) {
      const chunk = pending.shift()!;
      try { connection.sendMedia(chunk); } catch (err) {
        console.warn("[meeting-clerk] deepgram send failed:", (err as Error).message);
      }
    }
  };

  // v5 delivers everything on a single "message" event carrying a
  // discriminated union ({ type: "Results" | "Metadata" | ... }). We only
  // care about "Results"; the rest is ignored.
  const handleResults = (data: any) => {
    try {
      const alt = data?.channel?.alternatives?.[0];
      const text: string = (alt?.transcript || "").trim();
      const isFinal: boolean = !!data?.is_final;
      if (!text) return;

      let speaker: number | null = null;
      // Pull a representative speaker from the words array if diarize is on.
      if (Array.isArray(alt?.words) && alt.words.length > 0) {
        const w = alt.words.find((x: any) => typeof x.speaker === "number") || alt.words[0];
        if (typeof w?.speaker === "number") speaker = w.speaker;
      }

      if (isFinal) {
        // Append finals — interims are noise for the saved record but we
        // still report them via onDelta for UI banners.
        if (speaker != null && speaker !== lastSpeaker) {
          finalText += (finalText ? "\n" : "") + `[speaker ${speaker}] ${text}`;
          lastSpeaker = speaker;
        } else {
          finalText += (finalText ? " " : "") + text;
        }
      }
      if (opts.onDelta) opts.onDelta({ text, isFinal, speaker });
    } catch (err) {
      console.warn("[meeting-clerk] transcript handler failed:", (err as Error).message);
    }
  };

  connection.on("open", () => {
    open = true;
    openWaiters.forEach(fn => fn());
    openWaiters = [];
    flushPending();
  });

  connection.on("message", (data: any) => {
    if (data?.type === "Results") handleResults(data);
  });

  connection.on("error", (err: any) => {
    console.warn("[meeting-clerk] deepgram error:", err?.message ?? err);
  });

  connection.on("close", () => {
    open = false;
  });

  // v5 requires an explicit connect() to open the socket and register handlers.
  try {
    connection.connect();
  } catch (err) {
    console.warn("[meeting-clerk] deepgram connect() failed:", (err as Error).message);
  }

  const session: TranscriptionSession = {
    noteId: opts.noteId,
    startedAt,
    isOpen: () => open,
    ingestAudio: (chunk: Buffer) => {
      if (open) {
        try { connection.sendMedia(chunk); } catch (err) {
          console.warn("[meeting-clerk] deepgram send failed:", (err as Error).message);
        }
      } else {
        pending.push(chunk);
        if (pending.length > 200) pending.shift(); // hard cap ≈ 400s of pre-open buffer
      }
    },
    close: async () => {
      // Drain any queued chunks first, then signal end-of-stream and wait
      // briefly for trailing finals. v5 uses sendCloseStream() to gracefully
      // end the stream (server flushes finals) and close() to tear down.
      flushPending();
      try {
        if (typeof connection.sendCloseStream === "function") {
          connection.sendCloseStream({ type: "CloseStream" });
        } else if (typeof connection.sendFinalize === "function") {
          connection.sendFinalize({ type: "Finalize" });
        }
      } catch (err) {
        console.warn("[meeting-clerk] deepgram close signal failed:", (err as Error).message);
      }
      // Give Deepgram a moment to flush the final transcript, then tear down.
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      try { if (typeof connection.close === "function") connection.close(); } catch { /* ignore */ }
      open = false;
      sessions.delete(opts.noteId);
    },
    getTranscript: () => finalText,
  };
  sessions.set(opts.noteId, session);

  // Wait up to 5s for the open event so the first chunks aren't lost.
  await new Promise<void>((resolve) => {
    if (open) return resolve();
    const t = setTimeout(() => resolve(), 5000);
    openWaiters.push(() => { clearTimeout(t); resolve(); });
  });

  return session;
}

function makeStubSession(opts: TranscriptionSessionOpts): TranscriptionSession {
  let open = true;
  let transcript = "";
  return {
    noteId: opts.noteId,
    startedAt: new Date(),
    isOpen: () => open,
    ingestAudio: () => { /* noop */ },
    close: async () => { open = false; sessions.delete(opts.noteId); },
    getTranscript: () => transcript || "(transcription disabled — DEEPGRAM_API_KEY not set)",
  };
}
