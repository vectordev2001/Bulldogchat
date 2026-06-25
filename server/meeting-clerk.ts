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
import { emitMessageNew, type WireMessage } from "./events";
import { sendEmail } from "./email";
import { marked } from "marked";
import { listRoomParticipantIdentities } from "./livekit";

export interface StartClerkOpts {
  channelId: number;
  startedByUserId: number;
  /** LiveKit room name for polling actual call participants. Optional. */
  roomName?: string;
}

// Module-level maps for participant polling:
// - participantIntervals: noteId → polling interval handle
// - collectedUserIds: noteId → Set of user IDs seen in the room during the call
const participantIntervals = new Map<number, ReturnType<typeof setInterval>>();
const collectedUserIds = new Map<number, Set<number>>();

/** Poll LiveKit once and union any `u_<id>` identities into the set. */
async function collectParticipants(noteId: number, roomName: string): Promise<void> {
  try {
    const identities = await listRoomParticipantIdentities(roomName);
    let set = collectedUserIds.get(noteId);
    if (!set) { set = new Set<number>(); collectedUserIds.set(noteId, set); }
    for (const ident of identities) {
      // User identities are formatted as u_<userId> by the token generator.
      // SIP-bridged participants use sip_* or similar — skip those.
      const m = ident.match(/^u_(\d+)$/);
      if (m) set.add(Number(m[1]));
    }
    // Persist to DB so the data survives a restart between poll cycles.
    rawDb.prepare("UPDATE meeting_notes SET participant_user_ids_json = ? WHERE id = ?")
      .run(JSON.stringify(Array.from(set)), noteId);
  } catch (err) {
    console.warn("[meeting-clerk] collectParticipants error:", (err as Error).message);
  }
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
  room_name: string | null;
  participant_user_ids_json: string | null;
  // v30 — host's pick of who to email the summary to. Null = legacy (pre-v30)
  // rows that used auto-fan-out, OR brand-new rows still mid-pipeline.
  recipient_selection_json: string | null;
}

interface RecipientSelection {
  status: "pending" | "sent" | "skipped";
  sentToUserIds: number[];
  decidedAt?: number;
  decidedByUserId?: number;
}

