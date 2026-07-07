import type { Response } from "express";
import type { Message } from "@shared/schema";
import { rawDb } from "./db";
import { canSeeChannel, type AccessSnapshot } from "./multitenant-access";

type Subscriber = {
  userId: number;
  orgId: number;
  res: Response;
  // Multi-tenant access snapshot for this subscriber. When MULTITENANT_MODE
  // is off, callers may pass a permissive snapshot that allows everything.
  // When on, every channel-scoped event runs canSeeChannel before send().
  access: AccessSnapshot;
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

// Tiny per-call cache so we don't hit SQLite N times per fan-out for the
// same channelId. Channels rarely change project/region after creation, but
// we still want a fresh row per emit invocation.
function lookupChannelScope(channelId: number): { projectId: number; regionId: number | null } | null {
  try {
    const row = rawDb
      .prepare(`SELECT project_id AS projectId, region_id AS regionId FROM channels WHERE id = ?`)
      .get(channelId) as { projectId: number; regionId: number | null } | undefined;
    if (!row) return null;
    return { projectId: row.projectId, regionId: row.regionId ?? null };
  } catch {
    return null;
  }
}

// Wraps a per-channel fan-out with an access check. If the channel can't be
// located (deleted mid-emit, schema mismatch, etc.) we fall back to org-only
// gating so we don't silently drop legitimate events.
function fanoutChannel(
  orgId: number,
  channelId: number,
  event: string,
  payload: unknown,
) {
  const scope = lookupChannelScope(channelId);
  for (const sub of subscribers) {
    if (sub.orgId !== orgId) continue;
    if (scope) {
      if (!canSeeChannel(sub.access, scope.projectId, scope.regionId)) continue;
    }
    send(sub, event, payload);
  }
}

export function emitMessageNew(orgId: number, msg: WireMessage) {
  fanoutChannel(orgId, msg.channelId, "message:new", msg);
}

export function emitMessageUpdate(orgId: number, msg: WireMessage) {
  fanoutChannel(orgId, msg.channelId, "message:update", msg);
}

export function emitMessageDelete(orgId: number, payload: { channelId: number; messageId: number }) {
  fanoutChannel(orgId, payload.channelId, "message:delete", payload);
}

export function emitReactionChange(orgId: number, payload: { messageId: number; channelId: number }) {
  fanoutChannel(orgId, payload.channelId, "reaction:change", payload);
}

// Broadcast that a channel was deleted (admin delete or DM thread wipe).
// Clients drop the channel from their caches and bail out of the view if
// it's currently active. formerMemberIds lets a DM-aware client skip the
// invalidate work for users who weren't members anyway.
//
// We use the cached channel scope if available, but channels are deleted
// from the table before this fires in most code paths, so we accept the
// org-only fallback here. Clients that can't see the channel will simply
// receive a no-op cache invalidation.
export function emitChannelDelete(
  orgId: number,
  payload: { channelId: number; deletedByUserId?: number; formerMemberIds?: number[] },
) {
  fanoutChannel(orgId, payload.channelId, "channel:delete", payload);
}

// Titled Chats (Phase 2.5). Broadcast that a DM channel's title changed
// (set, changed, or cleared back to null) so every member's sidebar/header
// updates live without a manual refresh. We target members directly rather
// than going through fanoutChannel's org-wide loop + canSeeChannel, since a
// freshly-created or freshly-renamed DM's scope/member set is exactly what
// we already have on hand from the route handler — no extra DB round-trip.
export function emitDmUpdated(
  orgId: number,
  payload: { channelId: number; title: string | null; memberIds: number[] },
) {
  for (const sub of subscribers) {
    if (sub.orgId !== orgId) continue;
    if (!payload.memberIds.includes(sub.userId)) continue;
    send(sub, "dm:updated", payload);
  }
}

// Titled Chats (Phase 2.5). Broadcast that a brand-new DM/titled-chat
// channel was created so every member's sidebar picks it up immediately
// (mirrors emitDmUpdated's per-member targeting).
export function emitDmCreated(
  orgId: number,
  payload: { channelId: number; title: string | null; memberIds: number[] },
) {
  for (const sub of subscribers) {
    if (sub.orgId !== orgId) continue;
    if (!payload.memberIds.includes(sub.userId)) continue;
    send(sub, "dm:created", payload);
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
