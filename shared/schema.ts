import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/* ─────────────────── ORGANIZATIONS ─────────────────── */
export const organizations = sqliteTable("organizations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("starter"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export const insertOrganizationSchema = createInsertSchema(organizations).omit({ id: true, createdAt: true });
export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;

/* ─────────────────── USERS ─────────────────── */
// Phase 2.0 unified roles. Legacy values (foreman/office/field/safety/
// dispatcher/field_crew) are remapped to "user" by the boot migration and by
// mapAuthRoleToChatRole; "admin" is unchanged. super_admin from auth maps to
// "admin" locally (chat has no super tier of its own).
export const userRoles = ["user", "manager", "admin"] as const;
export type UserRole = typeof userRoles[number];

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  title: text("title"),
  avatarUrl: text("avatar_url"),
  hue: integer("hue").notNull().default(220),
  role: text("role", { enum: userRoles }).notNull().default("user"),
  status: text("status").notNull().default("online"),
  // Phase 1.9 presence state for the top-bar status dot. Distinct from
  // `status` (legacy free-form string). Drives DND push gating.
  presence: text("presence", { enum: ["online", "away", "busy", "offline"] as const })
    .notNull()
    .default("online"),
  deactivated: integer("deactivated", { mode: "boolean" }).notNull().default(false),
  // E.164 phone number for offline call-bridging via Twilio SIP. Synced
  // from bulldog-auth during the SSO bridge so we don't have to round-
  // trip on every invite.
  phone: text("phone"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
});
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, lastSeenAt: true });
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
// Sanitized user — never expose passwordHash to client
export type PublicUser = Omit<User, "passwordHash">;

/* ─────────────────── PROJECTS ─────────────────── */
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  short: text("short").notNull(),
  hue: integer("hue").notNull().default(220),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export const insertProjectSchema = createInsertSchema(projects).omit({ id: true, createdAt: true });
export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;

/* ─────────────────── PROJECT MEMBERS ─────────────────── */
export const projectMembers = sqliteTable("project_members", {
  projectId: integer("project_id").notNull().references(() => projects.id),
  userId: integer("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("member"),
}, (t) => ({ pk: primaryKey({ columns: [t.projectId, t.userId] }) }));
export type ProjectMember = typeof projectMembers.$inferSelect;

/* ─────────────────── CHANNELS ─────────────────── */
export const channelTypes = ["text", "voice"] as const;
export type ChannelType = typeof channelTypes[number];

// scope semantics:
//   global  → everyone in the project (legacy default; back-compat)
//   entity  → only users whose user.entityId matches channel.entityId
//   team    → only users whose user.role matches channel.teamRole
//   private → only users explicitly listed in channel_members
//   dm      → 1:1 or group direct message; members tracked in channel_members.
//             Hidden from the project sidebar; surfaced in the dedicated
//             "Direct Messages" section instead. Channels live under the user's
//             home project so messages/reactions/attachments all work as-is.
export const channelScopes = ["global", "entity", "team", "private", "dm"] as const;
export type ChannelScope = typeof channelScopes[number];

export const channels = sqliteTable("channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The "company" this channel belongs to. Reuses the existing `projects`
  // table (Path B). Renamed in UI as Company (VFD / VS / VTS).
  projectId: integer("project_id").notNull().references(() => projects.id),
  // Optional Job (work_object) this channel is nested under. NULL = a
  // company-global channel (e.g. #general, #announcements). When set,
  // sidebar nests this channel under the job's section.
  workObjectId: integer("work_object_id").references(() => workObjects.id),
  name: text("name").notNull(),
  type: text("type", { enum: channelTypes }).notNull().default("text"),
  topic: text("topic"),
  position: integer("position").notNull().default(0),
  scope: text("scope", { enum: channelScopes }).notNull().default("global"),
  entityId: text("entity_id"),
  teamRole: text("team_role", { enum: userRoles }),
  // Phase 1.9.3 — contract linkage. When a channel is created from a
  // contract (or has one attached later), we cache its identity so chat
  // can render the contract banner + in-call "View contract" panel
  // without round-tripping to the contracts service every load. Stored
  // as JSON-encoded text for SQLite portability.
  linkedContract: text("linked_contract", { mode: "json" }).$type<LinkedContractMeta | null>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Cached contract metadata stored on a channel. Only fields we need to
// render the chat-side UI; the contracts app remains the source of truth.
export type LinkedContractMeta = {
  contractId: number;
  // Human-readable title shown in the banner ("BOE Fiber 2026 — MSA")
  title: string;
  // Short stable reference, e.g. "VFD-2026-014"
  ref?: string | null;
  // URL into bulldog-contracts where users can view/edit the contract.
  appUrl: string;
  // Direct PDF URL for inline rendering in the call panel. Must be CORS-
  // friendly or proxied by chat. May be null for drafts.
  pdfUrl?: string | null;
  // Who attached it (audit) and when.
  attachedByUserId: number;
  attachedAt: number;
};
export const insertChannelSchema = createInsertSchema(channels).omit({ id: true, createdAt: true });
export type Channel = typeof channels.$inferSelect;
export type InsertChannel = z.infer<typeof insertChannelSchema>;

// Phase 1.9.3 — payload accepted on attach/create-from-contract endpoints.
// All fields are needed because the contracts app is the source of truth
// and chat just caches the data for fast UI render. Validated server-side.
export const linkedContractAttachSchema = z.object({
  contractId: z.number().int().positive(),
  title: z.string().min(1).max(200),
  ref: z.string().max(80).optional().nullable(),
  appUrl: z.string().url().max(500),
  pdfUrl: z.string().url().max(500).optional().nullable(),
});
export type LinkedContractAttachInput = z.infer<typeof linkedContractAttachSchema>;

// Channel-create payload accepted on POST /api/projects/:id/channels.
// We do scope-aware validation here to keep routes thin.
export const channelCreateSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(channelTypes).default("text"),
  topic: z.string().max(500).optional().nullable(),
  scope: z.enum(channelScopes).default("global"),
  entityId: z.string().max(80).optional().nullable(),
  teamRole: z.enum(userRoles).optional().nullable(),
  // Optional: nest this channel under a specific Job (work_object).
  // The job must belong to the same company (projectId) as the channel.
  workObjectId: z.number().int().positive().optional().nullable(),
  memberIds: z.array(z.number().int().positive()).optional(),
  // Phase 1.9.3 — attach a contract at create time. When present, the
  // channel will store linkedContract and post a system message announcing
  // the attachment so members see the document in-thread immediately.
  linkedContract: linkedContractAttachSchema.optional().nullable(),
}).refine(
  (d) => d.scope !== "entity" || (typeof d.entityId === "string" && d.entityId.length > 0),
  { message: "entity scope requires entityId", path: ["entityId"] },
).refine(
  (d) => d.scope !== "team" || !!d.teamRole,
  { message: "team scope requires teamRole", path: ["teamRole"] },
).refine(
  (d) => d.scope !== "private" || (Array.isArray(d.memberIds) && d.memberIds.length > 0),
  { message: "private scope requires at least one memberId", path: ["memberIds"] },
);
export type ChannelCreateInput = z.infer<typeof channelCreateSchema>;