// Email payload retained in-memory between the post-stop pipeline (which
// builds the summary HTML/text) and the host's later "Send to selected" call.
// On a server restart we lose this and fall back to reconstructing from the
// persisted row in sendSummaryEmails() — same inputs are still available.
interface PendingEmailPayload {
  attendees: Array<{ name: string; email: string }>;
  title: string;
  markdown: string;
  channelName: string;
  durationSec: number;
  contractAppUrl: string | null;
}
const pendingEmailPayloads = new Map<number, PendingEmailPayload>();

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
    INSERT INTO meeting_notes (channel_id, started_by_user_id, started_at, status, room_name, created_at, updated_at)
    VALUES (?, ?, ?, 'recording', ?, ?, ?)
  `).run(opts.channelId, opts.startedByUserId, startedAt, opts.roomName ?? null, startedAt, startedAt);
  const noteId = Number(result.lastInsertRowid);

  // If a room name was provided, start polling for actual call participants
  // every 10 seconds. The interval handle is stored in participantIntervals
  // so stopClerk can clear it.
  if (opts.roomName) {
    const rn = opts.roomName;
    // Seed the set so stopClerk always has something to read.
    collectedUserIds.set(noteId, new Set<number>());
    // Do an immediate first poll, then continue every 10s.
    void collectParticipants(noteId, rn);
    const handle = setInterval(() => { void collectParticipants(noteId, rn); }, 10_000);
    participantIntervals.set(noteId, handle);
  }

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

  // Stop the participant-polling interval (if one is running for this note).
  const pollHandle = participantIntervals.get(noteId);
  if (pollHandle !== undefined) {
    clearInterval(pollHandle);
    participantIntervals.delete(noteId);
  }

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

      // Attendees: prefer actual call participants tracked by the polling loop.
      // Fall back to channel-member roster (old behaviour) so pre-roomName notes
      // still work correctly.
      const refreshedForAttendees = getNoteRow(noteId);
      let attendeeUserIds: number[] = [];
      const participantJson = refreshedForAttendees?.participant_user_ids_json ?? null;
      if (participantJson) {
        try {
          const parsed = JSON.parse(participantJson) as number[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            // Always include the recorder themselves.
            const ids = new Set<number>(parsed);
            ids.add(row.started_by_user_id);
            attendeeUserIds = Array.from(ids);
          }
        } catch { /* fall through to channel members */ }
      }
      // Also check the in-memory set (covers the case where the interval ran
      // after the last DB persist).
      if (attendeeUserIds.length === 0) {
        const memSet = collectedUserIds.get(noteId);
        if (memSet && memSet.size > 0) {
          const ids = new Set<number>(memSet);
          ids.add(row.started_by_user_id);
          attendeeUserIds = Array.from(ids);
        }
      }
      // Final fallback: channel member roster.
      if (attendeeUserIds.length === 0) {
        attendeeUserIds = storage.listChannelMemberIds(row.channel_id);
      }
      // Clean up in-memory set for this note.
      collectedUserIds.delete(noteId);

      const attendees = attendeeUserIds
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

      // The summary card + email are the primary user-facing deliverables and
      // succeed independently of Synology. A NAS upload failure should NOT mark
      // the whole note "failed" — by this point the summary has already been
      // generated. The note now lands in 'awaiting_recipients' rather than
      // 'uploaded': the host has to pick recipients via the FE before the
      // email actually goes out. The channel card still fires unconditionally
      // (channel members already have access).
      const pendingSelection: RecipientSelection = {
        status: "pending",
        sentToUserIds: [],
      };
      updateNote(noteId, {
        status: "awaiting_recipients",
        synology_status: upload.status,
        synology_reason: upload.reason || null,
        synology_remote_path: upload.remotePath || null,
        duration_seconds: durationSec,
        error_message: null,
        recipient_selection_json: JSON.stringify(pendingSelection),
      });

      // 6) Notify: post the summary card to the channel right away. Channel
      // members can already see the note in the chat; email fan-out is the
      // privacy-sensitive step and is gated on the host's selection below.
      await postSummaryToChannel({
        noteId,
        channelId: row.channel_id,
        startedByUserId: row.started_by_user_id,
        title: summary.title,
        markdown: summary.markdown,
        durationSec,
        attendeeCount: attendees.length,
        pdfPath: upload.remotePath || null,
      });

      // Stash the email payload so resolveSummaryEmails() can fire later.
      // We persist via JSON on the row instead of in-memory so a server
      // restart doesn't lose the pending send.
      pendingEmailPayloads.set(noteId, {
        attendees,
        title: summary.title,
        markdown: summary.markdown,
        channelName,
        durationSec,
        contractAppUrl,
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

// Post a "Meeting notes ready" system card into the channel and broadcast it
// over SSE so anyone with the channel open sees it appear live. Mirrors what
// routes.ts does after storage.createMessage: build a wire shape + emit.
async function postSummaryToChannel(opts: {
  noteId: number;
  channelId: number;
  startedByUserId: number;
  title: string;
  markdown: string;
  durationSec: number;
  attendeeCount: number;
  pdfPath: string | null;
}): Promise<void> {
  try {
    const msg = storage.createMessage({
      channelId: opts.channelId,
      userId: opts.startedByUserId,
      content: "📝 Meeting notes ready",
      meta: JSON.stringify({
        system: true,
        kind: "meeting_summary",
        noteId: opts.noteId,
        title: opts.title,
        summaryPreview: opts.markdown.slice(0, 400),
        durationSeconds: opts.durationSec,
        attendeeCount: opts.attendeeCount,
        pdfPath: opts.pdfPath,
      }),
    } as any);

    // Resolve org for SSE fan-out: channel → project → orgId.
    const channel = storage.getChannel(opts.channelId);
    const project = channel ? storage.getProject(channel.projectId) : undefined;
    const author = storage.getUser(opts.startedByUserId);
    const initials = author
      ? author.name.split(/\s+/).slice(0, 2).map(s => s[0] ?? "").join("").toUpperCase()
      : "?";
    if (project) {
      const wire: WireMessage = {
        ...(msg as any),
        meta: (() => { try { return JSON.parse((msg as any).meta); } catch { return null; } })(),
        authorName: author?.name ?? "AI Clerk",
        authorHue: author?.hue ?? 215,
        authorRole: author?.role ?? "field",
        authorInitials: initials,
        reactions: [],
      } as any;
      emitMessageNew(project.orgId, wire);
    }
    console.log(`[meeting-clerk] posted summary card to channel ${opts.channelId} (note ${opts.noteId})`);
  } catch (err) {
    console.warn("[meeting-clerk] channel post failed:", (err as Error).message);
  }
}

// Email each attendee with an email the rendered summary. Gated on
// SENDGRID_API_KEY so we don't spin up sends when email isn't configured.
// Per-recipient try/catch so a single bad address doesn't drop the rest.
async function emailAttendeesSummary(opts: {
  attendees: Array<{ name: string; email: string }>;
  title: string;
  markdown: string;
  channelName: string;
  durationSec: number;
  contractAppUrl: string | null;
}): Promise<void> {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_API_KEY.trim()) {
    console.log("[meeting-clerk] SENDGRID_API_KEY not set — skipping attendee email");
    return;
  }
  const recipients = opts.attendees.filter(a => a.email && a.email.includes("@"));
  if (recipients.length === 0) return;

  const mins = Math.round(opts.durationSec / 60);
  const durationLabel = mins >= 1 ? `${mins} min` : `${opts.durationSec}s`;
  const attendeeList = opts.attendees.map(a => a.name || a.email).join(", ");

  let summaryHtml: string;
  try {
    summaryHtml = await marked.parse(opts.markdown);
  } catch {
    summaryHtml = `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(opts.markdown)}</pre>`;
  }

  const contractLink = opts.contractAppUrl
    ? `<p><a href="${escapeHtml(opts.contractAppUrl)}">View linked contract</a></p>`
    : "";

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a2e;max-width:640px;margin:0 auto">
      <h2 style="margin-bottom:4px">${escapeHtml(opts.title)}</h2>
      <p style="color:#666;font-size:13px;margin-top:0">
        Channel: <strong>${escapeHtml(opts.channelName)}</strong> · Duration: ${durationLabel} · Attendees: ${escapeHtml(attendeeList)}
      </p>
      ${contractLink}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0" />
      ${summaryHtml}
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0" />
      <p style="color:#999;font-size:11px">Generated by Bulldog Chat AI Clerk.</p>
    </div>`;

  const text = `${opts.title}\n\nChannel: ${opts.channelName}\nDuration: ${durationLabel}\nAttendees: ${attendeeList}\n${opts.contractAppUrl ? `Contract: ${opts.contractAppUrl}\n` : ""}\n${opts.markdown}`;

  const results = await Promise.all(
    recipients.map(async (a) => {
      try {
        const r = await sendEmail({
          to: a.email,
          subject: `Meeting notes: ${opts.title}`,
          text,
          html,
          fromEmail: "meetings@bulldogops.com",
        });
        return { email: a.email, ok: r.sent, reason: r.reason };
      } catch (err) {
        return { email: a.email, ok: false, reason: (err as Error).message };
      }
    }),
  );
  const sent = results.filter(r => r.ok).length;
  console.log(`[meeting-clerk] emailed summary to ${sent}/${recipients.length} attendees`);
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.warn("[meeting-clerk] email failures:", failed.map(f => `${f.email}: ${f.reason}`).join("; "));
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function listNotesForChannel(channelId: number): MeetingNoteRow[] {
  return rawDb.prepare(
    "SELECT * FROM meeting_notes WHERE channel_id = ? ORDER BY id DESC LIMIT 50"
  ).all(channelId) as MeetingNoteRow[];
}

