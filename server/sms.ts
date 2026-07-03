/**
 * Twilio SMS helper for Bulldog Chat.
 *
 * Uses Twilio's REST API directly (no SDK) to keep the dependency
 * footprint small. Required env:
 *   TWILIO_ACCOUNT_SID            — account SID
 *   TWILIO_AUTH_TOKEN             — account auth token
 *   One of:
 *     TWILIO_MESSAGING_SERVICE_SID  — preferred: "MGxxxx" SID of a Messaging
 *                                    Service. Use this when you have an A2P
 *                                    10DLC campaign attached so Twilio picks
 *                                    the right sender pool and you don't get
 *                                    blocked by carrier filtering. When this
 *                                    is set, TWILIO_FROM_NUMBER is ignored.
 *     TWILIO_FROM_NUMBER            — E.164 sender (e.g. +15551234567);
 *                                    must be SMS-capable. Used only when no
 *                                    Messaging Service SID is configured.
 *
 * Best-effort: failures are logged and surfaced to the caller as warnings
 * but never throw past the call site. SMS is a nice-to-have alongside the
 * SIP voice ring.
 */
import jwt from "jsonwebtoken";

// Boot-time check (runs once on module load): the auth consent gate
// (server/auth-consent.ts) fails closed when SUITE_INTERNAL_SECRET is unset,
// which means ALL outbound SMS is skipped. Warn loudly so a misconfigured
// prod/preview deploy doesn't silently drop every notification.
if (!process.env.SUITE_INTERNAL_SECRET) {
  console.warn("[sms] SUITE_INTERNAL_SECRET unset — all outbound SMS will be skipped (auth consent gate fails closed)");
}

function smsConfigured(): boolean {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return false;
  // Either a Messaging Service SID OR a from-number is enough to send.
  return !!(process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER);
}

export function smsAvailable(): boolean {
  return smsConfigured();
}

interface SendSmsParams {
  to: string;            // E.164
  body: string;          // <= 1600 chars; Twilio segments automatically
}

interface SendSmsResult {
  ok: boolean;
  sid?: string;
  error?: string;
}

export async function sendSms({ to, body }: SendSmsParams): Promise<SendSmsResult> {
  if (!smsConfigured()) {
    return { ok: false, error: "SMS not configured (need TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + either TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER)" };
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const authToken = process.env.TWILIO_AUTH_TOKEN!;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const form = new URLSearchParams();
  form.set("To", to);
  // Prefer MessagingServiceSid when configured: Twilio routes through the
  // attached A2P 10DLC campaign sender pool which has much higher
  // deliverability than an unverified toll-free or raw long code. Fall
  // back to a single From number for dev/local setups.
  if (messagingServiceSid) {
    form.set("MessagingServiceSid", messagingServiceSid);
  } else if (fromNumber) {
    form.set("From", fromNumber);
  }
  form.set("Body", body);
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Twilio ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = (await resp.json()) as { sid?: string };
    return { ok: true, sid: data.sid };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "unknown" };
  }
}

/**
 * Mint a short-lived JWT that grants the bearer permission to join a
 * specific LiveKit room as a specific user. 60 minutes is the maximum
 * useful window — anything longer is a security smell. We sign with the
 * chat JWT_SECRET so the redeem endpoint can verify without sharing keys.
 */
export interface CallJoinTokenPayload {
  userId: number;
  roomName: string;
  callerName: string;
  kind: "voice" | "video";
  channelId?: number | null;
}

export function signCallJoinToken(p: CallJoinTokenPayload): string {
  const secret = process.env.JWT_SECRET || "dev-secret";
  return jwt.sign(
    {
      cj: 1, // type marker so we can distinguish from regular vc_token
      uid: p.userId,
      room: p.roomName,
      cn: p.callerName,
      k: p.kind,
      ...(p.channelId != null ? { ch: p.channelId } : {}),
    },
    secret,
    { expiresIn: "60m" },
  );
}

