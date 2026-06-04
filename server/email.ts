/**
 * email.ts — SendGrid-only email module for Bulldog Chat.
 * Adapted from bulldog-contracts/server/email.ts but fetch-based only,
 * no nodemailer dependency.
 */

export type EmailProvider = "sendgrid" | "none";

export function detectEmailProvider(): EmailProvider {
  if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_API_KEY.trim()) {
    return "sendgrid";
  }
  return "none";
}

export function isEmailConfigured(): boolean {
  return detectEmailProvider() !== "none";
}

export function emailFromAddress(): string {
  return (
    process.env.SENDGRID_FROM_EMAIL?.trim() ||
    "no-reply@bulldogops.com"
  );
}

export function emailFromName(): string {
  return (
    process.env.SENDGRID_FROM_NAME?.trim() ||
    "Bulldog Chat"
  );
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
  /** Override the default From address (e.g. meetings@bulldogops.com). */
  fromEmail?: string;
  fromName?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  if (!apiKey) {
    return { sent: false, reason: "SENDGRID_API_KEY is not set" };
  }

  const fromEmail = opts.fromEmail?.trim() || emailFromAddress();
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to]).filter(Boolean);
  if (recipients.length === 0) {
    return { sent: false, reason: "No recipient email" };
  }

  const payload: Record<string, unknown> = {
    personalizations: [{ to: recipients.map((email) => ({ email })) }],
    from: { email: fromEmail, name: opts.fromName?.trim() || emailFromName() },
    subject: opts.subject,
    content: [
      { type: "text/plain", value: opts.text },
      ...(opts.html ? [{ type: "text/html", value: opts.html }] : []),
    ],
    ...(opts.attachments?.length
      ? {
          attachments: opts.attachments.map((a) => ({
            content: a.content.toString("base64"),
            filename: a.filename,
            // SendGrid rejects semicolons/CRLF in the type field. Strip params
            // (e.g. text/calendar; method=REQUEST) down to the bare MIME.
            type: String(a.contentType).split(";")[0].trim(),
            disposition: "attachment",
          })),
        }
      : {}),
  };

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (res.status >= 200 && res.status < 300) {
      return { sent: true };
    }
    const text = await res.text().catch(() => "");
    return {
      sent: false,
      reason: `SendGrid responded with ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "SendGrid request failed",
    };
  }
}