/* ─────────────────── CHANNEL MEMBERS (private scope) ─────────────────── */
export const channelMembers = sqliteTable("channel_members", {
  channelId: integer("channel_id").notNull().references(() => channels.id),
  userId: integer("user_id").notNull().references(() => users.id),
}, (t) => ({ pk: primaryKey({ columns: [t.channelId, t.userId] }) }));
export type ChannelMember = typeof channelMembers.$inferSelect;

/* ─────────────────── MESSAGES ─────────────────── */
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  userId: integer("user_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  // JSON column storing array of attachments {kind, url?, filename?, language?, body?, alt?}
  attachments: text("attachments"),
  replyToMessageId: integer("reply_to_message_id"),
  isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  editedAt: integer("edited_at", { mode: "timestamp" }),
  // Soft-delete (tombstone). When non-null, the row stays for thread-reply
  // integrity but content/attachments are wiped and clients render a
  // "Message deleted" placeholder. deletedByUserId records who did it for
  // audit — either the author or an admin moderator.
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
  deletedByUserId: integer("deleted_by_user_id"),
  // JSON: { system: true, kind: 'work_object.created' | ..., workObjectId, ref, fields? }
  // Null for normal user messages.
  meta: text("meta"),
});

// Shape of meta for system messages emitted by work-object events.
export const systemMessageKinds = [
  "work_object.created",
  "work_object.linked",
  "work_object.unlinked",
  "work_object.status_changed",
  "work_object.owner_changed",
  "work_object.title_changed",
  "work_object.closed",
  "work_object.reopened",
  // Phase 1.9.1: scheduled-call lifecycle. These render as an in-channel
  // RSVP card (frontend looks at meta.scheduledCallId).
  "scheduled_call.created",
  "scheduled_call.updated",
  "scheduled_call.cancelled",
  "scheduled_call.started",
] as const;
export type SystemMessageKind = typeof systemMessageKinds[number];
// Work-object system messages keep their original shape. Scheduled-call
// system messages use a different field set. The frontend discriminates
// on `kind` to pick the renderer.
export interface WorkObjectSystemMessageMeta {
  system: true;
  kind: "work_object.created" | "work_object.linked" | "work_object.unlinked"
    | "work_object.status_changed" | "work_object.owner_changed"
    | "work_object.title_changed" | "work_object.closed" | "work_object.reopened";
  workObjectId: number;
  ref: string;
  woKind: WorkObjectKind;
  woTitle: string;
  fields?: Record<string, { from?: unknown; to?: unknown }>;
}
export interface ScheduledCallSystemMessageMeta {
  system: true;
  kind: "scheduled_call.created" | "scheduled_call.updated"
    | "scheduled_call.cancelled" | "scheduled_call.started";
  scheduledCallId: number;
  title: string;
  startAt: number;          // unix ms
  endAt: number;            // unix ms
  callKind: "voice" | "video";
  organizerId: number;
  inviteeCount: number;
  joinUrl: string;          // absolute, already token-bearing for /call-join
  teamsJoinUrl?: string | null;
  provider?: "bulldog" | "both" | "teams";
  // Snapshot invitee roster at card-post time; live data is refetched by FE.
  invitees?: Array<{
    id: number;
    name: string;       // user display name OR email/masked phone
    response: "pending" | "yes" | "no" | "maybe";
  }>;
}
export type SystemMessageMeta = WorkObjectSystemMessageMeta | ScheduledCallSystemMessageMeta;
export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true, createdAt: true, editedAt: true, isPinned: true, userId: true,
}).extend({
  content: z.string().min(1).max(4000),
  attachments: z.string().optional().nullable(),
  replyToMessageId: z.number().nullable().optional(),
});
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

