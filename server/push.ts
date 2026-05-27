import webpush from "web-push";
import { storage } from "./storage";
import { sendExpoNotificationToUsers } from "./expo-push";

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

export async function sendNotificationToUsers(userIds: number[], payload: PushPayload) {
  if (userIds.length === 0) return;

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
