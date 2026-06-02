// Helper for emitting system messages into channels.
//
// System messages are normal rows in the `messages` table with `meta` set to
// a JSON blob — the frontend looks at meta.system=true and renders a compact
// single-line event banner instead of the full message card.
//
// Authorship: we attribute the system message to the actor who triggered the
// event (so the UI can show "Josh linked BOE-FIBER-01"). If there is no
// actor, we fall back to the work-object owner, then the org admin (id=1).

import { storage } from "./storage";
import { emitMessageNew } from "./events";
import type { WorkObjectSystemMessageMeta, WorkObject } from "@shared/schema";

type WorkObjectSystemMessageKind = WorkObjectSystemMessageMeta["kind"];

interface PostSystemMessageInput {
  channelId: number;
  actorUserId: number | null;
  workObject: Pick<WorkObject, "id" | "ref" | "kind" | "title">;
  kind: WorkObjectSystemMessageKind;
  content: string;
  fields?: Record<string, { from?: unknown; to?: unknown }>;
  orgId: number; // for event fan-out
}

function fallbackUserId(_orgId: number, actorUserId: number | null, workObject: { id: number }): number {
  if (actorUserId != null) return actorUserId;
  // System events without an explicit actor inherit the work object's owner,
  // then its creator. Both are FK-guaranteed to be valid users.
  const wo = storage.getWorkObject(workObject.id);
  if (wo?.ownerUserId) return wo.ownerUserId;
  if (wo?.createdByUserId) return wo.createdByUserId;
  return 1;
}

export function postWorkObjectSystemMessage(input: PostSystemMessageInput) {
  const meta: WorkObjectSystemMessageMeta = {
    system: true,
    kind: input.kind,
    workObjectId: input.workObject.id,
    ref: input.workObject.ref,
    woKind: input.workObject.kind,
    woTitle: input.workObject.title,
    ...(input.fields ? { fields: input.fields } : {}),
  };

  const userId = fallbackUserId(input.orgId, input.actorUserId, input.workObject);
  let msg;
  try {
    msg = storage.createMessage({
      channelId: input.channelId,
      userId,
      content: input.content,
      meta: JSON.stringify(meta),
    });
  } catch (err) {
    // If the channel was deleted between link and now, just swallow.
    console.warn(`[system-messages] Failed to post to channel ${input.channelId}:`, err);
    return null;
  }

  // Fan out to connected clients so the banner appears immediately.
  try {
    const wire: any = {
      ...msg,
      meta,
      // Minimal author enrichment — the frontend ignores authorship for
      // system rows, but the WireMessage type expects these fields.
      authorName: "",
      authorHue: 220,
      authorRole: "field",
      authorInitials: "",
      reactions: [],
      attachmentsList: [],
      mentions: [],
      replyCount: 0,
      lastReplyAt: null,
    };
    emitMessageNew(input.orgId, wire);
  } catch (err) {
    console.warn("[system-messages] Failed to emit message-new event:", err);
  }

  return msg;
}

// Fan a work-object event out to every channel linked to that work object.
export function broadcastWorkObjectEvent(input: {
  workObjectId: number;
  actorUserId: number | null;
  orgId: number;
  kind: WorkObjectSystemMessageKind;
  content: string;
  fields?: Record<string, { from?: unknown; to?: unknown }>;
  // Optional: restrict to a single channel (e.g. for link/unlink events).
  onlyChannelId?: number;
}) {
  const wo = storage.getWorkObject(input.workObjectId);
  if (!wo) return;

  const channels = input.onlyChannelId
    ? [{ channelId: input.onlyChannelId }]
    : storage.listLinksForWorkObject(input.workObjectId);

  for (const link of channels) {
    postWorkObjectSystemMessage({
      channelId: link.channelId,
      actorUserId: input.actorUserId,
      workObject: { id: wo.id, ref: wo.ref, kind: wo.kind, title: wo.title },
      kind: input.kind,
      content: input.content,
      fields: input.fields,
      orgId: input.orgId,
    });
  }
}
