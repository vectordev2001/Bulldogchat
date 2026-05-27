import webpush from "web-push";
import { storage } from "./storage";

let configured = false;

export function setupWebPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@vectorservicesus.com";
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

export async function sendNotificationToUsers(userIds: number[], payload: {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}) {
  if (!configured || userIds.length === 0) return;
  const subs = storage.listPushSubscriptionsForUsers(userIds);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
      );
    } catch (err: any) {
      // 410 = gone, drop the subscription
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        storage.deletePushSubscription(s.id, s.userId);
      }
    }
  }));
}
