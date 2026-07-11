import { useCallback, useEffect, useState } from "react";

// ── useBrowserNotifications ──────────────────────────────────────────────────
// Thin wrapper over the Web Notifications API. Keeps a reactive copy of the
// current permission so the widget can show / hide the "Enable notifications"
// pill, and exposes imperative requestPermission() + notify() methods.
//
// The decision of WHETHER to fire (widget closed, or message in a non-active
// conversation, and the user preference is on) is made by the caller — this
// hook only owns the browser-permission mechanics so the SSE handler stays the
// single source of truth for the "should I alert?" logic (mirroring the
// existing incrementUnread rule).

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

export interface NotifyOptions {
  title: string;
  body?: string;
  /** Dedup key — pass the conversation id so re-notifications about the same
   * conversation replace the previous one instead of stacking. */
  tag?: string;
  onClick?: () => void;
}

function readPermission(): NotificationPermissionState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotificationPermissionState;
}

export function useBrowserNotifications() {
  const [permission, setPermission] = useState<NotificationPermissionState>(() => readPermission());

  // Re-sync on mount in case permission changed since the store was created
  // (e.g. the user granted it in another tab).
  useEffect(() => {
    setPermission(readPermission());
  }, []);

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return "unsupported" as const;
    try {
      const result = await Notification.requestPermission();
      setPermission(result as NotificationPermissionState);
      return result;
    } catch {
      // Older Safari uses a callback signature; ignore and keep current state.
      return readPermission();
    }
  }, []);

  const notify = useCallback((opts: NotifyOptions) => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const n = new Notification(opts.title, {
        body: opts.body,
        tag: opts.tag,
        icon: "/favicon.ico",
      });
      n.onclick = () => {
        window.focus();
        opts.onClick?.();
        n.close();
      };
    } catch {
      /* Notifications are best-effort — never let a failure break message flow. */
    }
  }, []);

  return { permission, requestPermission, notify };
}
