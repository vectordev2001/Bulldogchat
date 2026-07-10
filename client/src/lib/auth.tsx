import { ReactNode, useCallback, useEffect, useState } from "react";
import { apiRequest, setAuthToken as setQCToken, queryClient } from "@vectordev2001/chat-ui/lib/queryClient";
import {
  AuthContext,
  useAuth,
  type AuthState,
  type PublicUser,
  type Org,
} from "@vectordev2001/chat-ui/lib/auth-context";

// Main-app-only session bootstrapping. The React Context instance + useAuth
// hook themselves live in @vectordev2001/chat-ui/lib/auth-context so that
// components moved to packages/chat-ui (UnifiedHeader, ProjectRail,
// CallOverlays, etc.) can keep calling useAuth() unchanged. This file wires
// up the actual login/signup/accept-invite/logout network calls and provides
// the context value — the widget does NOT use this; it has its own
// lighter-weight auth via ChatApiClient's cookie-based session.

export type { PublicUser, Org };
export { useAuth };

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
  }, []);

  const value: AuthState = { token, user, org, loading, login, signup, acceptInvite, logout };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
