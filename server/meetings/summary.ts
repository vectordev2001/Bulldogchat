import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import { meetingNotes } from "@shared/schema";
import { getMeetingById, resolveSummaryRecipients } from "../storage/meetings";
import { sendEmail, isEmailConfigured } from "../email";

/**
 * Deliver a meeting's AI summary to its resolved recipients at meeting end.
 *
 * The transcript/summary itself is produced by the existing Meeting Clerk
 * pipeline, which writes to `meeting_notes`. When a clerk note is linked to
 * this meeting (meeting_notes.meeting_id) and has a summary, we fan it out to
 * the recipients implied by the meeting's summaryRecipientPolicy (plus any
 * hand-added explicit rows). Email transport mirrors scheduled-calls.ts.
 *
 * No-ops quietly when: summaries are disabled, no linked note/summary exists
 * yet, there are no recipients, or email isn't configured. Callers invoke this
 * fire-and-forget — it must never throw into the request path.
 */
export async function deliverMeetingSummary(meetingId: string): Promise<{ delivered: number; reason?: string }> {
  const meeting = getMeetingById(meetingId);
  if (!meeting) return { delivered: 0, reason: "meeting not found" };
  if (!meeting.summaryEnabled || meeting.summaryRecipientPolicy === "none") {
    return { delivered: 0, reason: "summaries disabled" };
  }

  // Find the most recent clerk note linked to this meeting that has a summary.
  const note = db
    .select()
    .from(meetingNotes)
    .where(eq(meetingNotes.meetingId, meetingId))
    .orderBy(desc(meetingNotes.startedAt))
    .get();
  const summaryText = note?.summaryText?.trim();
  if (!summaryText) return { delivered: 0, reason: "no summary available" };

  const recipients = resolveSummaryRecipients(meetingId).filter((r) => !!r.email);
  if (recipients.length === 0) return { delivered: 0, reason: "no recipients" };

  if (!isEmailConfigured()) {
    console.warn(`[meetings] summary ready for ${meetingId} but email not configured`);
    return { delivered: 0, reason: "email not configured" };
  }

  const title = meeting.title || note?.title || "Bulldog meeting";
  const subject = `Meeting summary — ${title}`;
  const text = [
    `Summary of "${title}"`,
    meeting.endedAt ? `Ended: ${new Date(meeting.endedAt).toLocaleString()}` : "",
    "",
    summaryText,
    "",
    "— Bulldog Chat Meeting Clerk",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;color:#1a2b2b;line-height:1.5">
      <h2 style="margin:0 0 4px">Meeting summary</h2>
      <p style="margin:0 0 12px;color:#5a6b6b"><strong>${escapeHtml(title)}</strong>${
        meeting.endedAt ? ` &middot; ${escapeHtml(new Date(meeting.endedAt).toLocaleString())}` : ""
      }</p>
      <div style="white-space:pre-wrap;border-left:3px solid #0d9488;padding-left:12px">${escapeHtml(summaryText)}</div>
      <p style="margin-top:16px;color:#8a9b9b;font-size:12px">— Bulldog Chat Meeting Clerk</p>
    </div>`;

  let delivered = 0;
  for (const r of recipients) {
    if (!r.email) continue;
    const result = await sendEmail({ to: r.email, subject, text, html });
    if (result.sent) delivered++;
    else console.warn(`[meetings] summary email to ${r.email} failed: ${result.reason}`);
  }

  return { delivered };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
