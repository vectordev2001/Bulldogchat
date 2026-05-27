import { db } from "./db";
import {
  organizations, users, projects, projectMembers, channels, messages,
  reactions, readReceipts, pushSubscriptions, sessions, invites, livekitRooms,
} from "@shared/schema";
import type {
  Organization, InsertOrganization,
  User, InsertUser, PublicUser,
  Project, InsertProject,
  Channel, InsertChannel,
  Message,
  Reaction, ReadReceipt,
  PushSubscription as PushSub,
  Session, Invite, InsertInvite,
  UserRole,
} from "@shared/schema";
import { and, eq, desc, lt, asc, sql, inArray } from "drizzle-orm";

export function sanitize(u: User): PublicUser {
  const { passwordHash: _ph, ...rest } = u;
  return rest;
}

export interface IStorage {
  /* Org */
  getOrgBySlug(slug: string): Organization | undefined;
  getOrg(id: number): Organization | undefined;
  createOrg(input: InsertOrganization): Organization;
  orgCount(): number;

  /* Users */
  getUser(id: number): User | undefined;
  getUserByEmail(email: string): User | undefined;
  createUser(input: InsertUser): User;
  listUsersByOrg(orgId: number): User[];
  listUsersByIds(ids: number[]): User[];
  updateUserLastSeen(id: number): void;
  updateUser(id: number, patch: Partial<Pick<User, "name" | "title" | "avatarUrl" | "role" | "status" | "hue">>): User | undefined;

  /* Projects */
  listProjectsForUser(userId: number): Project[];
  listProjectsByOrg(orgId: number): Project[];
  getProject(id: number): Project | undefined;
  createProject(input: InsertProject): Project;
  addProjectMember(projectId: number, userId: number, role?: string): void;
  isProjectMember(projectId: number, userId: number): boolean;
  listProjectMembers(projectId: number): User[];

  /* Channels */
  listChannelsByProject(projectId: number): Channel[];
  getChannel(id: number): Channel | undefined;
  createChannel(input: InsertChannel): Channel;

  /* Messages */
  listMessages(channelId: number, opts?: { before?: number; limit?: number }): Message[];
  getMessage(id: number): Message | undefined;
  createMessage(input: { channelId: number; userId: number; content: string; attachments?: string | null; replyToMessageId?: number | null }): Message;
  updateMessage(id: number, content: string): Message | undefined;
  deleteMessage(id: number): void;
  pinMessage(id: number, pinned: boolean): Message | undefined;

  /* Reactions */
  addReaction(messageId: number, userId: number, emoji: string): void;
  removeReaction(messageId: number, userId: number, emoji: string): void;
  listReactions(messageIds: number[]): Reaction[];

  /* Read receipts */
  setReadReceipt(channelId: number, userId: number, lastReadMessageId: number): void;

  /* Push */
  addPushSubscription(input: { userId: number; endpoint: string; p256dh: string; auth: string; deviceLabel?: string }): PushSub;
  deletePushSubscription(id: number, userId: number): void;
  listPushSubscriptionsForUsers(userIds: number[]): PushSub[];

  /* Sessions */
  createSession(input: { id: string; userId: number; tokenHash: string; expiresAt: Date }): Session;
  getSession(id: string): Session | undefined;
  deleteSession(id: string): void;

  /* Invites */
  createInvite(input: { orgId: number; projectId?: number | null; email?: string | null; role: UserRole; token: string; invitedByUserId: number; expiresAt: Date }): Invite;
  getInviteByToken(token: string): Invite | undefined;
  markInviteAccepted(id: number): void;
}

class DatabaseStorage implements IStorage {
  /* Org */
  getOrgBySlug(slug: string) { return db.select().from(organizations).where(eq(organizations.slug, slug)).get(); }
  getOrg(id: number) { return db.select().from(organizations).where(eq(organizations.id, id)).get(); }
  createOrg(input: InsertOrganization) {
    return db.insert(organizations).values({ ...input, createdAt: new Date() }).returning().get();
  }
  orgCount() {
    const row = db.select({ c: sql<number>`count(*)` }).from(organizations).get();
    return row?.c ?? 0;
  }

