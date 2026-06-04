// Phase 1.9.4 AI clerk — orchestrator.
//
// One module, three jobs:
//   1. start(): create a meeting_notes row + Deepgram session.
//   2. ingest(): forward an audio chunk to Deepgram (and persist transcript
//      deltas opportunistically).
//   3. stop(): close transcription → summarize → render PDF → push to
//      Synology → mark the row done.
//
// stop() runs in the background after the FE call returns so the user's
// click feels instant. The note row carries the live status the FE polls.

import path from "node:path";
import fs from "node:fs";
import { rawDb } from "./db";
import { uploadOriginalToSynology, isSynologyBackupEnabled, isSynologyBackupConfigured } from "./synology-backup";
import { summarizeMeeting, isAnthropicConfigured } from "./meeting-clerk-summarizer";
import { renderMeetingNotesPdf } from "./meeting-clerk-pdf";
import { startTranscriptionSession, getActiveSession, isDeepgramConfigured } from "./meeting-clerk-transcription";
import { storage } from "./storage";

export interface StartClerkOpts {
  channelId: number;
  startedByUserId: number;
}

export interface ClerkConfigSummary {
  deepgramConfigured: boolean;
  anthropicConfigured: boolean;
  synologyConfigured: boolean;
  synologyEnabled: boolean;
}

export function getClerkConfigSummary(): ClerkConfigSummary {
  return {
    deepgramConfigured: isDeepgramConfigured(),
    anthropicConfigured: isAnthropicConfigured(),
    synologyConfigured: isSynologyBackupConfigured(),
    synologyEnabled: isSynologyBackupEnabled(),
  };
}

