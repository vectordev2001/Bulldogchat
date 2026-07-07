/**
 * SMS consent gate — defers to bulldog-auth (auth.bulldogops.com) as the
 * single source of truth for SMS notification preferences and TCPA consent
 * across the suite. Bulldog Chat previously sent SMS directly via Twilio with
 * no consent check; this module closes that gap so a recipient without
 * smsConsentStatus = "granted" is never texted.
 *
 * Preferences are keyed by EMAIL (the stable cross-app identity used by SSO +
 * user-sync), because per-app DB user IDs differ. Service-to-service auth uses
 * the shared SUITE_INTERNAL_SECRET (X-Suite-Secret header), the same pattern
 * already used for the contracts PDF proxy and integrations endpoints.
 *
 * Fail-closed: if the secret is unset (local/dev) or the lookup fails
 * (network, auth unreachable, non-2xx), this returns { allowed: false }.
 * Skipping a few notifications is acceptable; texting a non-consenting
 * recipient is a TCPA risk.
 */

const AUTH_BASE = process.env.AUTH_BASE_URL ?? "https://auth.bulldogops.com";
const SUITE_INTERNAL_SECRET = process.env.SUITE_INTERNAL_SECRET;

export type EventKey =
  | "meeting_invite"      // scheduled-call invite
  | "meeting_reminder"    // scheduled-call ~5min reminder
  | "live_call_invite"    // immediate ring on outbound dial
  | "chat_dm_notify"      // DM received (opt-in SMS mirror of push)
  | "chat_mention_notify";// @-mention in a channel (opt-in SMS mirror of push)

export interface ConsentLookup {
  allowed: boolean;          // overall: is SMS permitted?
  phoneE164: string | null;  // canonical phone to use (overrides what caller passed)
  reason?: string;           // "no-consent" | "event-disabled" | "no-phone" | "no-secret" | "lookup-failed"
}

/**
 * Ask bulldog-auth whether SMS is allowed for this user+event.
 *
 * If SUITE_INTERNAL_SECRET is unset (local/dev), this returns
 * { allowed: false, reason: "no-secret" } — fail-closed.
 *
 * If the lookup itself fails (network, auth unreachable), also fail-closed.
 * Better to skip a few notifications than to send to a non-consenting recipient.
 */
/**
 * Normalize whatever auth returns (10-digit US, already-E.164, or null) to
 * a canonical E.164 string. Auth's `phone` field is typically 10 digits
 * stripped of +1 — see server response shape comment in checkSmsConsent.
 */
function normalizePhoneToE164(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // unknown shape — fail safe
}

export async function checkSmsConsent(
  email: string,
  event: EventKey,
): Promise<ConsentLookup> {
  if (!SUITE_INTERNAL_SECRET) {
    return { allowed: false, phoneE164: null, reason: "no-secret" };
  }
  if (!email) {
    return { allowed: false, phoneE164: null, reason: "no-consent" };
  }
  try {
    const res = await fetch(`${AUTH_BASE}/internal/notification-prefs/lookup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Suite-Secret": SUITE_INTERNAL_SECRET,
      },
      body: JSON.stringify({ email, eventType: event }),
    });
    if (!res.ok) {
      return { allowed: false, phoneE164: null, reason: "lookup-failed" };
    }
    // Auth response shape (verified live against auth.bulldogops.com):
    //   { found, userId, email, phone, smsConsentStatus, prefs: {
    //       smsMasterEnabled, smsMeetingInvite, smsJobAssignment,
    //       smsChannelAdd, smsDispatch, smsContractCreated, smsContractUpdated } }
    // `phone` is 10-digit US (no +1) when present; normalize to E.164 here.
    const data = (await res.json()) as {
      found?: boolean;
      smsConsentStatus?: string;
      phone?: string | null;
      prefs?: {
        smsMasterEnabled?: boolean;
        smsMeetingInvite?: boolean;
        smsJobAssignment?: boolean;
        smsChannelAdd?: boolean;
        smsDispatch?: boolean;
        smsContractCreated?: boolean;
        smsContractUpdated?: boolean;
      };
    };
    if (data.found === false) {
      return { allowed: false, phoneE164: null, reason: "no-consent" };
    }
    const consent = data.smsConsentStatus;
    const phone = normalizePhoneToE164(data.phone ?? null);
    // Auth exposes per-event flags as camelCase booleans on `prefs`. Map our
    // event keys to those flags. Master toggle gates the whole thing.
    const masterEnabled = data.prefs?.smsMasterEnabled !== false;
    const eventFlag = (() => {
      switch (event) {
        case "meeting_invite":
        case "meeting_reminder":
        case "live_call_invite":
          return data.prefs?.smsMeetingInvite;
        case "chat_dm_notify":
        case "chat_mention_notify":
          // No dedicated auth flag yet — gate on master + consent + phone.
          // Once bulldog-auth adds a smsChatDmMentions preference, map it here.
          // Fail-closed on missing master flag is enough for TCPA compliance.
          return undefined;
        default:
          return undefined;
      }
    })();
    const eventEnabled = eventFlag !== false; // default true within consent
    if (consent !== "granted") {
      return { allowed: false, phoneE164: phone, reason: "no-consent" };
    }
    if (!masterEnabled || !eventEnabled) {
      return { allowed: false, phoneE164: phone, reason: "event-disabled" };
    }
    if (!phone) {
      return { allowed: false, phoneE164: null, reason: "no-phone" };
    }
    return { allowed: true, phoneE164: phone };
  } catch (e) {
    return { allowed: false, phoneE164: null, reason: "lookup-failed" };
  }
}