export function getNote(noteId: number): MeetingNoteRow | undefined {
  return getNoteRow(noteId);
}

// Delete a single meeting note. We only remove the DB row; the Synology PDF
// (if uploaded) and the channel system message stay in place as a paper
// trail. Returns true if a row was deleted.
export function deleteNote(noteId: number): boolean {
  const r = rawDb.prepare("DELETE FROM meeting_notes WHERE id = ?").run(noteId);
  return r.changes > 0;
}

// Helper used by routes when serializing for the FE.
export function publicNoteShape(row: MeetingNoteRow) {
  let attendees: any[] = [];
  if (row.attendees_json) {
    try { attendees = JSON.parse(row.attendees_json); } catch { attendees = []; }
  }
  let recipientSelection: RecipientSelection | null = null;
  if (row.recipient_selection_json) {
    try { recipientSelection = JSON.parse(row.recipient_selection_json); } catch { recipientSelection = null; }
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
    recipientSelection,
    synologyStatus: row.synology_status,
    synologyRemotePath: row.synology_remote_path,
    synologyReason: row.synology_reason,
    pdfSizeBytes: row.pdf_size_bytes,
    durationSeconds: row.duration_seconds,
    errorMessage: row.error_message,
  };
}

// ---------------------------------------------------------------------------
// Recipient selection — host picks who gets the email summary at meeting end.
// ---------------------------------------------------------------------------