export function verifyCallJoinToken(token: string): CallJoinTokenPayload | null {
  try {
    const secret = process.env.JWT_SECRET || "dev-secret";
    const payload = jwt.verify(token, secret) as {
      cj?: number;
      uid?: number;
      room?: string;
      cn?: string;
      k?: "voice" | "video";
      ch?: number | null;
    };
    if (payload.cj !== 1 || !payload.uid || !payload.room) return null;
    return {
      userId: payload.uid,
      roomName: payload.room,
      callerName: payload.cn || "Someone",
      kind: payload.k === "video" ? "video" : "voice",
      channelId: payload.ch ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Normalize a raw phone string to E.164, returning null when it can't be
 * confidently parsed. Mirrors the normalizer in scheduled-calls.ts so callers
 * inviting external (non-user) numbers have one canonical helper to reach for.
 * US-centric: bare 10-digit numbers get a +1; anything already starting with
 * "+" is trusted if it has enough digits.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (String(raw).trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Build the SMS body for a Bulldog Meet invite sent at meeting-create time.
 * Title is optional (quick meetings may be untitled) and trimmed to ~60 chars
 * so the whole message stays close to a single 160-char segment.
 */
export function buildMeetingInviteSmsBody(p: {
  hostName: string;
  joinUrl: string;
  title?: string | null;
  teamsJoinUrl?: string | null;
}): string {
  const title = p.title?.trim();
  const trimmed = title && title.length > 60 ? `${title.slice(0, 59)}…` : title;
  const titlePart = trimmed ? `: "${trimmed}"` : "";
  // When a Teams meeting was minted in parallel (Phase 0 interop), include
  // it as a second join line so external invitees who only have a Teams
  // client can still join. Most US carriers split SMS into 160-char
  // segments; with two URLs we typically land in 2 segments — acceptable
  // for invite blasts. STOP keyword and Twilio opt-out still apply.
  const teamsPart = p.teamsJoinUrl
    ? `\nOr via Teams: ${p.teamsJoinUrl}`
    : "";
  return `${p.hostName} invited you to a Bulldog meeting${titlePart}. Join: ${p.joinUrl}${teamsPart}`;
}

/**
 * Build the SMS body for an immediate call invite. Kept terse — most
 * carriers split at 160 chars and we want a single segment when possible.
 * The link is the join-token URL which auto-redirects into the LiveKit
 * room (after SSO login).
 */
export function buildCallInviteSmsBody(p: {
  callerName: string;
  channelLabel: string;
  joinUrl: string;
  kind: "voice" | "video";
  shortUrl?: string;
}): string {
  const verb = p.kind === "video" ? "video call" : "call";
  // Exactly one URL: the short link when present (it matches the AASA /j/*
  // pattern, so iOS auto-routes it into the app when installed and to Safari
  // otherwise), falling back to the long join URL. No custom-scheme line —
  // the shipping app registers no bulldogchat:// scheme; Universal Links
  // handle app routing now.
  const link = p.shortUrl || p.joinUrl;
  return `${p.callerName} is starting a ${verb} on Bulldog (${p.channelLabel}). Join: ${link}`;
}

/**
 * Build the SMS body for a scheduled-call invite. Includes the time in the
 * recipient's-likely timezone (we render as 'h:mm a TZ' — we don't know their
 * TZ for sure, so we pass the organizer's). Two links: Join (drops them in
 * the call) and RSVP (opens a web page with Yes/No/Maybe buttons, same page
 * the email buttons hit). Reply-based RSVP was removed in SW 1.5.45 as
 * confusing — parseRsvpSms still handles it if anyone replies "Y/N/M" but the
 * SMS no longer advertises it.
 *
 * `rsvpCode` is retained in the signature for callers that still generate it
 * (it's persisted on the invitee row for reply parsing) but is not rendered
 * into the body.
 */
export function buildScheduledCallSmsBody(p: {
  organizerName: string;
  title: string;
  whenLabel: string;       // pre-formatted, e.g. "Tue Jun 2 at 3:00 PM PDT"
  joinUrl: string;
  rsvpCode: string;        // legacy: persisted on invitee row for reply parsing; unused in body
  shortUrl?: string;
  rsvpUrl?: string;        // tappable RSVP page URL (opens Yes/No/Maybe web page)
}): string {
  // Two-URL body: Join = one-tap into the call; RSVP = record response
  // without joining. Most invites still fit in ~2 SMS segments; parity with
  // the email UX (Join button + 3 RSVP buttons) is worth the extra segment.
  const link = p.shortUrl || p.joinUrl;
  const rsvpLine = p.rsvpUrl ? `\nRSVP: ${p.rsvpUrl}` : "";
  return `${p.organizerName} invited you to a Bulldog call: "${p.title}" on ${p.whenLabel}. Join: ${link}${rsvpLine}`;
}

/**
 * Build the reminder SMS sent ~5 min before a scheduled call. Short and
 * actionable.
 */
export function buildReminderSmsBody(p: {
  title: string;
  minutesUntilStart: number;
  joinUrl: string;
  shortUrl?: string;
}): string {
  const m = Math.max(1, Math.round(p.minutesUntilStart));
  // Exactly one URL: short link when present (Universal-Link routed), else
  // the long join URL.
  const link = p.shortUrl || p.joinUrl;
  return `Reminder: "${p.title}" starts in ${m} min on Bulldog. Join: ${link}`;
}

/**
 * Parse an inbound SMS body for an RSVP. Twilio webhook hands us the raw
 * Body field; users may reply in many shapes:
 *   "#A4F9 Y"  "#a4f9 yes"  "A4F9 maybe"  "yes #A4F9"  etc.
 * We extract the 4-hex RSVP code and a Y/N/M response. Returns null if we
 * can't confidently parse both pieces.
 */
export function parseRsvpSms(body: string): { code: string; response: "yes" | "no" | "maybe" } | null {
  if (!body) return null;
  const codeMatch = body.match(/#?([A-Za-z0-9]{4,8})/);
  if (!codeMatch) return null;
  const code = codeMatch[1].toUpperCase();
  const low = body.toLowerCase();
  // Order matters: "maybe" before "m" before "yes" so we don't false-match.
  let response: "yes" | "no" | "maybe" | null = null;
  if (/\b(yes|y|going|in|attending|accept|ok|okay)\b/.test(low)) response = "yes";
  else if (/\b(no|n|out|decline|cannot|can't|cant|skip)\b/.test(low)) response = "no";
  else if (/\b(maybe|m|tentative|tent|unsure)\b/.test(low)) response = "maybe";
  if (!response) return null;
  return { code, response };
}

/**
 * Generate a short RSVP code from a scheduled-call id + a salt. Format:
 * "A4F9" (4 hex). Collision risk is acceptable: we scope lookup by phone
 * number + a 7-day window, so even a 4-hex collision is recoverable.
 */
export function generateRsvpCode(scheduledCallId: number): string {
  const seed = `${scheduledCallId}:${process.env.JWT_SECRET || "dev"}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  // 4-hex uppercase, padded.
  const hex = (Math.abs(hash) % 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return hex;
}

/**
 * Twilio signature verification for inbound webhooks. Twilio signs each
 * request with HMAC-SHA1 over the full URL + sorted POST params, using
 * the account auth token. We use this to verify the inbound SMS webhook
 * isn't spoofed. Returns true on valid signature OR when no auth token
 * is configured (dev mode).
 */
export function verifyTwilioSignature(p: {
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true; // dev mode, no verification
  if (!p.signature) return false;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("crypto") as typeof import("crypto");
  const sortedKeys = Object.keys(p.params).sort();
  let data = p.url;
  for (const k of sortedKeys) data += k + p.params[k];
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  return expected === p.signature;
}

/**
 * Build a minimal iCalendar (.ics) string for a scheduled call. Designed
 * to be a single .ics attachment that imports cleanly into Outlook,
 * Google Calendar, and Apple Calendar.
 */
export function buildIcsForScheduledCall(p: {
  uid: string;            // stable across invites; "<id>@bulldogops.com"
  title: string;
  description: string;    // include join URL in the body
  startUtc: Date;
  endUtc: Date;
  organizerEmail: string;
  organizerName: string;
  attendeeEmails: string[];
  joinUrl: string;
  location?: string;
  sequence?: number;      // bump on updates; default 0
  method?: "REQUEST" | "CANCEL";
}): string {
  const fmt = (d: Date): string =>
    d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const esc = (s: string): string =>
    s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Bulldog Ops//Bulldog Chat//EN",
    `METHOD:${p.method || "REQUEST"}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${p.uid}`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(p.startUtc)}`,
    `DTEND:${fmt(p.endUtc)}`,
    `SUMMARY:${esc(p.title)}`,
    `DESCRIPTION:${esc(p.description)}`,
    p.location ? `LOCATION:${esc(p.location)}` : `LOCATION:${esc(p.joinUrl)}`,
    `URL:${p.joinUrl}`,
    `ORGANIZER;CN=${esc(p.organizerName)}:mailto:${p.organizerEmail}`,
    ...p.attendeeEmails.map(
      (e) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${e}`,
    ),
    `SEQUENCE:${p.sequence ?? 0}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // RFC5545: lines must be CRLF-delimited and <= 75 octets (we ignore the
  // 75-octet rule for simplicity — modern parsers tolerate longer lines).
  return lines.join("\r\n") + "\r\n";
}
