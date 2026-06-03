// Frontend type shapes mirroring the backend wire format from server/routes.ts

export type UserRole = "admin" | "foreman" | "office" | "field" | "safety";
export type UserPresence = "online" | "away" | "busy" | "offline";

export interface ApiUser {
  id: number;
  orgId: number;
  email: string;
  name: string;
  title: string | null;
  avatarUrl: string | null;
  hue: number;
  role: UserRole;
  status: string;
  presence?: UserPresence;
  phone?: string | null;
  deactivated?: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface ApiProject {
  id: number;
  orgId: number;
  name: string;
  slug: string;
  short: string;
  hue: number;
  description: string | null;
  createdAt: string;
}

export type ChannelType = "text" | "voice";
export type ChannelScope = "global" | "entity" | "team" | "private" | "dm";

// Phase 1.9.3 — contract metadata cached on a channel when one is
// attached. Server is the source of truth; UI uses this for banner +
// in-call PDF panel without round-tripping to bulldog-contracts.
export interface ApiLinkedContract {
  contractId: number;
  title: string;
  ref?: string | null;
  appUrl: string;
  pdfUrl?: string | null;
  attachedByUserId: number;
  attachedAt: number;
}

export interface ApiChannel {
  id: number;
  projectId: number;
  // Phase 1.8: optional Job (work_object) this channel is nested under.
  // NULL = company-global channel rendered above the Jobs section.
  workObjectId?: number | null;
  name: string;
  type: ChannelType;
  topic: string | null;
  position: number;
  scope?: ChannelScope;
  entityId?: string | null;
  teamRole?: UserRole | null;
  // Phase 1.9.3 — attached contract metadata, when present.
  linkedContract?: ApiLinkedContract | null;
  createdAt: string;
}

// DM channels are regular channels with scope='dm', decorated with the
// channel_members user-id set so the sidebar can render "Alice, Bob" without
// a follow-up fetch.
export interface ApiDmChannel extends ApiChannel {
  memberIds: number[];
}

export interface ApiReaction {
  emoji: string;
  count: number;
  userIds: number[];
}

export interface ApiAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  thumbnailUrl: string | null;
  createdAt: string;
}

export interface ApiMention {
  id: number;
  type: "user" | "here" | "everyone";
  mentionedUserId: number | null;
}

export interface ApiMessage {
  id: number;
  channelId: number;
  userId: number;
  content: string;
  attachments: string | null;
  replyToMessageId: number | null;
  isPinned: boolean;
  createdAt: string;
  editedAt: string | null;
  // Soft-delete (tombstone). When non-null, the message was deleted by its
  // author or an admin. Content is empty string; clients render a
  // "Message deleted" placeholder instead.
  deletedAt?: string | null;
  deletedByUserId?: number | null;
  // Wire enrichment from backend:
  authorName: string;
  authorHue: number;
  authorRole: UserRole;
  authorInitials: string;
  reactions?: ApiReaction[];
  attachmentsList?: ApiAttachment[];
  mentions?: ApiMention[];
  replyCount?: number;
  lastReplyAt?: string | null;
  // System-message metadata. Null/undefined for normal user messages.
  meta?: ApiSystemMessageMeta | null;
}

export type WorkObjectSystemMessageKind =
  | "work_object.created"
  | "work_object.linked"
  | "work_object.unlinked"
  | "work_object.status_changed"
  | "work_object.owner_changed"
  | "work_object.title_changed"
  | "work_object.closed"
  | "work_object.reopened";

export type ScheduledCallSystemMessageKind =
  | "scheduled_call.created"
  | "scheduled_call.updated"
  | "scheduled_call.cancelled"
  | "scheduled_call.started";

export type SystemMessageKind =
  | WorkObjectSystemMessageKind
  | ScheduledCallSystemMessageKind;

export interface ApiWorkObjectSystemMessageMeta {
  system: true;
  kind: WorkObjectSystemMessageKind;
  workObjectId: number;
  ref: string;
  woKind: "job_site" | "work_project" | "change_order" | "safety_incident";
  woTitle: string;
  fields?: Record<string, { from?: unknown; to?: unknown }>;
}

export interface ApiScheduledCallSystemMessageMeta {
  system: true;
  kind: ScheduledCallSystemMessageKind;
  scheduledCallId: number;
  callTitle: string;
  callKind: "voice" | "video";
  startAt: number;
  endAt: number;
  organizerId: number;
}

export type ApiSystemMessageMeta =
  | ApiWorkObjectSystemMessageMeta
  | ApiScheduledCallSystemMessageMeta;

export interface ApiRecording {
  id: number;
  channelId: number;
  startedById: number;
  startedAt: string;
  endedAt: string | null;
  status: "starting" | "recording" | "finalizing" | "completed" | "failed";
  storageKey: string | null;
  url?: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
}

export interface VoiceTokenResponse {
  token?: string;
  ws_url?: string;
  room_name?: string;
  preview_mode?: boolean;
  message?: string;
}
