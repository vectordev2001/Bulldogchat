import { useEffect, useRef, useState } from "react";

// Cross-origin adaptation of client/src/hooks/use-sse.ts from the main Chat
// app. Same shape and same iOS WebKit visibility-driven reconnect hardening
// (see comment below), but points at an absolute `apiBaseUrl` instead of a
// same-origin relative path, since the widget runs on contracts.bulldogops.com
// / ops.bulldogops.com while the stream lives on chat.bulldogops.com.
// EventSource with `withCredentials: true` sends the shared bulldog-auth
// cookie cross-origin as long as Chat's CORS config allows the calling
// origin with credentials (see server/index.ts CORS_ALLOWED_ORIGINS).

export type SSEStatus = "connecting" | "open" | "closed";

interface Handlers {
  onMessageNew?: (data: any) => void;
  onMessageUpdate?: (data: any) => void;
  onMessageDelete?: (data: any) => void;
  onDmUpdated?: (data: any) => void;
  onDmCreated?: (data: any) => void;
  onChannelDelete?: (data: any) => void;
  onReopen?: () => void;
  /** Fired when another user initiates a call to the current user. */
  onCallIncoming?: (data: any) => void;
}

export function useMiniChatSse(apiBaseUrl: string, enabled: boolean, handlers: Handlers): SSEStatus {
  const [status, setStatus] = useState<SSEStatus>("closed");
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }

    let es: EventSource | null = null;
    let reconnected = false;

    const open = () => {
      const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/events`;
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
      es.addEventListener("ping", () => {});

      es.addEventListener("message:new", (e: MessageEvent) => {
        try { handlersRef.current.onMessageNew?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("message:update", (e: MessageEvent) => {
        try { handlersRef.current.onMessageUpdate?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("message:delete", (e: MessageEvent) => {
        try { handlersRef.current.onMessageDelete?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("dm:updated", (e: MessageEvent) => {
        try { handlersRef.current.onDmUpdated?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("dm:created", (e: MessageEvent) => {
        try { handlersRef.current.onDmCreated?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("channel:delete", (e: MessageEvent) => {
        try { handlersRef.current.onChannelDelete?.(JSON.parse(e.data)); } catch {}
      });
      // Incoming call from another user — widget shows accept/decline banner.
      es.addEventListener("call:incoming", (e: MessageEvent) => {
        try { handlersRef.current.onCallIncoming?.(JSON.parse(e.data)); } catch {}
      });
    };

    open();

    // Same iOS WebKit hardening as the main app's use-sse.ts: a backgrounded
    // WKWebView can silently drop the SSE connection without firing `error`,
    // leaving a zombie stream. On regaining visibility we tear down and
    // reopen, then fire onReopen() so the consumer can refetch anything
    // missed while dark.
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
  }, [enabled, apiBaseUrl]);

  return status;
}
