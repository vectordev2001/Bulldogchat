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
  | "live_call_invite";   // immediate ring on outbound dial

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
    const data = (await res.json()) as {
      smsConsent?: string;
      phoneE164?: string | null;
      events?: Record<string, { smsEnabled?: boolean }>;
    };
    const consent = data.smsConsent;
    const phone = data.phoneE164 ?? null;
    const eventEnabled = data.events?.[event]?.smsEnabled !== false; // default true within consent
    if (consent !== "granted") {
      return { allowed: false, phoneE164: phone, reason: "no-consent" };
    }
    if (!eventEnabled) {
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
