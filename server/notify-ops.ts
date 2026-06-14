/**
 * Cross-app notification emitter: Bulldog Chat → Bulldog Ops.
 *
 * Chat and Ops have SEPARATE databases and independent auto-increment user IDs,
 * so we cannot share a notification_events table or trust a numeric userId
 * across the boundary. Instead we POST the event to ops keyed on the user's
 * EMAIL (the stable cross-app identifier already used by SSO + user-sync), and
 * ops resolves it via getUserByEmail and applies its own consent gate + toggles
 * + escalation. authSub is sent as an optional fallback.
 *
 * Best-effort and fire-and-forget: a failure here must never break channel adds
 * or meeting scheduling. Errors are logged, not thrown.
 *
 * Env:
 *   OPS_NOTIFY_URL              ops emit endpoint
 *                               (default https://ops.bulldogops.com/api/notifications/emit)
 *   INBOUND_NOTIFICATION_TOKEN  shared secret; sent as X-Bulldog-Token header
 */

type OpsEventType = "channel_add" | "meeting_invite";

interface EmitOpsParams {
  email: string;
  authSub?: string | null;
  eventType: OpsEventType;
  payload?: Record<string, unknown>;
  linkUrl?: string | null;
  message?: string | null;
}

function opsNotifyUrl(): string {
  return process.env.OPS_NOTIFY_URL || "https://ops.bulldogops.com/api/notifications/emit";
}

function configured(): boolean {
  return !!process.env.INBOUND_NOTIFICATION_TOKEN;
}

export async function emitOpsNotification(p: EmitOpsParams): Promise<void> {
  if (!configured()) {
    // No token → ops integration not wired up in this environment. Skip quietly.
    return;
  }
  if (!p.email) return;
  try {
    const res = await fetch(opsNotifyUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bulldog-Token": process.env.INBOUND_NOTIFICATION_TOKEN as string,
      },
      body: JSON.stringify({
        email: p.email,
        authSub: p.authSub ?? undefined,
        eventType: p.eventType,
        payload: p.payload ?? {},
        linkUrl: p.linkUrl ?? undefined,
        message: p.message ?? undefined,
      }),
    });
    if (!res.ok) {
      console.warn(`[notify-ops] ${p.eventType} → ops returned ${res.status}`);
    }
  } catch (e) {
    console.warn(`[notify-ops] ${p.eventType} emit failed:`, (e as Error).message);
  }
}

/** Emit to many recipients in parallel; never throws. */
export async function emitOpsNotifications(
  recipients: { email: string; authSub?: string | null }[],
  base: Omit<EmitOpsParams, "email" | "authSub">,
): Promise<void> {
  await Promise.all(
    recipients
      .filter((r) => !!r.email)
      .map((r) => emitOpsNotification({ ...base, email: r.email, authSub: r.authSub ?? null })),
  );
}
