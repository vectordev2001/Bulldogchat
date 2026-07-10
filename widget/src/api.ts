// Thin fetch wrapper against the Chat app's API, cross-origin. `credentials:
// "include"` sends the shared bulldog-auth JWT cookie (Domain=.bulldogops.com)
// so a logged-in Contracts/Ops user is automatically authenticated on Chat's
// API without a separate login step. Chat's CORS config
// (server/index.ts, CORS_ALLOWED_ORIGINS) must include the calling origin
// AND set Access-Control-Allow-Credentials: true for this to work.

export interface ApiUser {
  id: number;
  name: string;
  email: string;
  hue?: number;
  presence?: string;
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

export interface ApiMessage {
  id: number;
  channelId: number;
  userId: number;
  content: string;
  attachments?: string | null;
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

  listMessages(channelId: number, before?: number): Promise<ApiMessage[]> {
    const q = before ? `?before=${before}` : "";
    return this.request("GET", `/api/channels/${channelId}/messages${q}`);
  }

  sendMessage(channelId: number, content: string): Promise<ApiMessage> {
    return this.request("POST", `/api/channels/${channelId}/messages`, { content });
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

  // ── Jobs (work objects) — used by the `bulldog:widget:openJob` bus ────────

  /** Fetch a single job/work-object by id. Throws ApiError(404) if missing. */
  getWorkObject(workObjectId: number): Promise<{ id: number; projectId: number | null; title: string }> {
    return this.request("GET", `/api/work-objects/${workObjectId}`);
  }

  /** Channels linked to a job/work-object (server/routes-work-objects.ts). */
  getWorkObjectChannels(workObjectId: number): Promise<ApiChannel[]> {
    return this.request("GET", `/api/work-objects/${workObjectId}/channels`);
  }

  /**
   * Create a job/work-object so the widget's "no channels yet" prompt has
   * somewhere to attach the new #general channel. `ref` is the host app's
   * job number (unique per org+kind server-side — see
   * shared/schema.ts workObjectCreateSchema); `kind` defaults to
   * "work_project", the closest general-purpose kind for an
   * externally-sourced job record. `projectId` (the Bulldog "company")
   * is sent as a query param per the server route's contract.
   */
  createWorkObject(input: { title: string; ref: string; projectId?: number; kind?: "job_site" | "work_project" | "change_order" | "safety_incident" }): Promise<{ id: number; projectId: number | null }> {
    const { projectId, ...body } = input;
    const q = projectId ? `?projectId=${projectId}` : "";
    return this.request("POST", `/api/work-objects${q}`, { kind: "work_project", ...body });
  }

  /**
   * Create a channel under a project, optionally nesting it under a job via
   * workObjectId (server/routes.ts, POST /api/projects/:id/channels).
   */
  createChannel(projectId: number, input: { name: string; type?: "text" | "voice"; workObjectId?: number }): Promise<ApiChannel> {
    return this.request("POST", `/api/projects/${projectId}/channels`, input);
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
