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

/**
 * 1:1 call events. We target the specific user (callee or caller) by id
 * so we don't leak ringing across the org. SSE clients subscribe by
 * user, so this is naturally a single open browser tab per device.
 */
export interface CallEventPayload {
  callId: number;
  callerId: number;
  calleeId: number;
  callerName: string;
  callerHue: number;
  kind: "voice" | "video";
  roomName: string;
}

function emitToUser(userId: number, event: string, data: unknown) {
  for (const sub of subscribers) {
    if (sub.userId === userId) send(sub, event, data);
  }
}

export function emitCallIncoming(payload: CallEventPayload) {
  // Ring the callee. We also notify the caller (optional, but useful so
  // the caller's other tabs can show "calling\u2026" UI consistently).
  emitToUser(payload.calleeId, "call:incoming", payload);
  emitToUser(payload.callerId, "call:outgoing", payload);
}

export function emitCallAccepted(payload: CallEventPayload) {
  emitToUser(payload.callerId, "call:accepted", payload);
  emitToUser(payload.calleeId, "call:accepted", payload);
}

export function emitCallEnded(payload: CallEventPayload & { reason: "declined" | "missed" | "ended" }) {
  emitToUser(payload.callerId, "call:ended", payload);
  emitToUser(payload.calleeId, "call:ended", payload);
}

/**
 * Presence broadcast. Fired when a user changes their status (online/away/busy/
 * offline) so every connected client in the org can update the dot color
 * next to their name in the member list and at the top bar. Org-scoped on
 * purpose — presence is not sensitive but it's also not interesting to
 * users outside the org.
 */
export function emitPresenceChange(orgId: number, payload: { userId: number; presence: "online" | "away" | "busy" | "offline" }) {
  for (const sub of subscribers) {
    if (sub.orgId === orgId) send(sub, "presence:change", payload);
  }
}

// Periodic heartbeat to keep connections alive
setInterval(() => {
  for (const sub of subscribers) {
    try { sub.res.write(`: ping\n\n`); } catch { /* ignore */ }
  }
}, 25_000);
