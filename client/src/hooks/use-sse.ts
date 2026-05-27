import { useEffect, useRef, useState } from "react";
import { getAuthToken } from "@/lib/queryClient";

export type SSEStatus = "connecting" | "open" | "closed";

interface Handlers {
  onMessageNew?: (data: any) => void;
  onMessageUpdate?: (data: any) => void;
  onMessageDelete?: (data: any) => void;
  onReactionChange?: (data: any) => void;
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
    const token = getAuthToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const url = `/api/events${tokenParam}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      setStatus("closed");
      return;
    }

    setStatus("connecting");
    es.addEventListener("open", () => setStatus("open"));
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

    return () => {
      es?.close();
      setStatus("closed");
    };
  }, [enabled]);

  return status;
}
