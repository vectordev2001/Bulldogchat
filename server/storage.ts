import { db, rawDb } from "./db";
import {
  organizations, users, projects, projectMembers, channels, channelMembers, messages,
  reactions, readReceipts, pushSubscriptions, sessions, invites, livekitRooms,
  attachments, messageMentions, recordings, expoPushTokens, directCalls,
  workObjects, workObjectChannelLinks, workObjectActivity,
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
  Attachment, MessageMention, MentionType,
  Recording, RecordingStatus,
  ExpoPushToken,
  DirectCall, DirectCallStatus,
  WorkObject, WorkObjectKind, WorkObjectStatus,
  WorkObjectChannelLink, WorkObjectActivity, WorkObjectActivityType,
  LinkedContractMeta,
} from "@shared/schema";
import { and, eq, desc, lt, asc, sql, inArray, isNull } from "drizzle-orm";

// Anyone who hasn't pinged the server within this window is considered offline.
// Auth middleware refreshes lastSeenAt on every authenticated request, and the
// client polls /api/projects/:id/members + /api/org/members frequently while open,
// so 3 minutes comfortably covers a couple of missed polls without false negatives.
const PRESENCE_ONLINE_WINDOW_MS = 3 * 60 * 1000;

export function sanitize(u: User): PublicUser {
  const { passwordHash: _ph, ...rest } = u;
  // Derive live status from lastSeenAt. The stored `status` column is only
  // honored for the manual offline override (e.g. user marked themselves away);
  // otherwise we ignore it and compute fresh from the heartbeat.
  const lastSeenMs = rest.lastSeenAt ? new Date(rest.lastSeenAt).getTime() : 0;
  const seenRecently = lastSeenMs > 0 && (Date.now() - lastSeenMs) < PRESENCE_ONLINE_WINDOW_MS;
  // If the user explicitly set themselves offline, respect that.
  // Anything else (online / null / legacy default) is recomputed from heartbeat.
  const derivedStatus = rest.status === "offline" ? "offline" : (seenRecently ? "online" : "offline");
  return { ...rest, status: derivedStatus };
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
  updateUser(id: number, patch: Partial<Pick<User, "name" | "title" | "avatarUrl" | "role" | "status" | "presence" | "hue" | "phone">>): User | undefined;

  /* Projects */
  listProjectsForUser(userId: number): Project[];
  listProjectsByOrg(orgId: number): Project[];
  getProject(id: number): Project | undefined;
  createProject(input: InsertProject): Project;
  addProjectMember(projectId: number, userId: number, role?: string): void;
  removeProjectMember(projectId: number, userId: number): void;
  isProjectMember(projectId: number, userId: number): boolean;
  listProjectMembers(projectId: number): User[];
  // Phase 1.8: list every company (project) a user belongs to. Used by the
  // company switcher to populate the dropdown for non-admins.
  listProjectsForUserInOrg(userId: number, orgId: number): Project[];

  /* Channels */
  listChannelsByProject(projectId: number): Channel[];
  listChannelsForUserInProject(projectId: number, userId: number): Channel[];
  // Phase 1.8: channels nested under a specific Job (work_object). Used
  // when the sidebar renders the per-job channel group.
  listChannelsByJob(workObjectId: number): Channel[];
  getChannel(id: number): Channel | undefined;
  findChannelByName(name: string): Channel | undefined;
  createChannel(input: InsertChannel): Channel;
  setChannelLinkedContract(channelId: number, meta: LinkedContractMeta | null): Channel | undefined;
  // Phase 1.8: admin "move channel" support. Lets admins re-home a channel
  // to a different company and/or nest it under a different job.
  updateChannel(id: number, patch: Partial<Pick<Channel, "name" | "topic" | "projectId" | "workObjectId" | "position">>): Channel | undefined;
  deleteChannelCascade(channelId: number): void;
  deleteWorkObjectCascade(workObjectId: number): void;
  addChannelMembers(channelId: number, userIds: number[]): void;
  listChannelMemberIds(channelId: number): number[];
  isChannelMember(channelId: number, userId: number): boolean;
  removeChannelMember(channelId: number, userId: number): void;
  userCanSeeChannel(channel: Channel, user: User): boolean;

  /* DMs (channel rows with scope='dm'). Stored as channels under the user's
     home project so messages/reactions/attachments reuse channel infra. */
  listDmChannelsForUser(userId: number): Channel[];
  findDmChannelByMemberSet(memberIds: number[]): Channel | undefined;
  createDmChannel(input: { projectId: number; memberIds: number[]; createdByUserId: number }): Channel;

  /* Messages */
  listMessages(channelId: number, opts?: { before?: number; limit?: number }): Message[];
  getMessage(id: number): Message | undefined;
  createMessage(input: { channelId: number; userId: number; content: string; attachments?: string | null; replyToMessageId?: number | null; meta?: string | null }): Message;
  updateMessage(id: number, content: string): Message | undefined;
  deleteMessage(id: number): void;
  tombstoneMessage(id: number, deletedByUserId: number): void;
  tombstoneChannelMessages(channelId: number, deletedByUserId: number): { ids: number[] };
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

  /* Direct calls (1:1) */
  createDirectCall(input: { orgId: number; callerId: number; calleeId: number; roomName: string; kind: "voice" | "video" }): DirectCall;
  getDirectCall(id: number): DirectCall | undefined;
  updateDirectCallStatus(id: number, status: DirectCallStatus, opts?: { answeredAt?: Date; endedAt?: Date }): DirectCall | undefined;
  listActiveCallsForUser(userId: number): DirectCall[];

  /* Sessions */
  createSession(input: { id: string; userId: number; tokenHash: string; expiresAt: Date }): Session;
  getSession(id: string): Session | undefined;
  deleteSession(id: string): void;

  /* Invites */
  createInvite(input: { orgId: number; projectId?: number | null; email?: string | null; role: UserRole; token: string; invitedByUserId: number; expiresAt: Date }): Invite;
  getInviteByToken(token: string): Invite | undefined;
  markInviteAccepted(id: number): void;
  listInvitesByOrg(orgId: number): Invite[];
  deleteInvite(id: number): void;

  /* Attachments */
  createAttachment(input: { id: string; uploaderUserId: number; filename: string; contentType: string; sizeBytes: number; storageKey: string; thumbnailKey?: string | null }): Attachment;
  getAttachment(id: string): Attachment | undefined;
  listAttachmentsForMessages(messageIds: number[]): Attachment[];
  linkAttachmentsToMessage(ids: string[], messageId: number, uploaderUserId: number): void;
  deleteAttachment(id: string): void;

  /* Mentions */
  createMentions(messageId: number, mentions: Array<{ userId: number | null; type: MentionType }>): void;
  listMentionsForMessages(messageIds: number[]): MessageMention[];

  /* Threads */
  listReplies(messageId: number): Message[];
  threadReplyCounts(messageIds: number[]): Map<number, { count: number; lastAt: number }>;

  /* Search */
  searchMessages(opts: { q: string; channelIds: number[]; userId?: number; fromDate?: Date; toDate?: Date; limit?: number }): Message[];

  /* Recordings */
  createRecording(input: { channelId: number; startedByUserId: number; egressId?: string | null }): Recording;
  updateRecording(id: number, patch: Partial<Pick<Recording, "egressId" | "endedAt" | "durationSeconds" | "storageUrl" | "storageKey" | "fileSizeBytes" | "status">>): Recording | undefined;
  getRecording(id: number): Recording | undefined;
  listRecordingsForChannel(channelId: number): Recording[];
  getActiveRecordingForChannel(channelId: number): Recording | undefined;
  findRecordingByEgressId(egressId: string): Recording | undefined;

  /* Expo push */
  upsertExpoPushToken(input: { userId: number; token: string; deviceLabel?: string | null }): ExpoPushToken;
  listExpoTokensForUsers(userIds: number[]): ExpoPushToken[];
  deleteExpoTokenByToken(token: string): void;

  /* Work Objects */
  createWorkObject(input: { orgId: number; projectId?: number | null; kind: WorkObjectKind; ref: string; title: string; status?: WorkObjectStatus; description?: string | null; parentId?: number | null; ownerUserId?: number | null; attributes?: string | null; createdByUserId: number }): WorkObject;
  getWorkObject(id: number): WorkObject | undefined;
  getWorkObjectByRef(orgId: number, kind: WorkObjectKind, ref: string): WorkObject | undefined;
  findWorkObjectByRefAcrossKinds(orgId: number, ref: string): WorkObject | undefined;
  listWorkObjectsByOrg(orgId: number, opts?: { kind?: WorkObjectKind; status?: WorkObjectStatus; includeClosed?: boolean; limit?: number; projectId?: number }): WorkObject[];
  listWorkObjectsByIds(ids: number[]): WorkObject[];
  updateWorkObject(id: number, patch: Partial<Pick<WorkObject, "title" | "status" | "description" | "ownerUserId" | "parentId" | "attributes" | "closedAt">>): WorkObject | undefined;

  /* Work Object ↔ Channel links */
  linkWorkObjectToChannel(input: { workObjectId: number; channelId: number; linkType?: "primary" | "secondary"; linkedByUserId: number }): WorkObjectChannelLink;
  unlinkWorkObjectFromChannel(workObjectId: number, channelId: number): void;
  listLinksForChannel(channelId: number): WorkObjectChannelLink[];
  listLinksForWorkObject(workObjectId: number): WorkObjectChannelLink[];
  listChannelsForWorkObject(workObjectId: number): Channel[];
  listWorkObjectsForChannel(channelId: number): WorkObject[];

  /* Work Object activity */
  appendWorkObjectActivity(input: { workObjectId: number; type: WorkObjectActivityType; actorUserId?: number | null; payload?: string | null }): WorkObjectActivity;
  listWorkObjectActivity(workObjectId: number, opts?: { limit?: number }): WorkObjectActivity[];

  /* Admin */
  resetUserPassword(userId: number, newHash: string): void;
  setUserDeactivated(userId: number, deactivated: boolean): User | undefined;
  deleteUserCascade(userId: number): void;
  deleteAllSessionsForUser(userId: number): void;
  updateOrg(id: number, patch: Partial<Pick<Organization, "name" | "plan">>): Organization | undefined;
  updateProject(id: number, patch: Partial<Pick<Project, "name" | "description" | "short" | "hue">>): Project | undefined;
  deleteProjectCascade(projectId: number): void;
  countChannelsForProject(projectId: number): number;
  countMembersForProject(projectId: number): number;
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
    // Phase 1.9.1: dropped the "Bulldog - " display prefix — the Bulldog
    // brand only shows up where it matters (e.g. as the outbound SIP
    // caller display), not in front of every name inside the app. We
    // keep the legacy strip logic so any name that still includes the
    // old prefix lands clean on insert.
    const baseName = (input.name ?? "").trim() || input.email.toLowerCase();
    const clean = baseName.startsWith("Bulldog - ") ? baseName.slice("Bulldog - ".length) : baseName;
    return db.insert(users).values({
      ...input,
      name: clean,
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
  removeProjectMember(projectId: number, userId: number) {
    db.delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .run();
  }
  // Companies a user can access, scoped to their org. Admins get every
  // project in the org regardless of project_members rows so admin tooling
  // still works; everyone else is filtered through project_members.
  listProjectsForUserInOrg(userId: number, orgId: number): Project[] {
    const user = this.getUser(userId);
    if (!user) return [];
    if (user.role === "admin") {
      return db.select().from(projects).where(eq(projects.orgId, orgId)).orderBy(asc(projects.id)).all();
    }
    return db.select({
      id: projects.id, orgId: projects.orgId, name: projects.name, slug: projects.slug,
      short: projects.short, hue: projects.hue, description: projects.description,
      createdAt: projects.createdAt,
    }).from(projects)
      .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projects.orgId, orgId), eq(projectMembers.userId, userId)))
      .orderBy(asc(projects.id))
      .all() as Project[];
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
    // Hide DM channels from the project sidebar. DMs live in their own
    // "Direct Messages" section, surfaced via listDmChannelsForUser.
    return db.select().from(channels)
      .where(and(eq(channels.projectId, projectId), sql`(${channels.scope} IS NULL OR ${channels.scope} != 'dm')`))
      .orderBy(asc(channels.position), asc(channels.id)).all();
  }
  // Channels in this project that the given user is allowed to see, given
  // each channel's scope. Computed in JS (not SQL) so the rule set stays in
  // one place.
  listChannelsForUserInProject(projectId: number, userId: number) {
    const all = this.listChannelsByProject(projectId);
    const user = this.getUser(userId);
    if (!user) return [];
    return all.filter(c => this.userCanSeeChannel(c, user));
  }
  listChannelsByJob(workObjectId: number) {
    return db.select().from(channels)
      .where(eq(channels.workObjectId, workObjectId))
      .orderBy(asc(channels.position), asc(channels.id))
      .all();
  }
  getChannel(id: number) { return db.select().from(channels).where(eq(channels.id, id)).get(); }
  // Resolve a channel by its human name, tolerant of casing/spacing/dash
  // differences ("El Paso Data Center" == "el-paso-data center" ==
  // "el-paso-data-center"). Both the query and each stored name are reduced to
  // a canonical slug (lowercase, runs of non-alphanumerics collapsed to one
  // dash, edges trimmed) before comparison. Returns the first match by id, or
  // undefined. Used by the internal ops "clear channel" escape hatch.
  findChannelByName(name: string): Channel | undefined {
    const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const target = slug(name);
    if (!target) return undefined;
    const all = db.select().from(channels).orderBy(asc(channels.id)).all();
    return all.find(c => slug(c.name) === target);
  }
  createChannel(input: InsertChannel) {
    // Cast to any: InsertChannel's auto-generated linkedContract type is the
    // widened `Json` from drizzle-zod, but the column is $type<LinkedContractMeta|null>.
    // Channels are usually created without linkedContract; attach happens via
    // setChannelLinkedContract or the create-route handler explicitly.
    return db.insert(channels).values({ ...(input as any), createdAt: new Date() }).returning().get();
  }
  // Phase 1.9.3 — attach (or replace) a contract link on a channel. Pass
  // null to detach. Returns the updated channel.
  setChannelLinkedContract(channelId: number, meta: LinkedContractMeta | null) {
    return db.update(channels).set({ linkedContract: meta }).where(eq(channels.id, channelId)).returning().get();
  }
  // Admin-only "move channel" support. Caller validates that the target
  // workObjectId (if set) belongs to the target projectId.
  updateChannel(id: number, patch: Partial<Pick<Channel, "name" | "topic" | "projectId" | "workObjectId" | "position">>) {
    if (Object.keys(patch).length === 0) return this.getChannel(id);
    return db.update(channels).set(patch).where(eq(channels.id, id)).returning().get();
  }
  addChannelMembers(channelId: number, userIds: number[]) {
    if (userIds.length === 0) return;
    const stmt = rawDb.prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)`);
    const tx = rawDb.transaction((ids: number[]) => {
      for (const uid of ids) stmt.run(channelId, uid);
    });
    tx(userIds);
  }
  listChannelMemberIds(channelId: number) {
    return db.select({ userId: channelMembers.userId }).from(channelMembers)
      .where(eq(channelMembers.channelId, channelId)).all().map(r => r.userId);
  }
  isChannelMember(channelId: number, userId: number) {
    return !!db.select().from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId))).get();
  }
  removeChannelMember(channelId: number, userId: number) {
    db.delete(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId))).run();
  }
  // Single source of truth for scope visibility. Admins always see every
  // channel in their org (so admin chat tools stay functional). For everyone
  // else, the rule is by scope.
  userCanSeeChannel(channel: Channel, user: User) {
    if (user.role === "admin") return true;
    const scope = (channel.scope ?? "global") as "global" | "entity" | "team" | "private";
    if (scope === "global") return true;
    if (scope === "entity") {
      if (!channel.entityId) return false;
      // We treat user.title as the user's entity / department tag.
      return (user.title ?? "").toLowerCase() === channel.entityId.toLowerCase();
    }
    if (scope === "team") {
      if (!channel.teamRole) return false;
      return user.role === channel.teamRole;
    }
    if (scope === "private" || scope === "dm") {
      // DMs share the explicit-member model with private channels. Admins
      // still get a bypass at the top of this function, but the DM endpoints
      // never list DMs they aren't a member of, so this is mostly defense in
      // depth.
      return this.isChannelMember(channel.id, user.id);
    }
    return false;
  }

  /* ─────────────── DM helpers ─────────────── */
  // Every DM channel this user is in, newest first by last message activity.
  // We pull the channels first, then sort by the max(message.id) in each,
  // falling back to channel id when there are no messages yet.
  listDmChannelsForUser(userId: number) {
    const rows = db.select({ c: channels }).from(channels)
      .innerJoin(channelMembers, eq(channels.id, channelMembers.channelId))
      .where(and(eq(channelMembers.userId, userId), eq(channels.scope, "dm")))
      .all();
    const list = rows.map(r => r.c);
    if (list.length === 0) return [];
    // Build a single SQL aggregate so we don't fan out N queries.
    const ids = list.map(c => c.id);
    const placeholders = ids.map(() => "?").join(",");
    const lastRows = rawDb.prepare(
      `SELECT channel_id AS channelId, MAX(id) AS lastId FROM messages WHERE channel_id IN (${placeholders}) GROUP BY channel_id`,
    ).all(...ids) as Array<{ channelId: number; lastId: number }>;
    const lastById = new Map<number, number>();
    for (const r of lastRows) lastById.set(r.channelId, r.lastId ?? 0);
    return [...list].sort((a, b) => {
      const al = lastById.get(a.id) ?? 0;
      const bl = lastById.get(b.id) ?? 0;
      if (al !== bl) return bl - al; // most-recent activity first
      return b.id - a.id; // newer channels first
    });
  }

  // Returns the existing DM channel whose channel_members set EXACTLY matches
  // the given user-id set, or undefined if no such channel exists. Used by
  // POST /api/dms to make DM creation idempotent (same picker → same thread).
  findDmChannelByMemberSet(memberIds: number[]) {
    if (memberIds.length === 0) return undefined;
    const sorted = Array.from(new Set(memberIds)).sort((a, b) => a - b);
    const placeholders = sorted.map(() => "?").join(",");
    // 1) Find candidate DM channels that include ALL requested members.
    // 2) Reject any whose member count differs from the requested set.
    const candidates = rawDb.prepare(`
      SELECT cm.channel_id AS channelId
      FROM channel_members cm
      JOIN channels c ON c.id = cm.channel_id
      WHERE c.scope = 'dm' AND cm.user_id IN (${placeholders})
      GROUP BY cm.channel_id
      HAVING COUNT(DISTINCT cm.user_id) = ?
    `).all(...sorted, sorted.length) as Array<{ channelId: number }>;
    for (const { channelId } of candidates) {
      const cnt = (rawDb.prepare(`SELECT COUNT(*) AS c FROM channel_members WHERE channel_id = ?`)
        .get(channelId) as { c: number }).c;
      if (cnt === sorted.length) return this.getChannel(channelId);
    }
    return undefined;
  }

  // Create a new DM channel under the given project. Name is synthesized from
  // member ids — it's an internal handle; the client renders the row using
  // member display names instead.
  createDmChannel(input: { projectId: number; memberIds: number[]; createdByUserId: number }) {
    const allMembers = Array.from(new Set([input.createdByUserId, ...input.memberIds]));
    const internalName = `dm-${allMembers.sort((a, b) => a - b).join("-")}-${Date.now().toString(36)}`;
    const ch = db.insert(channels).values({
      projectId: input.projectId,
      name: internalName,
      type: "text",
      topic: null,
      position: 0,
      scope: "dm",
      entityId: null,
      teamRole: null,
      workObjectId: null,
      createdAt: new Date(),
    } as any).returning().get();
    this.addChannelMembers(ch.id, allMembers);
    return ch;
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
  createMessage(input: { channelId: number; userId: number; content: string; attachments?: string | null; replyToMessageId?: number | null; meta?: string | null }) {
    return db.insert(messages).values({
      channelId: input.channelId,
      userId: input.userId,
      content: input.content,
      attachments: input.attachments ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      meta: input.meta ?? null,
      createdAt: new Date(),
    } as any).returning().get();
  }
  updateMessage(id: number, content: string) {
    return db.update(messages).set({ content, editedAt: new Date() }).where(eq(messages.id, id)).returning().get();
  }
  deleteMessage(id: number) {
    db.delete(reactions).where(eq(reactions.messageId, id)).run();
    db.delete(messages).where(eq(messages.id, id)).run();
  }
  // Tombstone delete: wipe content/attachments/reactions/mentions but keep
  // the row so replyToMessageId chains stay intact. Clients render a
  // "Message deleted" placeholder for tombstoned rows.
  tombstoneMessage(id: number, deletedByUserId: number) {
    // Strip reactions and mentions — nothing meaningful to react to or be
    // mentioned in once the content is gone.
    db.delete(reactions).where(eq(reactions.messageId, id)).run();
    rawDb.prepare("DELETE FROM message_mentions WHERE message_id = ?").run(id);
    // Unlink attachments from this message. We leave the attachment rows
    // alone — they may be referenced elsewhere or kept for object-store GC.
    rawDb.prepare("UPDATE attachments SET message_id = NULL WHERE message_id = ?").run(id);
    db.update(messages).set({
      content: "",
      attachments: null,
      deletedAt: new Date(),
      deletedByUserId,
    }).where(eq(messages.id, id)).run();
  }
  // Bulk tombstone every non-deleted message in a channel. Same semantics as
  // tombstoneMessage but in one transaction so admins can clear a channel
  // without N round-trips. Returns the ids that were tombstoned so the
  // caller can fan out a single delete event per id over SSE.
  tombstoneChannelMessages(channelId: number, deletedByUserId: number): { ids: number[] } {
    const rows = rawDb.prepare(
      "SELECT id FROM messages WHERE channel_id = ? AND deleted_at IS NULL"
    ).all(channelId) as Array<{ id: number }>;
    const ids = rows.map(r => r.id);
    if (ids.length === 0) return { ids: [] };
    const placeholders = ids.map(() => "?").join(",");
    const tx = rawDb.transaction(() => {
      rawDb.prepare(`DELETE FROM reactions WHERE message_id IN (${placeholders})`).run(...ids);
      rawDb.prepare(`DELETE FROM message_mentions WHERE message_id IN (${placeholders})`).run(...ids);
      rawDb.prepare(`UPDATE attachments SET message_id = NULL WHERE message_id IN (${placeholders})`).run(...ids);
      rawDb.prepare(
        `UPDATE messages SET content = '', attachments = NULL, deleted_at = strftime('%s','now') * 1000, deleted_by_user_id = ? WHERE id IN (${placeholders})`
      ).run(deletedByUserId, ...ids);
    });
    tx();
    return { ids };
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

  /* Direct calls (1:1 ringing) */
  createDirectCall(input: { orgId: number; callerId: number; calleeId: number; roomName: string; kind: "voice" | "video" }): DirectCall {
    return db.insert(directCalls).values({
      orgId: input.orgId,
      callerId: input.callerId,
      calleeId: input.calleeId,
      roomName: input.roomName,
      kind: input.kind,
      status: "ringing",
      startedAt: new Date(),
    }).returning().get();
  }
  getDirectCall(id: number): DirectCall | undefined {
    return db.select().from(directCalls).where(eq(directCalls.id, id)).get();
  }
  updateDirectCallStatus(id: number, status: DirectCallStatus, opts?: { answeredAt?: Date; endedAt?: Date }): DirectCall | undefined {
    const patch: Record<string, unknown> = { status };
    if (opts?.answeredAt) patch.answeredAt = opts.answeredAt;
    if (opts?.endedAt) patch.endedAt = opts.endedAt;
    db.update(directCalls).set(patch).where(eq(directCalls.id, id)).run();
    return this.getDirectCall(id);
  }
  listActiveCallsForUser(userId: number): DirectCall[] {
    // Calls this user is involved in that haven't ended yet. Used for
    // surfacing a missed-call indicator and for the /call/:id route to
    // verify membership.
    return db.select().from(directCalls)
      .where(and(
        inArray(directCalls.status, ["ringing", "active"] as DirectCallStatus[]),
        sql`(${directCalls.callerId} = ${userId} OR ${directCalls.calleeId} = ${userId})`,
      ))
      .all();
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
  listInvitesByOrg(orgId: number) {
    return db.select().from(invites).where(eq(invites.orgId, orgId)).orderBy(desc(invites.id)).all();
  }
  deleteInvite(id: number) {
    db.delete(invites).where(eq(invites.id, id)).run();
  }

  /* Attachments */
  createAttachment(input) {
    return db.insert(attachments).values({
      id: input.id,
      uploaderUserId: input.uploaderUserId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      storageKey: input.storageKey,
      thumbnailKey: input.thumbnailKey ?? null,
      messageId: null,
      createdAt: new Date(),
    }).returning().get();
  }
  getAttachment(id: string) { return db.select().from(attachments).where(eq(attachments.id, id)).get(); }
  listAttachmentsForMessages(messageIds: number[]) {
    if (messageIds.length === 0) return [];
    return db.select().from(attachments).where(inArray(attachments.messageId, messageIds)).all();
  }
  linkAttachmentsToMessage(ids: string[], messageId: number, uploaderUserId: number) {
    if (ids.length === 0) return;
    // Only link attachments owned by this uploader and not yet linked
    for (const id of ids) {
      db.update(attachments)
        .set({ messageId })
        .where(and(eq(attachments.id, id), eq(attachments.uploaderUserId, uploaderUserId), isNull(attachments.messageId)))
        .run();
    }
  }
  deleteAttachment(id: string) {
    db.delete(attachments).where(eq(attachments.id, id)).run();
  }

  /* Mentions */
  createMentions(messageId: number, mentions: Array<{ userId: number | null; type: MentionType }>) {
    if (mentions.length === 0) return;
    for (const m of mentions) {
      try {
        db.insert(messageMentions).values({
          messageId,
          mentionedUserId: m.userId,
          type: m.type,
        }).run();
      } catch { /* dup */ }
    }
  }
  listMentionsForMessages(messageIds: number[]) {
    if (messageIds.length === 0) return [];
    return db.select().from(messageMentions).where(inArray(messageMentions.messageId, messageIds)).all();
  }

  /* Threads */
  listReplies(messageId: number) {
    return db.select().from(messages).where(eq(messages.replyToMessageId, messageId)).orderBy(asc(messages.id)).all();
  }
  threadReplyCounts(messageIds: number[]) {
    const map = new Map<number, { count: number; lastAt: number }>();
    if (messageIds.length === 0) return map;
    const rows = db.select({
      parentId: messages.replyToMessageId,
      count: sql<number>`count(*)`,
      lastAt: sql<number>`max(created_at)`,
    }).from(messages)
      .where(inArray(messages.replyToMessageId, messageIds))
      .groupBy(messages.replyToMessageId)
      .all();
    for (const r of rows) {
      if (r.parentId != null) map.set(r.parentId, { count: Number(r.count) || 0, lastAt: Number(r.lastAt) || 0 });
    }
    return map;
  }

  /* Search */
  searchMessages(opts) {
    const { q, channelIds, userId, fromDate, toDate, limit = 50 } = opts;
    if (channelIds.length === 0) return [];
    // Use FTS5 directly via rawDb. Escape double-quotes; wrap each token in quotes for prefix search.
    const cleaned = q.trim().replace(/["]/g, " ").slice(0, 200);
    if (!cleaned) return [];
    const ftsQuery = cleaned.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(" ");
    const placeholders = channelIds.map(() => "?").join(",");
    const params: any[] = [ftsQuery, ...channelIds];
    let sqlStr = `
      SELECT m.* FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ? AND m.channel_id IN (${placeholders})
    `;
    if (userId) { sqlStr += " AND m.user_id = ?"; params.push(userId); }
    if (fromDate) { sqlStr += " AND m.created_at >= ?"; params.push(Math.floor(fromDate.getTime() / 1000)); }
    if (toDate) { sqlStr += " AND m.created_at <= ?"; params.push(Math.floor(toDate.getTime() / 1000)); }
    sqlStr += " ORDER BY m.id DESC LIMIT ?";
    params.push(Math.min(limit, 200));
    const rows = rawDb.prepare(sqlStr).all(...params) as any[];
    // Re-map snake_case to drizzle camelCase
    return rows.map(r => ({
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      content: r.content,
      attachments: r.attachments,
      replyToMessageId: r.reply_to_message_id,
      isPinned: !!r.is_pinned,
      createdAt: new Date(r.created_at * 1000),
      editedAt: r.edited_at ? new Date(r.edited_at * 1000) : null,
    })) as Message[];
  }

  /* Recordings */
  createRecording(input) {
    return db.insert(recordings).values({
      channelId: input.channelId,
      startedByUserId: input.startedByUserId,
      egressId: input.egressId ?? null,
      startedAt: new Date(),
      status: "recording",
    }).returning().get();
  }
  updateRecording(id: number, patch) {
    return db.update(recordings).set(patch).where(eq(recordings.id, id)).returning().get();
  }
  getRecording(id: number) { return db.select().from(recordings).where(eq(recordings.id, id)).get(); }
  listRecordingsForChannel(channelId: number) {
    return db.select().from(recordings).where(eq(recordings.channelId, channelId)).orderBy(desc(recordings.id)).all();
  }
  getActiveRecordingForChannel(channelId: number) {
    return db.select().from(recordings)
      .where(and(eq(recordings.channelId, channelId), eq(recordings.status, "recording")))
      .orderBy(desc(recordings.id)).get();
  }
  findRecordingByEgressId(egressId: string) {
    return db.select().from(recordings).where(eq(recordings.egressId, egressId)).get();
  }

  /* Expo push */
  upsertExpoPushToken(input) {
    const existing = db.select().from(expoPushTokens).where(eq(expoPushTokens.token, input.token)).get();
    if (existing) {
      db.update(expoPushTokens).set({ userId: input.userId, deviceLabel: input.deviceLabel ?? null }).where(eq(expoPushTokens.id, existing.id)).run();
      return { ...existing, userId: input.userId, deviceLabel: input.deviceLabel ?? null } as ExpoPushToken;
    }
    return db.insert(expoPushTokens).values({
      userId: input.userId,
      token: input.token,
      deviceLabel: input.deviceLabel ?? null,
      createdAt: new Date(),
    }).returning().get();
  }
  listExpoTokensForUsers(userIds: number[]) {
    if (userIds.length === 0) return [];
    return db.select().from(expoPushTokens).where(inArray(expoPushTokens.userId, userIds)).all();
  }
  deleteExpoTokenByToken(token: string) {
    db.delete(expoPushTokens).where(eq(expoPushTokens.token, token)).run();
  }

  /* Work Objects */
  createWorkObject(input) {
    const now = new Date();
    return db.insert(workObjects).values({
      orgId: input.orgId,
      // Phase 1.8: jobs are scoped to a company (chat-side `projects` row).
      // Caller passes projectId = active company; fallback NULL only for
      // legacy code paths still running on pre-1.8 client builds.
      projectId: input.projectId ?? null,
      kind: input.kind,
      ref: input.ref,
      title: input.title,
      status: input.status ?? "active",
      description: input.description ?? null,
      parentId: input.parentId ?? null,
      ownerUserId: input.ownerUserId ?? null,
      attributes: input.attributes ?? null,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    }).returning().get();
  }
  getWorkObject(id: number) {
    return db.select().from(workObjects).where(eq(workObjects.id, id)).get();
  }
  getWorkObjectByRef(orgId: number, kind: WorkObjectKind, ref: string) {
    return db.select().from(workObjects).where(and(
      eq(workObjects.orgId, orgId),
      eq(workObjects.kind, kind),
      eq(workObjects.ref, ref),
    )).get();
  }
  // /object can take a bare ref; resolve across kinds within the org. If
  // multiple kinds happen to share the same ref string (unlikely with the
  // (org_id, kind, ref) uniqueness), we return the most-recent.
  findWorkObjectByRefAcrossKinds(orgId: number, ref: string) {
    return db.select().from(workObjects).where(and(
      eq(workObjects.orgId, orgId),
      eq(workObjects.ref, ref),
    )).orderBy(desc(workObjects.updatedAt)).get();
  }
  listWorkObjectsByOrg(orgId: number, opts?: { kind?: WorkObjectKind; status?: WorkObjectStatus; includeClosed?: boolean; limit?: number; projectId?: number }) {
    const filters = [eq(workObjects.orgId, orgId)];
    if (opts?.kind) filters.push(eq(workObjects.kind, opts.kind));
    if (opts?.status) filters.push(eq(workObjects.status, opts.status));
    if (opts?.projectId) filters.push(eq(workObjects.projectId, opts.projectId));
    if (!opts?.includeClosed && !opts?.status) {
      // Default behaviour: hide closed objects unless caller asked for them.
      filters.push(sql`${workObjects.status} != 'closed'`);
    }
    const q = db.select().from(workObjects).where(and(...filters)).orderBy(desc(workObjects.updatedAt));
    if (opts?.limit) return q.limit(opts.limit).all();
    return q.all();
  }
  listWorkObjectsByIds(ids: number[]) {
    if (ids.length === 0) return [];
    return db.select().from(workObjects).where(inArray(workObjects.id, ids)).all();
  }
  updateWorkObject(id: number, patch) {
    const next = { ...patch, updatedAt: new Date() };
    return db.update(workObjects).set(next).where(eq(workObjects.id, id)).returning().get();
  }

  /* Work Object ↔ Channel links */
  linkWorkObjectToChannel(input) {
    const row = {
      workObjectId: input.workObjectId,
      channelId: input.channelId,
      linkType: input.linkType ?? "primary",
      linkedAt: new Date(),
      linkedByUserId: input.linkedByUserId,
    };
    // INSERT OR IGNORE: if already linked, leave the existing row intact.
    rawDb.prepare(`INSERT OR IGNORE INTO work_object_channel_links
      (work_object_id, channel_id, link_type, linked_at, linked_by_user_id)
      VALUES (?, ?, ?, ?, ?)`).run(
      row.workObjectId, row.channelId, row.linkType,
      Math.floor(row.linkedAt.getTime() / 1000), row.linkedByUserId,
    );
    return db.select().from(workObjectChannelLinks).where(and(
      eq(workObjectChannelLinks.workObjectId, input.workObjectId),
      eq(workObjectChannelLinks.channelId, input.channelId),
    )).get()!;
  }
  unlinkWorkObjectFromChannel(workObjectId: number, channelId: number) {
    db.delete(workObjectChannelLinks).where(and(
      eq(workObjectChannelLinks.workObjectId, workObjectId),
      eq(workObjectChannelLinks.channelId, channelId),
    )).run();
  }
  listLinksForChannel(channelId: number) {
    return db.select().from(workObjectChannelLinks).where(eq(workObjectChannelLinks.channelId, channelId)).all();
  }
  listLinksForWorkObject(workObjectId: number) {
    return db.select().from(workObjectChannelLinks).where(eq(workObjectChannelLinks.workObjectId, workObjectId)).all();
  }
  listChannelsForWorkObject(workObjectId: number) {
    const links = this.listLinksForWorkObject(workObjectId);
    if (links.length === 0) return [];
    return db.select().from(channels).where(inArray(channels.id, links.map(l => l.channelId))).all();
  }
  listWorkObjectsForChannel(channelId: number) {
    const links = this.listLinksForChannel(channelId);
    if (links.length === 0) return [];
    return db.select().from(workObjects).where(inArray(workObjects.id, links.map(l => l.workObjectId))).all();
  }

  /* Work Object activity */
  appendWorkObjectActivity(input) {
    return db.insert(workObjectActivity).values({
      workObjectId: input.workObjectId,
      type: input.type,
      actorUserId: input.actorUserId ?? null,
      payload: input.payload ?? null,
      createdAt: new Date(),
    }).returning().get();
  }
  listWorkObjectActivity(workObjectId: number, opts?: { limit?: number }) {
    const q = db.select().from(workObjectActivity)
      .where(eq(workObjectActivity.workObjectId, workObjectId))
      .orderBy(desc(workObjectActivity.createdAt));
    if (opts?.limit) return q.limit(opts.limit).all();
    return q.all();
  }

  /* Admin */
  resetUserPassword(userId: number, newHash: string) {
    db.update(users).set({ passwordHash: newHash }).where(eq(users.id, userId)).run();
  }
  setUserDeactivated(userId: number, deactivated: boolean) {
    return db.update(users).set({ deactivated }).where(eq(users.id, userId)).returning().get();
  }
  deleteUserCascade(userId: number) {
    // Best-effort: delete sessions, push subs, reactions; reassign messages? Keep messages, set null author? Easier: anonymize.
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).run();
    db.delete(expoPushTokens).where(eq(expoPushTokens.userId, userId)).run();
    db.delete(reactions).where(eq(reactions.userId, userId)).run();
    db.delete(projectMembers).where(eq(projectMembers.userId, userId)).run();
    // Soft-delete: mark deactivated, change email to disable login. Don't delete the row because FKs reference it.
    rawDb.prepare(`UPDATE users SET deactivated = 1, email = ? WHERE id = ?`).run(`deleted-${userId}@deleted.local`, userId);
  }
  deleteAllSessionsForUser(userId: number) {
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }
  updateOrg(id: number, patch) {
    return db.update(organizations).set(patch).where(eq(organizations.id, id)).returning().get();
  }
  updateProject(id: number, patch) {
    return db.update(projects).set(patch).where(eq(projects.id, id)).returning().get();
  }
  deleteProjectCascade(projectId: number) {
    // Cascade delete: messages, channels, members, project
    const chs = db.select().from(channels).where(eq(channels.projectId, projectId)).all();
    for (const c of chs) {
      const msgs = db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, c.id)).all();
      for (const m of msgs) {
        db.delete(reactions).where(eq(reactions.messageId, m.id)).run();
        db.delete(messageMentions).where(eq(messageMentions.messageId, m.id)).run();
      }
      db.delete(messages).where(eq(messages.channelId, c.id)).run();
      db.delete(readReceipts).where(eq(readReceipts.channelId, c.id)).run();
      db.delete(recordings).where(eq(recordings.channelId, c.id)).run();
    }
    db.delete(channels).where(eq(channels.projectId, projectId)).run();
    db.delete(projectMembers).where(eq(projectMembers.projectId, projectId)).run();
    db.delete(invites).where(eq(invites.projectId, projectId)).run();
    db.delete(projects).where(eq(projects.id, projectId)).run();
  }
  // Cascade-delete a single channel and all its dependent rows. Optional
  // tables (livekit_rooms, work_object_channel_links) wrapped in safe-run
  // because they may not exist on legacy DBs.
  deleteChannelCascade(channelId: number) {
    const msgs = db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, channelId)).all();
    for (const m of msgs) {
      db.delete(reactions).where(eq(reactions.messageId, m.id)).run();
      db.delete(messageMentions).where(eq(messageMentions.messageId, m.id)).run();
    }
    db.delete(messages).where(eq(messages.channelId, channelId)).run();
    db.delete(readReceipts).where(eq(readReceipts.channelId, channelId)).run();
    db.delete(channelMembers).where(eq(channelMembers.channelId, channelId)).run();
    const safeRun = (sql: string, ...params: any[]) => {
      try { rawDb.prepare(sql).run(...params); } catch (e: any) {
        if (!/no such table/i.test(String(e?.message))) throw e;
      }
    };
    safeRun(`DELETE FROM recordings WHERE channel_id = ?`, channelId);
    safeRun(`DELETE FROM livekit_rooms WHERE channel_id = ?`, channelId);
    safeRun(`DELETE FROM work_object_channel_links WHERE channel_id = ?`, channelId);
    // Phase 1.9.4: meeting notes (FK has ON DELETE CASCADE but be explicit)
    safeRun(`DELETE FROM meeting_notes WHERE channel_id = ?`, channelId);
    // Phase 1.9.5: scheduled calls + their invitees must go first because
    // invitees FK -> scheduled_calls and scheduled_calls FK -> channels.
    try {
      const callIds = rawDb.prepare(`SELECT id FROM scheduled_calls WHERE channel_id = ?`).all(channelId) as Array<{ id: number }>;
      for (const { id } of callIds) {
        safeRun(`DELETE FROM scheduled_call_invitees WHERE scheduled_call_id = ?`, id);
      }
      safeRun(`DELETE FROM scheduled_calls WHERE channel_id = ?`, channelId);
    } catch (e: any) {
      if (!/no such table/i.test(String(e?.message))) throw e;
    }
    db.delete(channels).where(eq(channels.id, channelId)).run();
  }
  // Cascade-delete a job (work_object) and every channel nested under it.
  // Unlinks any non-nested channels that point at this job via
  // work_object_channel_links so they survive the delete.
  deleteWorkObjectCascade(workObjectId: number) {
    const nested = db.select({ id: channels.id }).from(channels).where(eq(channels.workObjectId, workObjectId)).all();
    for (const ch of nested) {
      this.deleteChannelCascade(ch.id);
    }
    const safeRun = (sql: string, ...params: any[]) => {
      try { rawDb.prepare(sql).run(...params); } catch (e: any) {
        if (!/no such table/i.test(String(e?.message))) throw e;
      }
    };
    safeRun(`DELETE FROM work_object_channel_links WHERE work_object_id = ?`, workObjectId);
    safeRun(`DELETE FROM work_objects WHERE id = ?`, workObjectId);
  }
  countChannelsForProject(projectId: number) {
    const r = db.select({ c: sql<number>`count(*)` }).from(channels).where(eq(channels.projectId, projectId)).get();
    return r?.c ?? 0;
  }
  countMembersForProject(projectId: number) {
    const r = db.select({ c: sql<number>`count(*)` }).from(projectMembers).where(eq(projectMembers.projectId, projectId)).get();
    return r?.c ?? 0;
  }
}

export const storage: IStorage = new DatabaseStorage();
