// Pure, render-agnostic helpers shared by the widget component and exercised
// directly by the test suite (no jsdom/RTL is wired up, so anything that needs
// a unit test lives here as a plain function rather than inside a component).

import type { ApiAttachment, ApiChannel, ApiDmChannel, ApiMention, ApiReaction, ApiUser } from "./api";

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

// ── Reactions ────────────────────────────────────────────────────────────────

/** The small fixed emoji palette the "+" pill opens. Deliberately hand-picked
 * (not emoji-mart) so the widget stays asset-free and under the bundle budget. */
export const REACTION_EMOJIS = [
  "👍", "👎", "❤️", "😂", "🎉", "😮", "😢", "🙏",
  "🔥", "✅", "👀", "🚀", "💯", "😅", "🤔", "👏",
  "😍", "😎", "🙌", "💪", "⚡", "❓", "❗", "🥳",
] as const;

/** True when the given user has already reacted with this emoji — drives the
 * "own reaction" highlight and whether a click adds or removes. */
export function hasOwnReaction(reaction: ApiReaction, meId: number | null | undefined): boolean {
  return meId != null && reaction.userIds.includes(meId);
}

/** Whether clicking a reaction pill should add or remove the caller's reaction,
 * given the current grouped reactions and the emoji clicked. */
export function reactionToggleAction(
  reactions: ApiReaction[] | undefined,
  emoji: string,
  meId: number | null | undefined,
): "add" | "remove" {
  const existing = reactions?.find((r) => r.emoji === emoji);
  return existing && hasOwnReaction(existing, meId) ? "remove" : "add";
}

/** Names of the users who reacted with an emoji, for the hover tooltip. Falls
 * back to the raw id when a user isn't in the members map. */
export function reactedByNames(reaction: ApiReaction, userById: Map<number, ApiUser>): string {
  return reaction.userIds.map((id) => userById.get(id)?.name ?? `User ${id}`).join(", ");
}

// ── Presence ─────────────────────────────────────────────────────────────────

/** Tailwind background class for a presence dot. Unknown / missing presence is
 * treated as offline (gray). online=green, away=amber, busy=red, offline=gray. */
export function presenceDotClass(presence: string | null | undefined): string {
  switch (presence) {
    case "online": return "bcw-bg-green-500";
    case "away": return "bcw-bg-amber-400";
    case "busy": return "bcw-bg-red-500";
    default: return "bcw-bg-gray-500";
  }
}

/** Human label for a presence value (title attribute on the dot). */
export function presenceLabel(presence: string | null | undefined): string {
  switch (presence) {
    case "online": return "Online";
    case "away": return "Away";
    case "busy": return "Busy";
    default: return "Offline";
  }
}

// ── Threads ──────────────────────────────────────────────────────────────────

/** Label for the "N replies" chip under a message that has thread replies.
 * Returns null when there are none (caller renders no chip). */
export function threadChipLabel(replyCount: number | undefined, lastReplyAt?: string | null): string | null {
  if (!replyCount || replyCount <= 0) return null;
  const base = `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;
  const rel = lastReplyAt ? formatRelativeTime(lastReplyAt) : null;
  return rel ? `${base} · last ${rel}` : base;
}

/** Coarse relative-time string ("just now", "5m", "3h", "2d") for reply chips
 * and typing/last-seen affordances. Invalid input yields an empty string. */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.floor((now - t) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ── Call target picker (widget 0.4.1) ───────────────────────────────────────

/** A single row in the "who do you want to call?" picker. */
export interface CallTarget {
  user: ApiUser;
  /** true when this user is the other participant of the currently-active
   * DM — used to pre-select / pin them at the top of the list. */
  isActiveDmOther: boolean;
}

/** Build the deduplicated, self-excluded list of people the current user can
 * call: everyone from their DM list, plus everyone from channel membership
 * data (when available). Order: the active DM's other participant first (if
 * any, per the "two-click call" shortcut), then the rest in the order
 * encountered — DMs before channel members.
 *
 * `channelMembers` is optional because this build of the client only loads
 * channel rosters if a project/channel API exposes memberIds directly. When
 * it's absent, `orgMembers` (already loaded for the whole widget) supplies
 * everyone else the user could reach via a shared channel. */
export function buildCallableUsers(
  meId: number | null | undefined,
  userById: Map<number, ApiUser>,
  dms: ApiDmChannel[],
  orgMembers: ApiUser[],
  channelMembers?: ApiChannel[],
  activeDmId?: number | null,
): CallTarget[] {
  const activeDm = activeDmId != null ? dms.find((d) => d.id === activeDmId) : undefined;
  const activeDmOtherId = activeDm && meId != null
    ? activeDm.memberIds.find((id) => id !== meId)
    : undefined;

  const seen = new Set<number>();
  const ordered: number[] = [];

  const add = (id: number) => {
    if (id === meId) return; // exclude self
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };

  // Pin the active DM's other participant first, if any.
  if (activeDmOtherId != null) add(activeDmOtherId);

  // Everyone from the user's DM list.
  for (const dm of dms) {
    for (const id of dm.memberIds) add(id);
  }

  // Everyone reachable via channel membership. Channels in this client don't
  // always carry memberIds; when they do, fold them in too.
  for (const ch of channelMembers ?? []) {
    for (const id of (ch as ApiDmChannel).memberIds ?? []) add(id);
  }

  // Fall back to / augment with the org-wide member list, which represents
  // everyone the user shares a channel with in this deployment.
  for (const u of orgMembers) add(u.id);

  return ordered
    .map((id) => userById.get(id) ?? orgMembers.find((u) => u.id === id))
    .filter((u): u is ApiUser => Boolean(u))
    .map((user) => ({ user, isActiveDmOther: user.id === activeDmOtherId }));
}

/** Case-insensitive substring filter over a callable-users list, applied to
 * the picker's search box. Empty/whitespace query returns the list as-is. */
export function filterCallTargets(targets: CallTarget[], query: string): CallTarget[] {
  const q = query.trim().toLowerCase();
  if (!q) return targets;
  return targets.filter(
    (t) => t.user.name.toLowerCase().includes(q) || t.user.email.toLowerCase().includes(q),
  );
}

// ── Typing indicator ─────────────────────────────────────────────────────────

/** Build the "… is typing" line from the display names of users currently
 * typing. 0 → empty string, 1 → "Alice is typing…", 2 → "Alice and Bob are
 * typing…", 3+ → "Several people are typing…". */
export function typingLabel(names: string[]): string {
  const list = names.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return `${list[0]} is typing…`;
  if (list.length === 2) return `${list[0]} and ${list[1]} are typing…`;
  return "Several people are typing…";
}
