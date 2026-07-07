/**
 * use-unread
 *
 * Powers the star badge on the company/project rail in the left sidebar. The
 * server exposes `GET /api/me/unread` which aggregates per-channel unread
 * chat counts + missed-call counts and rolls them up per company (project).
 *
 * Strategy: fetch once on mount, then refetch (debounced ~400ms) whenever a
 * signal arrives that could plausibly change the map:
 *
 *   - `unread:refresh` window event (fired by Home.tsx's SSE onMessageNew).
 *     Debounce coalesces a burst of messages into one HTTP call.
 *   - `unread:missed-call` window event (fired by CallContext when a
 *     ring times out).
 *   - Focus-return: coming back to the tab does a soft refresh.
 *   - 5-minute background timer as a safety net.
 *
 * We deliberately avoid client-side accounting: the server's SQL rollup is
 * the source of truth, and refetching keeps the code trivially simple.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

export interface ProjectUnread {
  chat: number;
  calls: number;
  hasUnread: boolean;
}

interface UnreadPayload {
  byChannelId: Record<number, number>;
  byProjectId: Record<number, ProjectUnread>;
  updatedAt: number;
}

interface Options {
  enabled: boolean;
}

export function useUnread({ enabled }: Options) {
  const [byChannelId, setByChannelId] = useState<Record<number, number>>({});
  const [byProjectId, setByProjectId] = useState<Record<number, ProjectUnread>>({});

  // Debounce handle for coalesced refetches.
  const debounceRef = useRef<number | null>(null);

  const doFetch = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await apiRequest<UnreadPayload>("GET", "/api/me/unread");
      setByChannelId(data.byChannelId ?? {});
      setByProjectId(data.byProjectId ?? {});
    } catch {
      // Silent: sidebar star just won't refresh until the next event.
    }
  }, [enabled]);

  const scheduleRefetch = useCallback(() => {
    if (!enabled) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      doFetch();
    }, 400);
  }, [enabled, doFetch]);

  // Initial fetch + background safety net.
  useEffect(() => {
    if (!enabled) return;
    doFetch();
    const id = window.setInterval(doFetch, 5 * 60_000);
    return () => window.clearInterval(id);
  }, [enabled, doFetch]);

  // Refetch triggers.
  useEffect(() => {
    if (!enabled) return;
    const onRefresh = () => scheduleRefetch();
    const onVis = () => { if (document.visibilityState === "visible") scheduleRefetch(); };
    window.addEventListener("unread:refresh", onRefresh);
    window.addEventListener("unread:missed-call", onRefresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("unread:refresh", onRefresh);
      window.removeEventListener("unread:missed-call", onRefresh);
      document.removeEventListener("visibilitychange", onVis);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [enabled, scheduleRefetch]);

  /**
   * Mark a channel read on the server and optimistically clear its counts
   * locally. Called when the user opens/views a channel.
   */
  const markChannelRead = useCallback(async (channelId: number) => {
    // Optimistic: drop this channel's chat count and subtract from the
    // rollup. `hasUnread` is recomputed from remaining chat+calls.
    let dropped = 0;
    setByChannelId(prev => {
      dropped = prev[channelId] ?? 0;
      if (!dropped) return prev;
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
    // We don't know the parent projectId from the channelId alone here
    // without a lookup map. Rather than plumb one through, we just fire a
    // debounced refetch after the persist call \u2014 the server has the
    // authoritative rollup.
    try {
      await apiRequest("POST", `/api/channels/${channelId}/read`, {});
    } catch {
      /* healed by refetch */
    }
    scheduleRefetch();
  }, [scheduleRefetch]);

  /**
   * Clear every unread signal (chat backlog + missed calls) for one
   * company. Optimistically zeroes the local counts so the sidebar star
   * disappears immediately, then persists to the server and refetches to
   * pick up any changes we didn't compute locally.
   */
  const markProjectRead = useCallback(async (projectId: number) => {
    setByProjectId(prev => {
      const existing = prev[projectId];
      if (!existing) return prev;
      return { ...prev, [projectId]: { chat: 0, calls: 0, hasUnread: false } };
    });
    try {
      await apiRequest("POST", `/api/projects/${projectId}/read`, {});
    } catch {
      /* healed by refetch */
    }
    scheduleRefetch();
  }, [scheduleRefetch]);

  return { byChannelId, byProjectId, markChannelRead, markProjectRead, refetch: doFetch };
}
