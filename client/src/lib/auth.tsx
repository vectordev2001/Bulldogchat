import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { apiRequest, setAuthToken as setQCToken, queryClient } from "./queryClient";
import { publishAuthJwtToNative, clearAuthJwtOnNative } from "./push-bridge";

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

interface AuthState {
  token: string | null;
  user: PublicUser | null;
  org: Org | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (orgName: string, name: string, email: string, password: string) => Promise<void>;
  acceptInvite: (token: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [loading, setLoading] = useState(true);

  // On first mount, attempt /api/auth/me using cookie auth (no token in state yet)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest<{ user: PublicUser; org: Org }>("GET", "/api/auth/me");
        if (cancelled) return;
        setUser(res.user);
        setOrg(res.org);
        // Session restored on boot — publish central JWT to native so APNs
        // registration can complete without waiting for another login.
        void publishAuthJwtToNative("chat");
      } catch {
        // not authenticated — fine
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const applySession = useCallback((tok: string, u: PublicUser, o: Org) => {
    setQCToken(tok);
    setToken(tok);
    setUser(u);
    setOrg(o);
    // Publish the central Bulldog auth JWT to the native iOS shell so
    // Swift can register this device against auth.bulldogops.com/api/devices.
    // No-op in the browser. See lib/push-bridge.ts.
    void publishAuthJwtToNative("chat");
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await apiRequest<{ token: string; user: PublicUser; org: Org }>("POST", "/api/auth/login", { email, password });
    applySession(r.token, r.user, r.org);
    queryClient.clear();
  }, [applySession]);

  const signup = useCallback(async (orgName: string, name: string, email: string, password: string) => {
    const r = await apiRequest<{ token: string; user: PublicUser; org: Org }>("POST", "/api/auth/signup", { orgName, name, email, password });
    applySession(r.token, r.user, r.org);
    queryClient.clear();
  }, [applySession]);

  const acceptInvite = useCallback(async (inviteToken: string, name: string, password: string) => {
    const r = await apiRequest<{ token: string; user: PublicUser; org: Org }>("POST", "/api/auth/accept-invite", { token: inviteToken, name, password });
    applySession(r.token, r.user, r.org);
    queryClient.clear();
  }, [applySession]);

  const logout = useCallback(async () => {
    try { await apiRequest("POST", "/api/auth/logout"); } catch { /* ignore */ }
    setQCToken(null);
    setToken(null);
    setUser(null);
    setOrg(null);
    queryClient.clear();
    // Tell native to drop the stored JWT so we won't retry APNs registration.
    clearAuthJwtOnNative("chat");
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, org, loading, login, signup, acceptInvite, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
