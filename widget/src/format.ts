// Pure, render-agnostic helpers shared by the widget component and exercised
// directly by the test suite (no jsdom/RTL is wired up, so anything that needs
// a unit test lives here as a plain function rather than inside a component).

import type { ApiAttachment, ApiMention, ApiUser } from "./api";

/** Human-readable file size (B / KB / MB) for the attachment file card. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True when an attachment should render as an inline image preview. */
export function isImageAttachment(att: ApiAttachment): boolean {
  return typeof att.contentType === "string" && att.contentType.startsWith("image/");
}

/** A single parsed segment of message text: either plain text or a resolved
 * @mention. `isMe` marks a mention of the current user so the renderer can
 * apply the brand-colored highlight. */
export interface MentionSegment {
  text: string;
  mention?: { userId: number | null; isMe: boolean };
}

// Two mention wire formats are recognized:
//   <@123>   numeric-id markup — unambiguous, resolved directly via userById.
//   @handle  the format the Chat app's composer currently emits (a lowercased
//            first name); resolved against the parallel `mentions` array +
//            userById since the raw text carries no id. Broadcast handles
//            (@here / @everyone) are highlighted but never treated as "me".
const MENTION_RE = /(<@\d+>|@[a-zA-Z0-9_.-]+)/g;

/**
 * Split message `content` into text/mention segments. `mentions` is the
 * server-provided resolved list; `meId` is the current user's id (for self-
 * mention highlighting); `userById` resolves ids to display names.
 */
export function parseMentions(
  content: string,
  opts: {
    mentions?: ApiMention[];
    meId?: number | null;
    userById?: Map<number, ApiUser>;
  } = {},
): MentionSegment[] {
  const { mentions = [], meId = null, userById } = opts;
  if (!content) return [];

  const userMentions = mentions.filter((m) => m.type === "user" && m.userId != null);
  const meIsMentioned = meId != null && userMentions.some((m) => m.userId === meId);

  const segments: MentionSegment[] = [];
  const parts = content.split(MENTION_RE);
  for (const part of parts) {
    if (!part) continue;

    const numeric = part.match(/^<@(\d+)>$/);
    if (numeric) {
      const userId = Number(numeric[1]);
      const name = userById?.get(userId)?.name;
      segments.push({
        text: `@${name ?? userId}`,
        mention: { userId, isMe: meId != null && userId === meId },
      });
      continue;
    }

    if (part.startsWith("@") && /^@[a-zA-Z0-9_.-]+$/.test(part)) {
      const handle = part.slice(1).toLowerCase();
      const isBroadcast = handle === "here" || handle === "everyone";
      if (isBroadcast) {
        segments.push({ text: part, mention: { userId: null, isMe: false } });
        continue;
      }
      // Resolve the handle to a full name by matching the lowercased first
      // name of a mentioned user. Falls back to the raw handle text.
      const matched = userById
        ? [...userById.values()].find(
            (u) =>
              u.name.split(/\s+/)[0].toLowerCase() === handle &&
              userMentions.some((m) => m.userId === u.id),
          )
        : undefined;
      if (matched) {
        segments.push({
          text: `@${matched.name}`,
          mention: { userId: matched.id, isMe: meId != null && matched.id === meId },
        });
      } else {
        // Unresolved handle: still tint it if the message mentions me, so a
        // self-mention isn't visually lost when the composer format changes.
        segments.push({
          text: part,
          mention: meIsMentioned ? { userId: null, isMe: true } : undefined,
        });
      }
      continue;
    }

    segments.push({ text: part });
  }
  return segments;
}

/** True when an incoming message mentions the given user id (drives the
 * more-prominent mention ringtone + notification). */
export function mentionsUser(mentions: ApiMention[] | undefined, meId: number | null | undefined): boolean {
  if (!mentions || meId == null) return false;
  return mentions.some((m) => m.type === "user" && m.userId === meId);
}

/** Prepend an older page of messages ahead of the ones already loaded,
 * dropping any id that overlaps the boundary. Ascending-by-id order (oldest
 * first) is preserved: older page first, then the current window. */
export function mergeOlderMessages<T extends { id: number }>(older: T[], current: T[]): T[] {
  const seen = new Set(current.map((m) => m.id));
  return [...older.filter((m) => !seen.has(m.id)), ...current];
}
