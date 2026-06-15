import { useEffect, useRef, useState } from "react";
import { getAuthToken } from "@/lib/queryClient";

export type SSEStatus = "connecting" | "open" | "closed";

interface Handlers {
  onMessageNew?: (data: any) => void;
  onMessageUpdate?: (data: any) => void;
  onMessageDelete?: (data: any) => void;
  onReactionChange?: (data: any) => void;
  onChannelDelete?: (data: any) => void;
  // Fired after the EventSource is (re)opened following a visibility-driven
  // reconnect. Lets the consumer refetch anything that may have changed while
  // the stream was down (e.g. invalidate the active channel's messages so a
  // clear that happened while backgrounded shows up).
  onReopen?: () => void;
}

export function useSSE(enabled: boolean, handlers: Handlers): SSEStatus {
  const [status, setStatus] = useState<SSEStatus>("closed");
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }

    let es: EventSource | null = null;
    // Distinguishes the very first connect from a visibility-driven reconnect,
    // so we only fire onReopen() on actual reconnects (not initial mount).
    let reconnected = false;

    const open = () => {
      const token = getAuthToken();
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
      const url = `/api/events${tokenParam}`;
      try {
        es = new EventSource(url, { withCredentials: true });
      } catch {
        setStatus("closed");
        return;
      }

      setStatus("connecting");
      es.addEventListener("open", () => {
        setStatus("open");
        if (reconnected) {
          try { handlersRef.current.onReopen?.(); } catch {}
        }
      });
      es.addEventListener("error", () => setStatus("closed"));
      es.addEventListener("hello", () => setStatus("open"));
      es.addEventListener("ping", () => {}); // heartbeat

      es.addEventListener("message:new", (e: MessageEvent) => {
        try { handlersRef.current.onMessageNew?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("message:update", (e: MessageEvent) => {
        try { handlersRef.current.onMessageUpdate?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("message:delete", (e: MessageEvent) => {
        try { handlersRef.current.onMessageDelete?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("reaction:change", (e: MessageEvent) => {
        try { handlersRef.current.onReactionChange?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("channel:delete", (e: MessageEvent) => {
        try { handlersRef.current.onChannelDelete?.(JSON.parse(e.data)); } catch {}
      });

      // Presence broadcasts (Phase 1.9). Re-emit as a window CustomEvent so any
      // component can subscribe without threading a handler prop through the
      // SSE plumbing. PresenceProvider listens for this and patches the cached
      // /api/org/members list so the dot updates everywhere live.
      es.addEventListener("presence:change", (e: MessageEvent) => {
        try {
          const detail = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("sse:presence:change", { detail }));
        } catch {}
      });
    };

    open();

    // iOS WebKit hardening: when a WKWebView is backgrounded it can silently
    // drop the SSE connection WITHOUT firing the `error` event that normally
    // triggers EventSource's built-in auto-reconnect. The result is a zombie
    // stream that never recovers — exactly how the app ends up stale. On
    // returning to the foreground (visibilitychange → visible) we proactively
    // tear the EventSource down and reopen it, then fire onReopen() so the
    // consumer can refetch anything missed while we were dark.
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      reconnected = true;
      es?.close();
      open();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      es?.close();
      setStatus("closed");
    };
  }, [enabled]);

  return status;
}
