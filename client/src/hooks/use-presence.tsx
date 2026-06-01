// Presence hook (Phase 1.9).
//
// Tracks the current user's presence state (online / away / busy / offline)
// with the following rules:
//   - Manual states (online, busy) are sticky. The user picks them from the
//     top-bar menu and they stay until the user picks something else.
//   - 'away' is automatic: if there's been no keyboard/mouse/touch input for
//     5 minutes, we flip from 'online' to 'away'. As soon as the user moves
//     again, we restore the last manual state (defaulting to 'online').
//   - 'offline' is fired on pagehide and via beacon so we don't leave a stale
//     green dot when someone closes the tab.
//   - Idle detection is paused while presence is 'busy' (DND) — the user
//     explicitly said don't bother them, don't downgrade them to yellow.
//
// State is reported to the server via POST /api/presence and fanned out via
// SSE 'presence:change' to every client in the org.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { ApiUser, UserPresence } from "@/types/api";

const IDLE_MS = 5 * 60 * 1000; // 5 minutes
const STORAGE_KEY = "bulldog.presence.manual";

interface PresenceContextValue {
  presence: UserPresence;
  manualPresence: UserPresence; // last sticky pick (excludes auto-away)
  setManualPresence: (p: UserPresence) => void;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  // Read the last manual state from localStorage so a reload doesn't reset
  // someone who was 'busy' back to 'online'.
  const [manual, setManual] = useState<UserPresence>(() => {
    if (typeof window === "undefined") return "online";
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "online" || v === "busy" ? v : "online";
  });
  const [auto, setAuto] = useState<UserPresence | null>(null); // 'away' or null

  const presence: UserPresence = auto ?? manual;

  // Push every effective presence change to the server. Server fans out via SSE.
  const lastSentRef = useRef<UserPresence | null>(null);
  useEffect(() => {
    if (!user) return;
    if (lastSentRef.current === presence) return;
    lastSentRef.current = presence;
    apiRequest("POST", "/api/presence", { presence }).catch(() => {
      // Non-fatal — we'll retry on the next change or window focus.
      lastSentRef.current = null;
    });
  }, [presence, user]);

  // Idle detector.
  useEffect(() => {
    if (!user) return;
    // Don't auto-flip while user is explicitly Busy — that's DND, leave it.
    if (manual === "busy") {
      setAuto(null);
      return;
    }
    let timer: number | null = null;
    const bump = () => {
      if (auto === "away") setAuto(null);
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setAuto("away"), IDLE_MS);
    };
    const events = ["mousemove", "keydown", "touchstart", "scroll", "focus"] as const;
    for (const ev of events) window.addEventListener(ev, bump, { passive: true });
    bump();
    return () => {
      if (timer != null) window.clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, bump);
    };
  }, [user, manual, auto]);

  // Mark offline on tab close / page hide. Use sendBeacon so the request
  // survives unload. Use a custom path the server treats as presence=offline.
  useEffect(() => {
    if (!user) return;
    const onHide = () => {
      try {
        const blob = new Blob([JSON.stringify({ presence: "offline" })], { type: "application/json" });
        // Beacon ignores auth headers; the cookie carries the JWT for SSE
        // and same-origin POSTs, so this works in the deployed app.
        navigator.sendBeacon?.("/api/presence", blob);
      } catch { /* ignore */ }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [user]);

  // When the tab becomes visible again after being hidden, immediately
  // re-assert our current state so a long-idle session reappears as online.
  useEffect(() => {
    if (!user) return;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        lastSentRef.current = null; // force a resend
        // No state change needed — the effect above will push `presence` again.
        setAuto((prev) => (prev === "away" ? null : prev));
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [user]);

  const setManualPresence = useCallback((p: UserPresence) => {
    // We only persist sticky states (online / busy / offline). 'away' is
    // always automatic — picking it manually doesn't make sense.
    const sticky: UserPresence = p === "away" ? "online" : p;
    setManual(sticky);
    setAuto(null);
    try { window.localStorage.setItem(STORAGE_KEY, sticky); } catch { /* ignore */ }
  }, []);

  // Subscribe to org-wide presence:change SSE events so the member list dots
  // update live without polling. We patch the cached /api/org/members list.
  useEffect(() => {
    if (!user) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { userId: number; presence: UserPresence } | undefined;
      if (!detail) return;
      queryClient.setQueryData<ApiUser[] | undefined>(["/api/org/members"], (prev) => {
        if (!prev) return prev;
        return prev.map((m) => (m.id === detail.userId ? { ...m, presence: detail.presence } : m));
      });
    };
    window.addEventListener("sse:presence:change", handler as EventListener);
    return () => window.removeEventListener("sse:presence:change", handler as EventListener);
  }, [user]);

  const value = useMemo<PresenceContextValue>(
    () => ({ presence, manualPresence: manual, setManualPresence }),
    [presence, manual, setManualPresence],
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function usePresence(): PresenceContextValue {
  const ctx = useContext(PresenceContext);
  if (!ctx) {
    // Safe fallback so consumers that render before the provider don't crash.
    return { presence: "online", manualPresence: "online", setManualPresence: () => {} };
  }
  return ctx;
}
