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
export type ChannelScope = "global" | "entity" | "team" | "private";

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
  createdAt: string;
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

export type SystemMessageKind =
  | "work_object.created"
  | "work_object.linked"
  | "work_object.unlinked"
  | "work_object.status_changed"
  | "work_object.owner_changed"
  | "work_object.title_changed"
  | "work_object.closed"
  | "work_object.reopened";

export interface ApiSystemMessageMeta {
  system: true;
  kind: SystemMessageKind;
  workObjectId: number;
  ref: string;
  woKind: "job_site" | "work_project" | "change_order" | "safety_incident";
  woTitle: string;
  fields?: Record<string, { from?: unknown; to?: unknown }>;
}

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
