import type { Response } from "express";
import type { Message } from "@shared/schema";

type Subscriber = {
  userId: number;
  orgId: number;
  res: Response;
};

const subscribers = new Set<Subscriber>();

export function addSubscriber(sub: Subscriber) {
  subscribers.add(sub);
}
export function removeSubscriber(sub: Subscriber) {
  subscribers.delete(sub);
}

function send(sub: Subscriber, event: string, data: unknown) {
  try {
    sub.res.write(`event: ${event}\n`);
    sub.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch { /* socket dead, will be cleaned up */ }
}

export type WireMessage = Message & {
  authorName: string;
  authorHue: number;
  authorRole: string;
  authorInitials: string;
  reactions?: { emoji: string; count: number; userIds: number[] }[];
};

export function emitMessageNew(orgId: number, msg: WireMessage) {
  for (const sub of subscribers) {
    if (sub.orgId === orgId) send(sub, "message:new", msg);
  }
}

export function emitMessageUpdate(orgId: number, msg: WireMessage) {
  for (const sub of subscribers) {
    if (sub.orgId === orgId) send(sub, "message:update", msg);
  }
}

export function emitMessageDelete(orgId: number, payload: { channelId: number; messageId: number }) {
  for (const sub of subscribers) {
    if (sub.orgId === orgId) send(sub, "message:delete", payload);
  }
}

export function emitReactionChange(orgId: number, payload: { messageId: number; channelId: number }) {
  for (const sub of subscribers) {
    if (sub.orgId === orgId) send(sub, "reaction:change", payload);
  }
}

// Periodic heartbeat to keep connections alive
setInterval(() => {
  for (const sub of subscribers) {
    try { sub.res.write(`: ping\n\n`); } catch { /* ignore */ }
  }
}, 25_000);