  /* Users */
  getUser(id: number) { return db.select().from(users).where(eq(users.id, id)).get(); }
  getUserByEmail(email: string) { return db.select().from(users).where(eq(users.email, email.toLowerCase())).get(); }
  createUser(input: InsertUser) {
    return db.insert(users).values({
      ...input,
      email: input.email.toLowerCase(),
      createdAt: new Date(),
    }).returning().get();
  }
  listUsersByOrg(orgId: number) {
    return db.select().from(users).where(eq(users.orgId, orgId)).all();
  }
  listUsersByIds(ids: number[]) {
    if (ids.length === 0) return [];
    return db.select().from(users).where(inArray(users.id, ids)).all();
  }
  updateUserLastSeen(id: number) {
    db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, id)).run();
  }
  updateUser(id: number, patch) {
    const existing = this.getUser(id);
    if (!existing) return undefined;
    return db.update(users).set(patch).where(eq(users.id, id)).returning().get();
  }

  /* Projects */
  listProjectsForUser(userId: number) {
    return db.select({
      id: projects.id, orgId: projects.orgId, name: projects.name, slug: projects.slug,
      short: projects.short, hue: projects.hue, description: projects.description, createdAt: projects.createdAt,
    }).from(projects)
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(eq(projectMembers.userId, userId))
      .orderBy(asc(projects.id))
      .all();
  }
  listProjectsByOrg(orgId: number) {
    return db.select().from(projects).where(eq(projects.orgId, orgId)).orderBy(asc(projects.id)).all();
  }
  getProject(id: number) { return db.select().from(projects).where(eq(projects.id, id)).get(); }
  createProject(input: InsertProject) {
    return db.insert(projects).values({ ...input, createdAt: new Date() }).returning().get();
  }
  addProjectMember(projectId: number, userId: number, role = "member") {
    const exists = db.select().from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))).get();
    if (exists) return;
    db.insert(projectMembers).values({ projectId, userId, role }).run();
  }
  isProjectMember(projectId: number, userId: number) {
    return !!db.select().from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))).get();
  }
  listProjectMembers(projectId: number) {
    return db.select({
      id: users.id, orgId: users.orgId, email: users.email, passwordHash: users.passwordHash,
      name: users.name, title: users.title, avatarUrl: users.avatarUrl, hue: users.hue,
      role: users.role, status: users.status, createdAt: users.createdAt, lastSeenAt: users.lastSeenAt,
    }).from(users)
      .innerJoin(projectMembers, eq(projectMembers.userId, users.id))
      .where(eq(projectMembers.projectId, projectId))
      .all() as User[];
  }

  /* Channels */
  listChannelsByProject(projectId: number) {
    return db.select().from(channels).where(eq(channels.projectId, projectId)).orderBy(asc(channels.position), asc(channels.id)).all();
  }
  getChannel(id: number) { return db.select().from(channels).where(eq(channels.id, id)).get(); }
  createChannel(input: InsertChannel) {
    return db.insert(channels).values({ ...input, createdAt: new Date() }).returning().get();
  }

  /* Messages */
  listMessages(channelId: number, opts: { before?: number; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const where = opts.before
      ? and(eq(messages.channelId, channelId), lt(messages.id, opts.before))
      : eq(messages.channelId, channelId);
    const rows = db.select().from(messages).where(where).orderBy(desc(messages.id)).limit(limit).all();
    return rows.reverse();
  }
  getMessage(id: number) { return db.select().from(messages).where(eq(messages.id, id)).get(); }
  createMessage(input: { channelId: number; userId: number; content: string; attachments?: string | null; replyToMessageId?: number | null }) {
    return db.insert(messages).values({
      channelId: input.channelId,
      userId: input.userId,
      content: input.content,
      attachments: input.attachments ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      createdAt: new Date(),
    }).returning().get();
  }
  updateMessage(id: number, content: string) {
    return db.update(messages).set({ content, editedAt: new Date() }).where(eq(messages.id, id)).returning().get();
  }
  deleteMessage(id: number) {
    db.delete(reactions).where(eq(reactions.messageId, id)).run();
    db.delete(messages).where(eq(messages.id, id)).run();
  }
  pinMessage(id: number, pinned: boolean) {
    return db.update(messages).set({ isPinned: pinned }).where(eq(messages.id, id)).returning().get();
  }

  /* Reactions */
  addReaction(messageId: number, userId: number, emoji: string) {
    try {
      db.insert(reactions).values({ messageId, userId, emoji }).run();
    } catch { /* duplicate ignored */ }
  }
  removeReaction(messageId: number, userId: number, emoji: string) {
    db.delete(reactions).where(and(
      eq(reactions.messageId, messageId),
      eq(reactions.userId, userId),
      eq(reactions.emoji, emoji),
    )).run();
  }
  listReactions(messageIds: number[]) {
    if (messageIds.length === 0) return [];
    return db.select().from(reactions).where(inArray(reactions.messageId, messageIds)).all();
  }

  /* Read receipts */
  setReadReceipt(channelId: number, userId: number, lastReadMessageId: number) {
    const existing = db.select().from(readReceipts).where(and(
      eq(readReceipts.channelId, channelId), eq(readReceipts.userId, userId))).get();
    if (existing) {
      db.update(readReceipts).set({ lastReadMessageId, updatedAt: new Date() })
        .where(and(eq(readReceipts.channelId, channelId), eq(readReceipts.userId, userId))).run();
    } else {
      db.insert(readReceipts).values({ channelId, userId, lastReadMessageId, updatedAt: new Date() }).run();
    }
  }

  /* Push */
  addPushSubscription(input) {
    const existing = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, input.endpoint)).get();
    if (existing) return existing;
    return db.insert(pushSubscriptions).values({ ...input, createdAt: new Date() }).returning().get();
  }
  deletePushSubscription(id: number, userId: number) {
    db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId))).run();
  }
  listPushSubscriptionsForUsers(userIds: number[]) {
    if (userIds.length === 0) return [];
    return db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds)).all();
  }

  /* Sessions */
  createSession(input) {
    return db.insert(sessions).values({ ...input, createdAt: new Date() }).returning().get();
  }
  getSession(id: string) { return db.select().from(sessions).where(eq(sessions.id, id)).get(); }
  deleteSession(id: string) { db.delete(sessions).where(eq(sessions.id, id)).run(); }

  /* Invites */
  createInvite(input) {
    return db.insert(invites).values({
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      email: input.email ?? null,
      role: input.role,
      token: input.token,
      invitedByUserId: input.invitedByUserId,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    }).returning().get();
  }
  getInviteByToken(token: string) {
    return db.select().from(invites).where(eq(invites.token, token)).get();
  }
  markInviteAccepted(id: number) {
    db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, id)).run();
  }
}

export const storage: IStorage = new DatabaseStorage();
