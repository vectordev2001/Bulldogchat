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

  me(): Promise<ApiUser> {
    return this.request("GET", "/api/auth/me");
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

  // Auth-check helper: widgets mount immediately on app load, often before
  // the host app knows whether the user's session is valid. Consumers can
  // use this to decide whether to render the pill at all (spec doesn't
  // mandate hiding when logged out, but a 401 here means /api/events will
  // also fail — this lets BulldogChatWidget fail soft instead of retrying
  // forever).
  async isAuthenticated(): Promise<boolean> {
    try {
      await this.me();
      return true;
    } catch {
      return false;
    }
  }
}
