/**
 * invite-email.ts — text + HTML body templates for meeting invite emails.
 *
 * Used by POST /api/meetings (channel-meeting create) and POST
 * /api/meetings/:code/invite (mid-meeting add). Mirrors the visual style of
 * scheduled-calls.ts email invites so the brand feels consistent.
 *
 * Plain-text first: every paragraph in the HTML has a text equivalent so
 * locked-down corporate mail clients still render a usable invite.
 */

function escH(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface MeetingInviteEmailInput {
  hostName: string;
  joinUrl: string;
  title: string | null;
  teamsJoinUrl: string | null;
  channelName?: string | null;
}

export interface MeetingInviteEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildMeetingInviteEmail(
  input: MeetingInviteEmailInput,
): MeetingInviteEmail {
  const title =
    input.title?.trim() ||
    (input.channelName ? `Meeting in #${input.channelName}` : "Bulldog meeting");
  const subject = `${input.hostName} invited you: ${title}`;

  const teamsLine = input.teamsJoinUrl
    ? `Join via Microsoft Teams: ${input.teamsJoinUrl}`
    : null;

  const text = [
    `${input.hostName} invited you to a Bulldog meeting.`,
    ``,
    `Title: ${title}`,
    `Join:  ${input.joinUrl}`,
    ...(teamsLine ? [teamsLine] : []),
    ``,
    `Open the link above to join from your browser or the Bulldog app.`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f5f7;color:#191E4A;padding:24px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;">
<h2 style="color:#191E4A;margin-top:0">${escH(title)}</h2>
<p style="color:#191E4A"><strong>${escH(input.hostName)}</strong> invited you to join a Bulldog meeting.</p>
<p style="margin:20px 0 6px;text-align:center">
  <a href="${escH(input.joinUrl)}" style="display:inline-block;padding:14px 32px;background:#191E4A;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Join meeting</a>
</p>${
    input.teamsJoinUrl
      ? `<p style="text-align:center;margin-top:8px"><a href="${escH(input.teamsJoinUrl)}" style="display:inline-block;padding:10px 20px;background:#5b5fc7;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Join via Microsoft Teams</a></p>`
      : ""
  }
<p style="margin-top:24px;font-size:12px;color:#6b7280;">You received this because you're a member of a Bulldog channel where this meeting was started.</p>
</div>
</body></html>`;

  return { subject, text, html };
}
