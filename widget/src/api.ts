// Thin fetch wrapper against the Chat app's API, cross-origin. `credentials:
// "include"` sends the shared bulldog-auth JWT cookie (Domain=.bulldogops.com)
// so a logged-in Contracts/Ops user is automatically authenticated on Chat's
// API without a separate login step. Chat's CORS config
// (server/index.ts, CORS_ALLOWED_ORIGINS) must include the calling origin
// AND set Access-Control-Allow-Credentials: true for this to work.

/** Presence state as stored on the user (Chat app Phase 1.9). Anything else
 * (or absent) is treated as "offline" for the sidebar dot. */
export type ApiPresence = "online" | "away" | "busy" | "offline";

export interface ApiUser {
  id: number;
  name: string;
  email: string;
  hue?: number;
  presence?: ApiPresence | string;
  title?: string | null;
  deactivated?: boolean;
  role?: string;
}

export interface ApiChannel {
  id: number;
  projectId: number;
  name: string;
  type: string;
  topic: string | null;
  title?: string | null;
  createdAt: string;
}

export interface ApiDmChannel extends ApiChannel {
  memberIds: number[];
}

export interface ApiProject {
  id: number;
  name: string;
  authCompanyId?: string | null;
}

/** A single file attached to a message. Mirrors the server serialization in
 * server/routes.ts (the `attachmentsList` field on the messages response). */
export interface ApiAttachment {
  id: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  thumbnailUrl?: string | null;
  createdAt: string;
}

/** A resolved mention entry. `userId` is null for broadcast mentions
 * (@here / @everyone); `type` is "user" | "here" | "everyone". */
export interface ApiMention {
  userId: number | null;
  type: string;
}

/** A grouped reaction on a message. Mirrors the server serialization
 * (server/routes.ts buildWireMessage): one entry per distinct emoji, with the
 * total `count` and the `userIds` who reacted (used to render who-reacted
 * tooltips and to detect the current user's own reaction). */
export interface ApiReaction {
  emoji: string;
  count: number;
  userIds: number[];
}

export interface ApiMessage {
  id: number;
  channelId: number;
  userId: number;
  content: string;
  attachments?: string | null;
  attachmentsList?: ApiAttachment[];
  mentions?: ApiMention[];
  reactions?: ApiReaction[];
  /** Number of thread replies to this message (0 when it has none). */
  replyCount?: number;
  /** ISO timestamp of the most recent reply, or null when there are none. */
  lastReplyAt?: string | null;
  /** Set on reply messages; the id of the parent they belong to. Replies are
   * filtered out of the main channel timeline server-side. */
  replyToMessageId?: number | null;
  createdAt: string;
  deletedAt?: string | null;
}

