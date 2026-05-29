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
  deactivated: integer("deactivated", { mode: "boolean" }).notNull().default(false),
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

export const channels = sqliteTable("channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  type: text("type", { enum: channelTypes }).notNull().default("text"),
  topic: text("topic"),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
export const insertChannelSchema = createInsertSchema(channels).omit({ id: true, createdAt: true });
export type Channel = typeof channels.$inferSelect;
export type InsertChannel = z.infer<typeof insertChannelSchema>;

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
});
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
