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
export const userRoles = ["admin", "foreman", "office", "field", "safety"] as const;
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
  role: text("role", { enum: userRoles }).notNull().default("field"),
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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export const insertChannelSchema = createInsertSchema(channels).omit({ id: true, createdAt: true });
export type Channel = typeof channels.$inferSelect;
export type InsertChannel = z.infer<typeof insertChannelSchema>;

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
] as const;
export type SystemMessageKind = typeof systemMessageKinds[number];
export interface SystemMessageMeta {
  system: true;
  kind: SystemMessageKind;
  workObjectId: number;
  ref: string;
  woKind: WorkObjectKind;
  woTitle: string;
  fields?: Record<string, { from?: unknown; to?: unknown }>;
}
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
  role: text("role", { enum: userRoles }).notNull().default("field"),
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
});
export type Recording = typeof recordings.$inferSelect;

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
});
export type DirectCall = typeof directCalls.$inferSelect;

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
});
export type LivekitRoom = typeof livekitRooms.$inferSelect;

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
  content: z.string().min(1).max(4000),
  attachments: z.array(z.any()).optional(),
  attachmentIds: z.array(z.string()).optional(),
  replyToMessageId: z.number().nullable().optional(),
});
export const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});