interface MeetingNoteRow {
  id: number;
  channel_id: number;
  started_by_user_id: number;
  started_at: number;
  ended_at: number | null;
  status: string;
  title: string | null;
  transcript_text: string;
  summary_text: string | null;
  attendees_json: string | null;
  synology_remote_path: string | null;
  synology_status: string | null;
  synology_reason: string | null;
  pdf_size_bytes: number | null;
  duration_seconds: number | null;
  deepgram_session_id: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

function nowMs(): number { return Date.now(); }

function getNoteRow(noteId: number): MeetingNoteRow | undefined {
  return rawDb.prepare("SELECT * FROM meeting_notes WHERE id = ?").get(noteId) as MeetingNoteRow | undefined;
}

function updateNote(noteId: number, patch: Partial<MeetingNoteRow>) {
  const fields = Object.keys(patch).filter(k => k !== "id");
  if (fields.length === 0) return;
  const setClause = fields.map(f => `${f} = ?`).join(", ");
  const values = fields.map(f => (patch as any)[f]);
  rawDb.prepare(`UPDATE meeting_notes SET ${setClause}, updated_at = ? WHERE id = ?`)
    .run(...values, nowMs(), noteId);
}

export async function startClerk(opts: StartClerkOpts): Promise<{ noteId: number; status: string; config: ClerkConfigSummary }> {
  // Reject if there's already an active clerk on this channel.
  const active = rawDb.prepare(
    "SELECT id FROM meeting_notes WHERE channel_id = ? AND status NOT IN ('uploaded','failed') ORDER BY id DESC LIMIT 1"
  ).get(opts.channelId) as { id: number } | undefined;
  if (active) {
    return { noteId: active.id, status: "already_active", config: getClerkConfigSummary() };
  }

  const startedAt = nowMs();
  const result = rawDb.prepare(`
    INSERT INTO meeting_notes (channel_id, started_by_user_id, started_at, status, created_at, updated_at)
    VALUES (?, ?, ?, 'recording', ?, ?)
  `).run(opts.channelId, opts.startedByUserId, startedAt, startedAt, startedAt);
  const noteId = Number(result.lastInsertRowid);

  // Kick off the Deepgram session. If creds are missing this returns a stub.
  try {
    await startTranscriptionSession({
      noteId,
      onDelta: (delta) => {
        if (!delta.isFinal) return;
        // Persist finals into transcript_text incrementally so a crash mid-call
        // doesn't lose everything. Cheap: one UPDATE per final phrase.
        try {
          const row = getNoteRow(noteId);
          if (!row) return;
          const speakerTag = (delta.speaker != null) ? `[speaker ${delta.speaker}] ` : "";
          const next = row.transcript_text
            ? `${row.transcript_text}${speakerTag ? "\n" : " "}${speakerTag}${delta.text}`
            : `${speakerTag}${delta.text}`;
          updateNote(noteId, { transcript_text: next });
        } catch (err) {
          console.warn("[meeting-clerk] transcript persist failed:", (err as Error).message);
        }
      },
    });
  } catch (err) {
    updateNote(noteId, { status: "failed", error_message: `transcription start failed: ${(err as Error).message}` });
    return { noteId, status: "failed", config: getClerkConfigSummary() };
  }

  return { noteId, status: "recording", config: getClerkConfigSummary() };
}

export function ingestAudioChunk(noteId: number, buf: Buffer): { ok: boolean; reason?: string } {
  const session = getActiveSession(noteId);
  if (!session) return { ok: false, reason: "no active session" };
  if (!session.isOpen()) return { ok: false, reason: "session not open" };
  session.ingestAudio(buf);
  return { ok: true };
}

export async function stopClerk(noteId: number): Promise<{ ok: boolean; status: string }> {
  const row = getNoteRow(noteId);
  if (!row) return { ok: false, status: "not_found" };
  if (row.status === "uploaded" || row.status === "failed") {
    return { ok: true, status: row.status };
  }

  const session = getActiveSession(noteId);
  const endedAt = nowMs();
  updateNote(noteId, { status: "transcribing", ended_at: endedAt });

  // Fire the post-processing chain in the background so the FE returns
  // immediately. Any failure flips status to 'failed' with a reason.
  (async () => {
    try {
      // 1) Flush Deepgram and grab the final transcript.
      if (session) {
        try { await session.close(); } catch { /* ignore */ }
      }
      // Prefer the in-memory accumulator; fall back to the DB column.
      const refreshed = getNoteRow(noteId);
      const transcript = (session?.getTranscript() || refreshed?.transcript_text || "").trim();
      const startedAt = new Date(refreshed?.started_at ?? row.started_at);
      const ended = new Date(refreshed?.ended_at ?? endedAt);

      // 2) Collect contextual info for the summarizer.
      const channel = storage.getChannel(row.channel_id);
      const channelName = channel?.name || `channel-${row.channel_id}`;
      const contractTitle = (channel as any)?.linkedContract?.title || null;
      const contractAppUrl = (channel as any)?.linkedContract?.appUrl || null;

      // Attendees from the channel members list — a decent proxy in absence
      // of presence tracking. The summarizer will lean on speaker labels
      // anyway, so this is mostly for the PDF header.
      const memberIds = storage.listChannelMemberIds(row.channel_id);
      const attendees = memberIds
        .map(id => storage.getUser(id))
        .filter((u): u is NonNullable<typeof u> => !!u)
        .map(u => ({ name: u.name || u.email, email: u.email }));
      updateNote(noteId, { attendees_json: JSON.stringify(attendees) });

      // 3) Summarize.
      updateNote(noteId, { status: "summarizing" });
      const summary = await summarizeMeeting({
        transcript,
        attendees,
        channelName,
        contractTitle,
        startedAt,
        endedAt: ended,
      });
      updateNote(noteId, {
        title: summary.title,
        summary_text: summary.markdown,
        transcript_text: transcript,
      });

      // 4) Render PDF.
      updateNote(noteId, { status: "rendering" });
      const pdf = await renderMeetingNotesPdf({
        title: summary.title,
        markdown: summary.markdown,
        attendees,
        channelName,
        contractTitle,
        contractAppUrl,
        startedAt,
        endedAt: ended,
        aiGenerated: summary.ai,
      });

      // 5) Push to Synology.
      updateNote(noteId, { status: "uploading", pdf_size_bytes: pdf.sizeBytes });
      const safeChannel = channelName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
      const datePrefix = ended.toISOString().slice(0, 10);
      const filename = `${datePrefix}_${safeChannel}_${noteId}.pdf`;
      const folderSegments = ["Bulldog Chat", "Meetings", datePrefix.slice(0, 7)];
      if (contractTitle) {
        // If the channel has a linked contract, file the note alongside the
        // contract title for easier human navigation on the NAS.
        folderSegments.push(contractTitle.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60));
      }
      const upload = await uploadOriginalToSynology({
        filePath: pdf.filePath,
        remoteFilename: filename,
        folderSegments,
      } as any);

      const durationSec = Math.max(0, Math.round((ended.getTime() - startedAt.getTime()) / 1000));

      updateNote(noteId, {
        status: upload.status === "uploaded" ? "uploaded" : "failed",
        synology_status: upload.status,
        synology_reason: upload.reason || null,
        synology_remote_path: upload.remotePath || null,
        duration_seconds: durationSec,
        error_message: upload.status === "uploaded" ? null : `synology: ${upload.reason || upload.status}`,
      });

      // Cleanup the local tmp PDF whether the upload succeeded or not.
      try { fs.unlinkSync(pdf.filePath); } catch { /* ignore */ }
    } catch (err) {
      console.warn("[meeting-clerk] post-processing failed:", (err as Error).message);
      updateNote(noteId, { status: "failed", error_message: (err as Error).message });
    }
  })().catch(err => {
    console.warn("[meeting-clerk] background chain crashed:", (err as Error).message);
  });

  return { ok: true, status: "transcribing" };
}

export function listNotesForChannel(channelId: number): MeetingNoteRow[] {
  return rawDb.prepare(
    "SELECT * FROM meeting_notes WHERE channel_id = ? ORDER BY id DESC LIMIT 50"
  ).all(channelId) as MeetingNoteRow[];
}

export function getNote(noteId: number): MeetingNoteRow | undefined {
  return getNoteRow(noteId);
}

// Helper used by routes when serializing for the FE.
export function publicNoteShape(row: MeetingNoteRow) {
  let attendees: any[] = [];
  if (row.attendees_json) {
    try { attendees = JSON.parse(row.attendees_json); } catch { attendees = []; }
  }
  return {
    id: row.id,
    channelId: row.channel_id,
    startedByUserId: row.started_by_user_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    title: row.title,
    summaryMarkdown: row.summary_text,
    attendees,
    synologyStatus: row.synology_status,
    synologyRemotePath: row.synology_remote_path,
    synologyReason: row.synology_reason,
    pdfSizeBytes: row.pdf_size_bytes,
    durationSeconds: row.duration_seconds,
    errorMessage: row.error_message,
  };
}