export interface ApiCallSession {
  callId: number;
  roomName: string;
  token: string;
  ws_url: string;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ChatApiClient {
  constructor(private baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        if (data?.message) message = data.message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async me(): Promise<ApiUser> {
    // Server returns { user: ApiUser, org: ... } — unwrap the user field.
    const resp = await this.request<{ user: ApiUser } | ApiUser>("GET", "/api/auth/me");
    return (resp as { user: ApiUser }).user ?? (resp as ApiUser);
  }

  orgMembers(): Promise<ApiUser[]> {
    return this.request("GET", "/api/org/members");
  }

  listDms(): Promise<ApiDmChannel[]> {
    return this.request("GET", "/api/dms");
  }

  getChannel(id: number): Promise<ApiChannel> {
    return this.request("GET", `/api/channels/${id}`);
  }

  listMessages(channelId: number, before?: number, limit?: number): Promise<ApiMessage[]> {
    const params = new URLSearchParams();
    if (before) params.set("before", String(before));
    if (limit) params.set("limit", String(limit));
    const q = params.toString();
    return this.request("GET", `/api/channels/${channelId}/messages${q ? `?${q}` : ""}`);
  }

  // ── Threads ────────────────────────────────────────────────────────────────

  /** Replies to a parent message, oldest first. Backend: GET
   * /api/messages/:id/replies (server/routes-v2.ts). */
  listThreadReplies(messageId: number): Promise<ApiMessage[]> {
    return this.request("GET", `/api/messages/${messageId}/replies`);
  }

  // ── Reactions ──────────────────────────────────────────────────────────────

  /** Add the caller's reaction. Returns the updated wire message (with the new
   * grouped `reactions`). Backend: POST /api/messages/:id/reactions {emoji}. */
  addReaction(messageId: number, emoji: string): Promise<ApiMessage> {
    return this.request("POST", `/api/messages/${messageId}/reactions`, { emoji });
  }

  /** Remove the caller's reaction. The emoji is path-encoded. Backend:
   * DELETE /api/messages/:id/reactions/:emoji. */
  removeReaction(messageId: number, emoji: string): Promise<ApiMessage> {
    return this.request("DELETE", `/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }

  // ── Read receipts ──────────────────────────────────────────────────────────

  /** Advance the caller's read receipt for a channel. When `messageId` is
   * omitted the server advances to the channel tip. Backend:
   * POST /api/channels/:id/read (receipts only ever move forward). */
  markChannelRead(channelId: number, messageId?: number): Promise<{ ok: boolean; messageId: number }> {
    return this.request("POST", `/api/channels/${channelId}/read`, messageId ? { messageId } : {});
  }

  // ── Group channels ─────────────────────────────────────────────────────────

  listProjects(): Promise<ApiProject[]> {
    return this.request("GET", "/api/projects");
  }

  listProjectChannels(projectId: number): Promise<ApiChannel[]> {
    return this.request("GET", `/api/projects/${projectId}/channels`);
  }

  /** Post a message. Pass `replyToMessageId` to make it a thread reply — the
   * server threads it under the parent and keeps it out of the main timeline. */
  sendMessage(channelId: number, content: string, replyToMessageId?: number): Promise<ApiMessage> {
    const body = replyToMessageId ? { content, replyToMessageId } : { content };
    return this.request("POST", `/api/channels/${channelId}/messages`, body);
  }

  createDm(memberIds: number[]): Promise<ApiDmChannel & { created: boolean }> {
    return this.request("POST", "/api/dms", { memberIds });
  }

  createTitledDm(title: string, memberIds: number[]): Promise<ApiDmChannel & { created: boolean }> {
    return this.request("POST", "/api/dms/titled", { title, memberIds });
  }

  renameDm(id: number, title: string | null): Promise<ApiDmChannel> {
    return this.request("PATCH", `/api/dms/${id}`, { title });
  }

  // ── Calling ──────────────────────────────────────────────────────────────

  /** Start a 1:1 call. Returns a LiveKit token + room for the caller. */
  startCall(calleeId: number, kind: "video" | "voice" = "video"): Promise<ApiCallSession> {
    return this.request("POST", "/api/calls/start", { calleeId, kind });
  }

  /** Accept an incoming call — get a token to join the already-created room. */
  acceptCall(callId: number): Promise<{ roomName: string; token: string; ws_url: string }> {
    return this.request("POST", `/api/calls/${callId}/accept`);
  }

  /** End / decline a call. */
  endCall(callId: number): Promise<void> {
    return this.request("POST", `/api/calls/${callId}/end`);
  }

  /**
   * Join an existing call by ID — used by the widget when the host page URL
   * contains ?joinCall=<callId>. Calls accept on behalf of the current user
   * and returns a fresh LiveKit token + room name.
   */
  joinCall(callId: number): Promise<{ roomName: string; token: string; ws_url: string }> {
    return this.request("POST", `/api/calls/${callId}/accept`);
  }

  // ── Auth-check ────────────────────────────────────────────────────────────

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.me();
      return true;
    } catch {
      return false;
    }
  }
}
