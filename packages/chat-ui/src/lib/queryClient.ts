import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Mutable so ChatApp (used cross-origin by the widget) can point requests at
// a different host via setApiBase(apiBaseUrl). Main-app behavior is
// unchanged: nothing calls setApiBase there, so every request still resolves
// against the same "" (same-origin, relative /api/... requests) it always
// has. Use getApiBase() in place of the old exported API_BASE constant.
let apiBase = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
export function setApiBase(url: string) { apiBase = url.replace(/\/+$/, ""); }
export function getApiBase(): string { return apiBase; }
/** @deprecated use getApiBase() — kept only so any stray external import doesn't hard-crash. */
export const API_BASE = "";

// In-memory token store. Auth provider sets/clears.
let authToken: string | null = null;
export function setAuthToken(t: string | null) { authToken = t; }
export function getAuthToken(): string | null { return authToken; }

export function authHeaders(): Record<string, string> {
  if (!authToken) return {};
  return { Authorization: `Bearer ${authToken}` };
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.clone().json();
    } catch {
      body = null;
    }
    const text = body?.message ?? (await res.text()) ?? res.statusText;
    const err = new Error(`${res.status}: ${text}`) as Error & { status?: number; body?: any };
    err.status = res.status;
    err.body = body;
    throw err;
  }
}

export async function apiRequest<T = unknown>(
  method: string,
  url: string,
  data?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (data !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${getApiBase()}${url}`, {
    method,
    headers,
    body: data !== undefined ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
  await throwIfResNotOk(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

// Titled Chats (Phase 2.5) — always creates a NEW DM channel (never
// find-or-create), distinct from the plain "New DM" picker.
export async function apiCreateTitledDm<T = unknown>(input: { title: string; memberIds: number[] }): Promise<T> {
  return apiRequest<T>("POST", "/api/dms/titled", input);
}

// Titled Chats (Phase 2.5) — set (string) or clear (null) a DM's custom
// title. Used by both the "New titled chat" create flow follow-up renames
// and the DM row's "Rename..." context-menu action.
export async function apiRenameDm<T = unknown>(id: number, title: string | null): Promise<T> {
  return apiRequest<T>("PATCH", `/api/dms/${id}`, { title });
}

export async function apiUpload<T = unknown>(
  url: string,
  formData: FormData,
): Promise<T> {
  const res = await fetch(`${getApiBase()}${url}`, {
    method: "POST",
    headers: { ...authHeaders() },
    body: formData,
    credentials: "include",
  });
  await throwIfResNotOk(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: { on401: UnauthorizedBehavior }) => QueryFunction<T> =
  ({ on401 }) =>
  async ({ queryKey }) => {
    // Build URL: join string parts of queryKey with "/", drop trailing options
    const parts = queryKey.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
    const path = parts.join("/");
    const res = await fetch(`${getApiBase()}${path}`, {
      headers: { ...authHeaders() },
      credentials: "include",
    });
    if (on401 === "returnNull" && res.status === 401) return null as any;
    await throwIfResNotOk(res);
    if (res.status === 204) return null as any;
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      // iOS WebView staleness fix: when the app returns to the foreground the
      // WebView often missed SSE events while backgrounded. Refetching on focus
      // with a short stale window pulls fresh data (e.g. a channel that was
      // cleared while the app was asleep) instead of showing the stale cache.
      refetchOnWindowFocus: true,
      staleTime: 5_000,
      retry: false,
    },
    mutations: { retry: false },
  },
});