/* ─────────────────── REACTIONS ─────────────────── */
export const reactions = sqliteTable("reactions", {
  messageId: integer("message_id").notNull().references(() => messages.id),
  userId: integer("user_id").notNull().references(() => users.id),
  emoji: text("emoji").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }) }));
export type Reaction = typeof reactions.$inferSelect;

/* ─────────────────── READ RECEIPTS ─────────────────── */
export const readReceipts = sqliteTable("read_receipts", {
  channelId: integer("channel_id").notNull().references(() => channels.id),
  userId: integer("user_id").notNull().references(() => users.id),
  lastReadMessageId: integer("last_read_message_id"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.channelId, t.userId] }) }));
export type ReadReceipt = typeof readReceipts.$inferSelect;

/* ─────────────────── PUSH SUBSCRIPTIONS ─────────────────── */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  deviceLabel: text("device_label"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({ id: true, createdAt: true });
export type PushSubscription = typeof pushSubscriptions.$inferSelect;

/* ─────────────────── SESSIONS ─────────────────── */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export type Session = typeof sessions.$inferSelect;

/* ─────────────────── INVITES ─────────────────── */
export const invites = sqliteTable("invites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  projectId: integer("project_id").references(() => projects.id),
  email: text("email"),
  role: text("role", { enum: userRoles }).notNull().default("user"),
  token: text("token").notNull().unique(),
  invitedByUserId: integer("invited_by_user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export const insertInviteSchema = createInsertSchema(invites).omit({ id: true, token: true, createdAt: true, acceptedAt: true, expiresAt: true, invitedByUserId: true });
export type Invite = typeof invites.$inferSelect;
export type InsertInvite = z.infer<typeof insertInviteSchema>;

/* ─────────────────── ATTACHMENTS ─────────────────── */
export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  messageId: integer("message_id").references(() => messages.id),
  uploaderUserId: integer("uploader_user_id").notNull().references(() => users.id),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  thumbnailKey: text("thumbnail_key"),
  width: integer("width"),
  height: integer("height"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export type Attachment = typeof attachments.$inferSelect;

/* ─────────────────── MENTIONS ─────────────────── */
export const mentionTypes = ["user", "everyone", "here"] as const;
export type MentionType = typeof mentionTypes[number];

export const messageMentions = sqliteTable("message_mentions", {
  messageId: integer("message_id").notNull().references(() => messages.id),
  mentionedUserId: integer("mentioned_user_id").references(() => users.id),
  type: text("type", { enum: mentionTypes }).notNull().default("user"),
}, (t) => ({ pk: primaryKey({ columns: [t.messageId, t.mentionedUserId, t.type] }) }));
export type MessageMention = typeof messageMentions.$inferSelect;

/* ─────────────────── RECORDINGS ─────────────────── */
export const recordingStatuses = ["recording", "processing", "ready", "failed"] as const;
export type RecordingStatus = typeof recordingStatuses[number];

export const recordings = sqliteTable("recordings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  startedByUserId: integer("started_by_user_id").notNull().references(() => users.id),
  egressId: text("egress_id"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  durationSeconds: integer("duration_seconds"),
  storageUrl: text("storage_url"),
  storageKey: text("storage_key"),
  fileSizeBytes: integer("file_size_bytes"),
  status: text("status", { enum: recordingStatuses }).notNull().default("recording"),
  // Unified meetings model — nullable FK to the canonical meeting row.
  meetingId: text("meeting_id").references(() => meetings.id),
});
export type Recording = typeof recordings.$inferSelect;

/* ─────────────────── MEETING NOTES (Phase 1.9.4 AI clerk) ─────────────────── */
export const meetingNoteStatuses = [
  "recording",     // Deepgram streaming session is live
  "transcribing",  // call ended, waiting for final deepgram flush
  "summarizing",   // calling Claude with the transcript
  "rendering",     // generating PDF
  "uploading",     // pushing to Synology WebDAV
  // Summary is generated + PDF filed, but waiting for the host to pick which
  // attendees should receive the email transcript. Resolved by POSTing to
  // /api/meeting-notes/:id/send-summary (sets status -> 'uploaded' after the
  // emails fan out, or marks 'uploaded' with no email send if skipped).
  "awaiting_recipients",
  "uploaded",      // PDF safely stored on Synology, notes available in chat
  "failed",        // any step failed; error_message has detail
] as const;
export type MeetingNoteStatus = typeof meetingNoteStatuses[number];

export interface MeetingNoteAttendee {
  userId: number;
  email: string;
  name: string;
  joinedAt?: number;
}

export interface MeetingNoteRecipientSelection {
  status: "pending" | "sent" | "skipped";
  // userIds chosen by the host. Empty when status='skipped'.
  sentToUserIds: number[];
  // Epoch ms when the host clicked Send/Skip. Absent while still pending.
  decidedAt?: number;
  // The host who made the call (defaults to the clerk's starter if no UI
  // interaction — e.g. legacy clients posting straight through).
  decidedByUserId?: number;
}

export const meetingNotes = sqliteTable("meeting_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  startedByUserId: integer("started_by_user_id").notNull().references(() => users.id),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  status: text("status", { enum: meetingNoteStatuses }).notNull().default("recording"),
  title: text("title"),
  transcriptText: text("transcript_text").notNull().default(""),
  summaryText: text("summary_text"),
  attendeesJson: text("attendees_json", { mode: "json" }).$type<MeetingNoteAttendee[] | null>(),
  // Phase 2.3 — recipient selection. When the clerk stops, instead of emailing
  // every attendee unconditionally, the host picks recipients in the UI. This
  // column records that decision: { status: 'pending' | 'sent' | 'skipped',
  // sentToUserIds: number[], sentAt: number, decidedByUserId: number }.
  // Null on rows older than v30 — those used the legacy fan-out-to-all.
  recipientSelectionJson: text("recipient_selection_json", { mode: "json" }).$type<MeetingNoteRecipientSelection | null>(),
  synologyRemotePath: text("synology_remote_path"),
  synologyStatus: text("synology_status"),
  synologyReason: text("synology_reason"),
  pdfSizeBytes: integer("pdf_size_bytes"),
  durationSeconds: integer("duration_seconds"),
  deepgramSessionId: text("deepgram_session_id"),
  errorMessage: text("error_message"),
  // Unified meetings model — nullable FK to the canonical meeting row.
  meetingId: text("meeting_id").references(() => meetings.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
export type MeetingNote = typeof meetingNotes.$inferSelect;

/* ─────────────────── EXPO PUSH TOKENS ─────────────────── */
export const expoPushTokens = sqliteTable("expo_push_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  deviceLabel: text("device_label"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export type ExpoPushToken = typeof expoPushTokens.$inferSelect;

/* ─────────────────── DIRECT CALLS (1:1 ringing) ─────────────────── */
export const directCallStatuses = ["ringing", "active", "missed", "declined", "ended"] as const;
export type DirectCallStatus = typeof directCallStatuses[number];

export const directCalls = sqliteTable("direct_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  callerId: integer("caller_id").notNull().references(() => users.id),
  calleeId: integer("callee_id").notNull().references(() => users.id),
  // LiveKit room name; we use direct-<id> so it's unique even across orgs.
  roomName: text("room_name").notNull(),
  kind: text("kind", { enum: ["voice", "video"] as const }).notNull().default("voice"),
  status: text("status", { enum: directCallStatuses }).notNull().default("ringing"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  answeredAt: integer("answered_at", { mode: "timestamp" }),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  // Unified meetings model — links this legacy call row to its canonical
  // meeting. Nullable so historical rows and the ringing fast-path stay valid.
  meetingId: text("meeting_id").references(() => meetings.id),
});
export type DirectCall = typeof directCalls.$inferSelect;

/* ─────────────── SCHEDULED CALLS (Phase 1.9.1) ────────────── */
// A scheduled_call is a future Bulldog call (voice or video) with an
// organizer, a title, a start/end window, and a set of invitees.
// Invitees are either chat users (by id) or external phone numbers
// (free-form), so a foreman can schedule a call with a customer who
// isn't in the app yet. We materialize one row per invitee in
// scheduled_call_invitees so RSVP state (Y/N/M, code, channel) is
// addressable per-person without rewriting a JSON blob on every reply.
export const scheduledCallKinds = ["voice", "video"] as const;
export type ScheduledCallKind = typeof scheduledCallKinds[number];

export const scheduledCallStatuses = ["scheduled", "started", "ended", "cancelled"] as const;
export type ScheduledCallStatus = typeof scheduledCallStatuses[number];

export const scheduledCalls = sqliteTable("scheduled_calls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  // Optional channel binding — when set, RSVP cards and join-link posts
  // surface in that channel. A standalone scheduled call (no channel)
  // works too; it just only shows up in the organizer's UI + invitee SMS.
  channelId: integer("channel_id").references(() => channels.id),
  organizerId: integer("organizer_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  // Optional free-form notes shown in the calendar invite body.
  notes: text("notes"),
  kind: text("kind", { enum: scheduledCallKinds }).notNull().default("video"),
  startAt: integer("start_at", { mode: "timestamp" }).notNull(),
  endAt: integer("end_at", { mode: "timestamp" }).notNull(),
  // LiveKit room name; pre-allocated at create time as `sched-<id>-<ts>`
  // so join links are stable even before the call starts.
  roomName: text("room_name").notNull(),
  status: text("status", { enum: scheduledCallStatuses }).notNull().default("scheduled"),
  // Reminder bookkeeping — the in-process scheduler sweeps this and
  // skips rows where the reminder already fired.
  reminderSentAt: integer("reminder_sent_at", { mode: "timestamp" }),
  // ICS sequence number; bump on each edit so calendar clients update
  // the existing event rather than creating a duplicate.
  icsSequence: integer("ics_sequence").notNull().default(0),
  // Microsoft Teams parallel-join support (Phase 2.1). Populated when a
  // Teams online meeting is created via MS Graph at schedule time. Both are
  // nullable: dev/standalone environments without M365 credentials simply
  // run the Bulldog-only flow and leave these unset.
  teamsJoinUrl: text("teams_join_url"),
  // Which video provider(s) to attach. "bulldog" = Bulldog Meet only,
  // "both" = Bulldog + parallel Teams meeting, "teams" = Teams only (the
  // Bulldog link still exists as a fallback but is de-emphasized in UI).
  // Default "both" so existing rows behave like the current implicit policy.
  provider: text("provider").default("both").notNull(),
  teamsMeetingId: text("teams_meeting_id"),
  // Unified meetings model — nullable FK to the canonical meeting row.
  meetingId: text("meeting_id").references(() => meetings.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
export type ScheduledCall = typeof scheduledCalls.$inferSelect;
export type MeetingProvider = "bulldog" | "both" | "teams";

export const rsvpResponses = ["pending", "yes", "no", "maybe"] as const;
export type RsvpResponse = typeof rsvpResponses[number];

export const scheduledCallInvitees = sqliteTable("scheduled_call_invitees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scheduledCallId: integer("scheduled_call_id").notNull().references(() => scheduledCalls.id),
  // Exactly one of (userId, externalPhone, externalEmail) is set. The
  // dispatch loop fans out via whichever channel applies: in-app +
  // SMS for users with phones, SMS-only for external phone-only invitees,
  // email-only for external email-only invitees.
  userId: integer("user_id").references(() => users.id),
  externalPhone: text("external_phone"),         // E.164
  externalEmail: text("external_email"),
  // Short code used in SMS RSVP replies ("#A4F9 Y"). Stable per invitee.
  rsvpCode: text("rsvp_code").notNull(),
  response: text("response", { enum: rsvpResponses }).notNull().default("pending"),
  respondedAt: integer("responded_at", { mode: "timestamp" }),
  // "sms" | "in_app" | "email" | "web" — how the RSVP was captured.
  responseChannel: text("response_channel"),
  // Track that we've actually sent the invite SMS / email so we don't
  // resend on every server restart.
  inviteSentAt: integer("invite_sent_at", { mode: "timestamp" }),
  inviteError: text("invite_error"),
  reminderSentAt: integer("reminder_sent_at", { mode: "timestamp" }),
});
export type ScheduledCallInvitee = typeof scheduledCallInvitees.$inferSelect;

export const insertScheduledCallSchema = createInsertSchema(scheduledCalls).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  reminderSentAt: true,
  icsSequence: true,
  status: true,
  roomName: true,
  teamsJoinUrl: true,
  provider: true,
  teamsMeetingId: true,
});

/* ─────────────────── WORK OBJECTS ─────────────────── */
// A work_object is a domain entity (job_site, work_project, change_order,
// safety_incident) that lives alongside chat. Channels link to one or more
// work_objects, and activity on the object is auto-posted into the channel
// timeline as system messages.
//
// We use a single table with a `kind` discriminator + typed JSON `attributes`
// blob so we can add new kinds (e.g. "crew", "asset", "rfi") without a
// migration. Common fields (status, owner, ref) are first-class columns so
// they can be indexed and queried efficiently.
//
// NOTE: `work_project` is the utility-construction job project (e.g. "Boeing
// Fiber Install") — different from the chat-side `projects` table which is
// the chat workspace / Discord-style "server". Naming them differently here
// avoids the collision.
export const workObjectKinds = ["job_site", "work_project", "change_order", "safety_incident"] as const;
export type WorkObjectKind = typeof workObjectKinds[number];

// Generic status vocabulary. Different kinds may use a subset:
//   job_site:        planned | active | paused | closed
//   work_project:    planned | active | paused | closed
//   change_order:    draft | submitted | approved | rejected | closed
//   safety_incident: open | investigating | resolved | closed
export const workObjectStatuses = [
  "planned", "active", "paused", "closed",
  "draft", "submitted", "approved", "rejected",
  "open", "investigating", "resolved",
] as const;
export type WorkObjectStatus = typeof workObjectStatuses[number];

export const workObjects = sqliteTable("work_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  // Which company (chat-side `projects` row) owns this job. Backfilled to
  // VFD for all pre-Phase-1.8 rows. Required going forward; left nullable
  // here so the migration can land before backfill on legacy DBs.
  projectId: integer("project_id").references(() => projects.id),
  kind: text("kind", { enum: workObjectKinds }).notNull(),
  // Human reference used in chat ("BOE-FIBER-01", "CO-2026-014"). Unique
  // within (orgId, kind) so /object BOE-FIBER-01 always resolves.
  ref: text("ref").notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: workObjectStatuses }).notNull().default("active"),
  description: text("description"),
  // Optional parent — change_order/safety_incident hang off a work_project.
  parentId: integer("parent_id"),
  // User responsible (foreman/PM). Optional; many objects start unassigned.
  ownerUserId: integer("owner_user_id").references(() => users.id),
  // JSON blob of kind-specific fields (location, customer, dollar amount,
  // severity, etc.). Schema enforced in application code via Zod.
  attributes: text("attributes"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  closedAt: integer("closed_at", { mode: "timestamp" }),
});
export type WorkObject = typeof workObjects.$inferSelect;

// Per-kind attribute schemas. Validated server-side before write.
export const jobSiteAttributesSchema = z.object({
  address: z.string().max(300).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  state: z.string().max(40).optional().nullable(),
  zip: z.string().max(20).optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  customer: z.string().max(160).optional().nullable(),
  startDate: z.string().optional().nullable(),   // ISO date
  targetEndDate: z.string().optional().nullable(),
}).strict();
export const workProjectAttributesSchema = z.object({
  customer: z.string().max(160).optional().nullable(),
  contractValue: z.number().optional().nullable(),
  startDate: z.string().optional().nullable(),
  targetEndDate: z.string().optional().nullable(),
  pmUserId: z.number().int().positive().optional().nullable(),
  foremanUserId: z.number().int().positive().optional().nullable(),
}).strict();
export const changeOrderAttributesSchema = z.object({
  amount: z.number().optional().nullable(),
  reason: z.string().max(2000).optional().nullable(),
  submittedDate: z.string().optional().nullable(),
  approvedDate: z.string().optional().nullable(),
  approvedByName: z.string().max(160).optional().nullable(),
}).strict();
export const safetyIncidentSeverities = ["near_miss", "first_aid", "recordable", "lost_time", "fatality"] as const;
export type SafetyIncidentSeverity = typeof safetyIncidentSeverities[number];
export const safetyIncidentAttributesSchema = z.object({
  severity: z.enum(safetyIncidentSeverities).optional().nullable(),
  occurredAt: z.string().optional().nullable(),   // ISO datetime
  location: z.string().max(300).optional().nullable(),
  injuredUserId: z.number().int().positive().optional().nullable(),
  injuredName: z.string().max(160).optional().nullable(),
  rootCause: z.string().max(2000).optional().nullable(),
  correctiveAction: z.string().max(2000).optional().nullable(),
}).strict();

export type JobSiteAttributes = z.infer<typeof jobSiteAttributesSchema>;
export type WorkProjectAttributes = z.infer<typeof workProjectAttributesSchema>;
export type ChangeOrderAttributes = z.infer<typeof changeOrderAttributesSchema>;
export type SafetyIncidentAttributes = z.infer<typeof safetyIncidentAttributesSchema>;

// Create payload for POST /api/work-objects (and the /object slash command).
export const workObjectCreateSchema = z.object({
  kind: z.enum(workObjectKinds),
  ref: z.string().min(1).max(80).regex(/^[A-Za-z0-9._\-]+$/, "ref may only contain letters, numbers, dot, dash, underscore"),
  title: z.string().min(1).max(200),
  status: z.enum(workObjectStatuses).optional(),
  description: z.string().max(4000).optional().nullable(),
  parentId: z.number().int().positive().optional().nullable(),
  ownerUserId: z.number().int().positive().optional().nullable(),
  attributes: z.record(z.any()).optional(),
});
export type WorkObjectCreateInput = z.infer<typeof workObjectCreateSchema>;

export const workObjectUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: z.enum(workObjectStatuses).optional(),
  description: z.string().max(4000).nullable().optional(),
  ownerUserId: z.number().int().positive().nullable().optional(),
  parentId: z.number().int().positive().nullable().optional(),
  attributes: z.record(z.any()).optional(),
});
export type WorkObjectUpdateInput = z.infer<typeof workObjectUpdateSchema>;

/* ─────────────────── WORK OBJECT ↔ CHANNEL LINKS ─────────────────── */
// A channel may be linked to multiple work_objects (and vice-versa) so a
// joint "#daily-standup" channel can show every active job site, while a
// dedicated "#boe-fiber-01" channel is linked to exactly one project.
export const workObjectChannelLinks = sqliteTable("work_object_channel_links", {
  workObjectId: integer("work_object_id").notNull().references(() => workObjects.id),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  // "primary" link auto-posts activity into the channel; "secondary" only
  // shows in the right-rail. Each channel can have at most one primary.
  linkType: text("link_type", { enum: ["primary", "secondary"] as const }).notNull().default("primary"),
  linkedAt: integer("linked_at", { mode: "timestamp" }).notNull(),
  linkedByUserId: integer("linked_by_user_id").notNull().references(() => users.id),
}, (t) => ({ pk: primaryKey({ columns: [t.workObjectId, t.channelId] }) }));
export type WorkObjectChannelLink = typeof workObjectChannelLinks.$inferSelect;

/* ─────────────────── WORK OBJECT ACTIVITY ─────────────────── */
// Timeline of changes for an object. Each entry can optionally be mirrored
// as a system message into linked channels.
export const workObjectActivityTypes = [
  "created", "status_changed", "owner_changed", "updated", "linked", "unlinked", "closed", "reopened", "comment",
] as const;
export type WorkObjectActivityType = typeof workObjectActivityTypes[number];

export const workObjectActivity = sqliteTable("work_object_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workObjectId: integer("work_object_id").notNull().references(() => workObjects.id),
  type: text("type", { enum: workObjectActivityTypes }).notNull(),
  // Actor; null for system-generated events.
  actorUserId: integer("actor_user_id").references(() => users.id),
  // Free-form JSON payload describing the change ("from":"active","to":"paused", etc.)
  payload: text("payload"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export type WorkObjectActivity = typeof workObjectActivity.$inferSelect;

/* ─────────────────── LIVEKIT ROOMS ─────────────────── */
export const livekitRooms = sqliteTable("livekit_rooms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  roomName: text("room_name").notNull().unique(),
  active: integer("active", { mode: "boolean" }).notNull().default(false),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  // Unified meetings model — nullable FK to the canonical meeting row.
  meetingId: text("meeting_id").references(() => meetings.id),
});
export type LivekitRoom = typeof livekitRooms.$inferSelect;

/* ─────────────────── MEETINGS (unified model) ─────────────────── */
// A `meeting` is the single canonical record for any real-time room — a 1:1
// direct call, a scheduled call, an inline channel huddle, or a guest meeting
// joined via a public code. The legacy direct_calls / scheduled_calls /
// livekit_rooms rows still exist and carry the ringing/RSVP/egress state they
// always did; each now points at a meeting via a nullable meeting_id FK so the
// meeting is the durable identity (stable code, LiveKit room, summary policy).
export const meetingKinds = ["direct", "scheduled", "channel_huddle", "guest"] as const;
export type MeetingKind = typeof meetingKinds[number];

export const meetingStatuses = ["scheduled", "active", "ended"] as const;
export type MeetingStatus = typeof meetingStatuses[number];

// Who receives the AI clerk summary when the meeting ends.
//   none            — generate nothing / deliver to nobody
//   channel_members — everyone in the bound channel (channel_huddle/scheduled)
//   explicit        — only the hand-picked rows in meeting_summary_recipients
//   all_attendees   — everyone who actually joined (resolved from participants)
export const summaryRecipientPolicies = ["none", "channel_members", "explicit", "all_attendees"] as const;
export type SummaryRecipientPolicy = typeof summaryRecipientPolicies[number];

export const meetings = sqliteTable("meetings", {
  // Text PK (nanoid) so a meeting id can be minted before any DB round-trip
  // and is opaque/non-enumerable, unlike the autoincrement call ids.
  id: text("id").primaryKey(),
  // Human-shareable join code, format xxx-yyyy-zzz (Google-Meet style).
  code: text("code").notNull().unique(),
  orgId: integer("org_id").notNull().references(() => organizations.id),
  kind: text("kind", { enum: meetingKinds }).notNull(),
  title: text("title"),
  hostUserId: integer("host_user_id").references(() => users.id),
  // Optional channel binding (channel_huddle and channel-scoped scheduled).
  channelId: integer("channel_id").references(() => channels.id),
  // The LiveKit room name, unique per meeting. New meetings use `bdc-<code>`;
  // legacy rooms are linked through the FK on direct_calls/etc., not renamed.
  livekitRoomName: text("livekit_room_name").notNull().unique(),
  status: text("status", { enum: meetingStatuses }).notNull().default("scheduled"),
  allowGuests: integer("allow_guests", { mode: "boolean" }).notNull().default(false),
  waitingRoom: integer("waiting_room", { mode: "boolean" }).notNull().default(false),
  recordingEnabled: integer("recording_enabled", { mode: "boolean" }).notNull().default(false),
  transcriptEnabled: integer("transcript_enabled", { mode: "boolean" }).notNull().default(false),
  summaryEnabled: integer("summary_enabled", { mode: "boolean" }).notNull().default(false),
  summaryRecipientPolicy: text("summary_recipient_policy", { enum: summaryRecipientPolicies })
    .notNull()
    .default("none"),
  maxDurationMinutes: integer("max_duration_minutes").notNull().default(240),
  scheduledStartAt: integer("scheduled_start_at", { mode: "timestamp" }),
  startedAt: integer("started_at", { mode: "timestamp" }),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
export type Meeting = typeof meetings.$inferSelect;

export const meetingParticipantRoles = ["host", "cohost", "participant", "guest"] as const;
export type MeetingParticipantRole = typeof meetingParticipantRoles[number];

export const meetingParticipants = sqliteTable("meeting_participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  meetingId: text("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  // LiveKit participant identity: `u_<userId>` for authed users, `g_<nanoid>`
  // for guests. This is the join key back to LiveKit roster events.
  participantIdentity: text("participant_identity").notNull(),
  displayName: text("display_name").notNull(),
  // Null for guests (no chat account).
  userId: integer("user_id").references(() => users.id),
  role: text("role", { enum: meetingParticipantRoles }).notNull().default("participant"),
  // Where the join came from: "web" | "app" | "sip" | "guest_link" etc.
  origin: text("origin"),
  joinedAt: integer("joined_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  leftAt: integer("left_at", { mode: "timestamp" }),
});
export type MeetingParticipant = typeof meetingParticipants.$inferSelect;

// Explicit summary recipients (used when summaryRecipientPolicy = 'explicit',
// and also merged in for other policies as a hand-added extra-recipient list).
export const meetingSummaryRecipients = sqliteTable("meeting_summary_recipients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  meetingId: text("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
  // Exactly one of (userId, email) is set: a chat user gets an in-app + email
  // delivery; a bare email is an external recipient.
  userId: integer("user_id").references(() => users.id),
  email: text("email"),
  addedByUserId: integer("added_by_user_id").references(() => users.id),
  addedAt: integer("added_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});
export type MeetingSummaryRecipient = typeof meetingSummaryRecipients.$inferSelect;

export const insertMeetingSchema = createInsertSchema(meetings).omit({
  id: true, code: true, livekitRoomName: true, createdAt: true, updatedAt: true,
});
export type InsertMeeting = z.infer<typeof insertMeetingSchema>;

/* ─────────────────── AUTH PAYLOAD SCHEMAS ─────────────────── */
export const signupSchema = z.object({
  orgName: z.string().min(2).max(80),
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
export const acceptInviteSchema = z.object({
  token: z.string().min(8),
  name: z.string().min(2).max(80),
  password: z.string().min(8).max(128),
});
export const sendMessageSchema = z.object({
  content: z.string().max(4000),
  attachments: z.array(z.any()).optional(),
  attachmentIds: z.array(z.string()).optional(),
  replyToMessageId: z.number().nullable().optional(),
}).refine(
  (d) => d.content.trim().length > 0 || (d.attachmentIds?.length ?? 0) > 0,
  { message: "Message must have text or at least one attachment", path: ["content"] },
);
export const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});