/**
 * Candidate recipients for the host to choose from. Returns the union of
 * tracked call participants + the channel-member fallback. Each row carries
 * enough for the UI: userId, name, email, and a `present` flag indicating
 * whether they were actually in the call (vs. a channel member who never
 * joined). The UI pre-checks `present=true` rows.
 */
export function getSummaryRecipientCandidates(noteId: number): Array<{
  userId: number;
  name: string;
  email: string;
  present: boolean;
}> {
  const row = getNoteRow(noteId);
  if (!row) return [];

  const presentIds = new Set<number>();
  if (row.participant_user_ids_json) {
    try {
      const parsed = JSON.parse(row.participant_user_ids_json) as number[];
      if (Array.isArray(parsed)) for (const id of parsed) presentIds.add(id);
    } catch { /* ignore */ }
  }
  presentIds.add(row.started_by_user_id);

  // Channel members are offered too (not pre-checked) so the host can add
  // someone who was invited but didn't actually join.
  const channelMemberIds = new Set<number>(storage.listChannelMemberIds(row.channel_id));

  const all = new Set<number>();
  presentIds.forEach((id) => all.add(id));
  channelMemberIds.forEach((id) => all.add(id));
  const out: Array<{ userId: number; name: string; email: string; present: boolean }> = [];
  const allIds: number[] = [];
  all.forEach((id) => allIds.push(id));
  for (const id of allIds) {
    const u = storage.getUser(id);
    if (!u || !u.email) continue;
    out.push({
      userId: id,
      name: u.name || u.email,
      email: u.email,
      present: presentIds.has(id),
    });
  }
  out.sort((a, b) => {
    if (a.present !== b.present) return a.present ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Reconstruct the email payload from the persisted note row when the
 * in-memory cache is empty (e.g. server restart between stopClerk and the
 * host clicking Send). Returns null if the row is too incomplete to email.
 */
function reconstructEmailPayload(row: MeetingNoteRow): PendingEmailPayload | null {
  if (!row.summary_text || !row.title) return null;
  let attendees: Array<{ name: string; email: string }> = [];
  if (row.attendees_json) {
    try {
      const parsed = JSON.parse(row.attendees_json);
      if (Array.isArray(parsed)) attendees = parsed.filter((a: any) => a?.email);
    } catch { /* ignore */ }
  }
  const channel = storage.getChannel(row.channel_id);
  const channelName = channel?.name || `channel-${row.channel_id}`;
  const contractAppUrl = (channel as any)?.linkedContract?.appUrl || null;
  return {
    attendees,
    title: row.title,
    markdown: row.summary_text,
    channelName,
    durationSec: row.duration_seconds ?? 0,
    contractAppUrl,
  };
}

/**
 * Host's decision: email the summary to the picked user ids. Looks up each
 * user's email from the canonical users table (NOT the attendees_json
 * snapshot) so a stale snapshot can't leak to the wrong address. Idempotent:
 * a second call after status=='sent' is a no-op.
 */
export async function sendSummaryEmails(
  noteId: number,
  recipientUserIds: number[],
  decidedByUserId: number,
): Promise<{ ok: boolean; status: string; delivered?: number; reason?: string }> {
  const row = getNoteRow(noteId);
  if (!row) return { ok: false, status: "not_found", reason: "note not found" };
  if (row.status !== "awaiting_recipients" && row.status !== "uploaded") {
    return { ok: false, status: row.status, reason: `note not ready (status=${row.status})` };
  }
  let existing: RecipientSelection | null = null;
  if (row.recipient_selection_json) {
    try { existing = JSON.parse(row.recipient_selection_json) as RecipientSelection; } catch { /* ignore */ }
  }
  if (existing?.status === "sent" || existing?.status === "skipped") {
    return { ok: true, status: row.status, reason: `already ${existing.status}` };
  }

  const uniqueIds = Array.from(new Set(recipientUserIds.filter(n => Number.isFinite(n))));
  const resolved: Array<{ userId: number; name: string; email: string }> = [];
  for (const id of uniqueIds) {
    const u = storage.getUser(id);
    if (u?.email) resolved.push({ userId: id, name: u.name || u.email, email: u.email });
  }
  if (resolved.length === 0) {
    return skipSummaryEmails(noteId, decidedByUserId);
  }

  let payload = pendingEmailPayloads.get(noteId) ?? null;
  if (!payload) payload = reconstructEmailPayload(row);
  if (!payload) {
    return { ok: false, status: row.status, reason: "summary payload unavailable" };
  }

  await emailAttendeesSummary({
    attendees: resolved.map(r => ({ name: r.name, email: r.email })),
    title: payload.title,
    markdown: payload.markdown,
    channelName: payload.channelName,
    durationSec: payload.durationSec,
    contractAppUrl: payload.contractAppUrl,
  });

  const selection: RecipientSelection = {
    status: "sent",
    sentToUserIds: resolved.map(r => r.userId),
    decidedAt: nowMs(),
    decidedByUserId,
  };
  updateNote(noteId, {
    status: "uploaded",
    recipient_selection_json: JSON.stringify(selection),
  });
  pendingEmailPayloads.delete(noteId);

  return { ok: true, status: "uploaded", delivered: resolved.length };
}

/**
 * Host's decision: do NOT send the email at all. Flips the note to
 * 'uploaded' with selection.status='skipped' so the UI stops nagging.
 */
export function skipSummaryEmails(
  noteId: number,
  decidedByUserId: number,
): { ok: boolean; status: string; reason?: string } {
  const row = getNoteRow(noteId);
  if (!row) return { ok: false, status: "not_found", reason: "note not found" };
  if (row.status !== "awaiting_recipients" && row.status !== "uploaded") {
    return { ok: false, status: row.status, reason: `note not ready (status=${row.status})` };
  }
  let existing: RecipientSelection | null = null;
  if (row.recipient_selection_json) {
    try { existing = JSON.parse(row.recipient_selection_json) as RecipientSelection; } catch { /* ignore */ }
  }
  if (existing?.status === "sent" || existing?.status === "skipped") {
    return { ok: true, status: row.status, reason: `already ${existing.status}` };
  }
  const selection: RecipientSelection = {
    status: "skipped",
    sentToUserIds: [],
    decidedAt: nowMs(),
    decidedByUserId,
  };
  updateNote(noteId, {
    status: "uploaded",
    recipient_selection_json: JSON.stringify(selection),
  });
  pendingEmailPayloads.delete(noteId);
  return { ok: true, status: "uploaded" };
}
