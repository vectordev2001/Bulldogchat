import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// In-memory token store. Auth provider sets/clears.
let authToken: string | null = null;
export function setAuthToken(t: string | null) { authToken = t; }
export function getAuthToken(): string | null { return authToken; }

function authHeaders(): Record<string, string> {
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
  const res = await fetch(`${API_BASE}${url}`, {
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

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: { on401: UnauthorizedBehavior }) => QueryFunction<T> =
  ({ on401 }) =>
  async ({ queryKey }) => {
    // Build URL: join string parts of queryKey with "/", drop trailing options
    const parts = queryKey.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
    const path = parts.join("/");
    const res = await fetch(`${API_BASE}${path}`, {
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
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: false,
    },
    mutations: { retry: false },
  },
});
