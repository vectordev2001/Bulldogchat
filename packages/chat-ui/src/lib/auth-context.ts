import { createContext, useContext } from "react";

// Shared auth context — the *shape* (and React Context instance) live here in
// @vectordev2001/chat-ui so components moved out of client/src/components can
// call `useAuth()` exactly as before. The actual session bootstrapping
// (login/signup/accept-invite/logout, hitting /api/auth/*) is main-app-only
// and stays in client/src/lib/auth.tsx as `AuthProvider`, which imports this
// same context and provides it. The widget does NOT use this context — it
// manages its own lighter-weight auth via ChatApiClient/cookie session.

export interface PublicUser {
  id: number;
  orgId: number;
  email: string;
  name: string;
  title: string | null;
  avatarUrl: string | null;
  hue: number;
  role: "user" | "manager" | "admin";
  status: string;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface Org {
  id: number;
  name: string;
  slug: string;
  plan: string;
  createdAt: string;
}

export interface AuthState {
  token: string | null;
  user: PublicUser | null;
  org: Org | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (orgName: string, name: string, email: string, password: string) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
