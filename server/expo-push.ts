// Expo push notification helper. Sends to expo_push_tokens for given users.

import { storage } from "./storage";

let _expoLoaded: any = null;
async function loadExpoModule() {
  if (_expoLoaded) return _expoLoaded;
  try {
    const mod = await import("expo-server-sdk");
    _expoLoaded = (mod as any).default ?? mod;
  } catch (err) {
    console.warn("[expo-push] expo-server-sdk not loadable:", err);
  }
  return _expoLoaded;
}

export interface ExpoPushPayload {
  title: string;
  body: string;
  url?: string;
  data?: Record<string, unknown>;
}

export async function sendExpoNotificationToUsers(userIds: number[], payload: ExpoPushPayload) {
  if (userIds.length === 0) return;
  const tokens = storage.listExpoTokensForUsers(userIds);
  if (tokens.length === 0) return;
  const ExpoMod = await loadExpoModule();
  if (!ExpoMod) return;
  const Expo = ExpoMod.Expo ?? ExpoMod.default?.Expo ?? ExpoMod;
  const expo = new Expo();

  const messages = tokens
    .filter(t => Expo.isExpoPushToken(t.token))
    .map(t => ({
      to: t.token,
      sound: "default" as const,
      title: payload.title,
      body: payload.body,
      data: { url: payload.url, ...(payload.data ?? {}) },
    }));

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      // Clean up invalid tokens
      for (let i = 0; i < tickets.length; i++) {
        const t = tickets[i] as any;
        if (t.status === "error" && t.details?.error === "DeviceNotRegistered") {
          storage.deleteExpoTokenByToken((chunk[i] as any).to);
        }
      }
    } catch (err) {
      console.warn("[expo-push] send error:", err);
    }
  }
}
