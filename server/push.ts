import webpush from "web-push";
import { storage } from "./storage";
import { sendExpoNotificationToUsers } from "./expo-push";
import { rawDb } from "./db";
import { canSeeChannel, computeAccess } from "./multitenant-access";

let configured = false;

export function setupWebPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:chat@bulldogops.com";
  if (pub && priv) {
    try {
      webpush.setVapidDetails(subject, pub, priv);
      configured = true;
    } catch (err) {
      console.warn("Web push: invalid VAPID keys, disabled.", err);
    }
  }
}

export function pushConfigured(): boolean {
  return configured;
}

export function getPublicVapidKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  icon?: string;
  badge?: string;
}

export async function sendNotificationToUsers(
  userIds: number[],
  payload: PushPayload,
  opts?: { channelId?: number },
) {
  if (userIds.length === 0) return;

  // Multi-tenant access gate: when MULTITENANT_MODE is on and the caller
  // supplied a source channelId, drop any recipient who can't see that
  // channel. Prevents push notifications from leaking across tenants if
  // legacy membership rows (project_members, channel_members) somehow
  // include users without a matching user_project_regions grant.
  if (process.env.MULTITENANT_MODE === "1" && opts?.channelId) {
    try {
      const ch = rawDb
        .prepare(`SELECT project_id AS projectId, region_id AS regionId FROM channels WHERE id = ?`)
        .get(opts.channelId) as { projectId: number; regionId: number | null } | undefined;
      if (ch) {
        const targets = storage.listUsersByIds(userIds);
        const roleByUser = new Map(targets.map(u => [u.id, u.role]));
        userIds = userIds.filter(id => {
          // Map chat role -> auth global role for access compute. Same
          // mapping used in auth.ts buildAccessForUser.
          const role = roleByUser.get(id) === "admin" ? "super_admin" : null;
          const access = computeAccess(id, role);
          return canSeeChannel(access, ch.projectId, ch.regionId);
        });
        if (userIds.length === 0) return;
      }
    } catch (e) {
      console.warn("[push] multitenant gate failed, falling back to caller-supplied list:", e);
    }
  }

  // Phase 1.9 DND gating: respect recipient presence. Users in "busy" (red
  // dot) explicitly asked not to be pinged — skip both web push and Expo.
  // "offline" still receives so the message is waiting when they come
  // back; "away" also still receives because that's just an idle hint.
  try {
    const targets = storage.listUsersByIds(userIds);
    const allowed = new Set(
      targets.filter(u => (u.presence ?? "online") !== "busy").map(u => u.id),
    );
    userIds = userIds.filter(id => allowed.has(id));
    if (userIds.length === 0) return;
  } catch (e) {
    console.warn("[push] presence gate failed, sending anyway:", e);
  }

  // Always try Expo in parallel (it's a no-op if no tokens / not configured)
  const expoPromise = sendExpoNotificationToUsers(userIds, payload).catch(err => {
    console.warn("[push] expo send err:", err);
  });

  if (configured) {
    const subs = storage.listPushSubscriptionsForUsers(userIds);
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            url: payload.url,
            tag: payload.tag,
            icon: payload.icon ?? "/icon-192.png",
            badge: payload.badge ?? "/badge.png",
          }),
        );
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          storage.deletePushSubscription(s.id, s.userId);
        }
      }
    }));
  }
  await expoPromise;
}
