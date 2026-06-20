import { useEffect, useState } from "react";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type State =
  | "idle"
  | "loading"
  | "subscribed"
  | "denied"
  | "unsupported"
  | "needs-install";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// iOS Safari (Chrome on iOS too — it's all WebKit). Web push on iOS only
// works when the app is launched from the Home Screen as a PWA, never in a
// Safari tab. Detecting both pieces lets us show the right hint.
function detectIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS reports a Mac UA in "Desktop Site" mode but has touch points.
  return ua.includes("Mac") && (navigator as any).maxTouchPoints > 1;
}

function isStandalonePWA(): boolean {
  if (typeof window === "undefined") return false;
  // iOS exposes navigator.standalone; Chrome/desktop use the display-mode MQ.
  const iosStandalone = (window.navigator as any).standalone === true;
  const mqStandalone =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || mqStandalone;
}

interface NotificationsButtonProps {
  /** Visual context for the trigger. "rail" = Discord-style left rail
   *  (12x12 rounded-2xl). "header" = standard top-header icon button
   *  (h-9 w-9 rounded-md). Defaults to "header". */
  variant?: "rail" | "header";
}

export function NotificationsButton({ variant = "header" }: NotificationsButtonProps = {}) {
  // ── Initial state detection ─────────────────────────────────────────────
  // Run all the unsupported / install / denied checks once on mount. Doing
  // this here means the click handler never has to branch on capability —
  // it just needs to be gesture-pure.
  const computeInitial = (): State => {
    if (typeof window === "undefined") return "unsupported";
    const hasNotif = typeof Notification !== "undefined";
    const hasSW = "serviceWorker" in navigator;
    const hasPush = "PushManager" in window;
    if (!hasNotif || !hasSW || !hasPush) {
      // iOS Safari in a tab: Notification + serviceWorker exist but
      // PushManager is absent. Surface the install hint instead of a flat
      // "unsupported" so the user knows there's a path forward.
      if (detectIOS() && !isStandalonePWA()) return "needs-install";
      return "unsupported";
    }
    if (detectIOS() && !isStandalonePWA()) return "needs-install";
    if (Notification.permission === "denied") return "denied";
    if (Notification.permission === "granted") {
      // Permission granted in this browser already, but we may not have a
      // server subscription. We'll resolve to "subscribed" once the effect
      // below confirms (or re-subscribes if needed).
      return "idle";
    }
    return "idle";
  };

  const [state, setState] = useState<State>(computeInitial);

  // ── Pre-fetch VAPID key so the click handler is gesture-pure ───────────
  // iOS Safari only honors Notification.requestPermission() when called
  // *synchronously* (or via microtask-only awaits) inside a user gesture.
  // Awaiting a network fetch BEFORE requestPermission silently breaks the
  // gesture chain — the prompt never appears and the call resolves to
  // "default" with no error. We avoid that by fetching the key up front.
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [vapidConfigured, setVapidConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiRequest<{ key: string | null; configured: boolean }>(
          "GET",
          "/api/push/vapid-public-key",
        );
        if (cancelled) return;
        setVapidKey(r.key);
        setVapidConfigured(r.configured);
      } catch {
        if (!cancelled) setVapidConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Existing subscription check ────────────────────────────────────────
  // If the user already has permission AND a live PushSubscription, reflect
  // that as "subscribed" so the button doesn't re-prompt them.
  useEffect(() => {
    if (state !== "idle") return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (!cancelled && existing) setState("subscribed");
      } catch {
        /* ignore — fall back to idle */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  const enable = async () => {
    if (state === "unsupported" || state === "denied") return;

    // iOS Safari tab: explain how to install the PWA so push will work.
    // Tapping the bell does *something* instead of nothing — the original
    // "nothing happens" bug was partly this case hitting the early-return.
    if (state === "needs-install") {
      alert(
        "To get notifications on iPhone:\n\n" +
          "1. Open chat.bulldogops.com in Safari (must be Safari, not Chrome).\n" +
          "2. Tap the Share icon (square with up arrow) at the bottom.\n" +
          "3. Scroll down and tap \"Add to Home Screen\", then Add.\n" +
          "4. Open Bulldog Chat from the new home-screen icon and tap the bell again.",
      );
      return;
    }

    // Server-config check is cheap and pre-resolved, so this is sync.
    if (vapidConfigured === false || !vapidKey) {
      alert(
        "Push notifications are not configured on the server. Ask an admin to set VAPID keys.",
      );
      return;
    }

    // CRITICAL: call Notification.requestPermission() FIRST, inside the
    // gesture window. No awaits before it on iOS. Everything else (fetching
    // subscription, POSTing to the server) is allowed to await afterward
    // because iOS only gates the *permission prompt* itself.
    let perm: NotificationPermission;
    try {
      perm = await Notification.requestPermission();
    } catch (err) {
      console.warn("requestPermission threw", err);
      setState("idle");
      return;
    }

    if (perm !== "granted") {
      setState(perm === "denied" ? "denied" : "idle");
      return;
    }

    setState("loading");
    try {
      const reg = await navigator.serviceWorker.ready;

      // Reuse an existing subscription if iOS already minted one — calling
      // subscribe() a second time with the same VAPID key returns the same
      // subscription, but being explicit avoids any iOS weirdness.
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
      }

      const json = sub.toJSON();
      await apiRequest("POST", "/api/push/subscribe", {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        deviceLabel: navigator.userAgent.slice(0, 80),
      });
      setState("subscribed");
    } catch (err) {
      console.warn("push subscribe failed", err);
      // Surface a real error to the user — silent failures here are exactly
      // what made the iOS "nothing happens" bug so hard to spot.
      alert(
        "Couldn't enable notifications: " +
          (err instanceof Error ? err.message : "Unknown error"),
      );
      setState("idle");
    }
  };

  const icon =
    state === "subscribed" ? (
      <BellRing className="w-5 h-5" />
    ) : state === "loading" ? (
      <Loader2 className="w-5 h-5 animate-spin" />
    ) : (
      <Bell className="w-5 h-5" />
    );

  const title =
    state === "subscribed"
      ? "Push notifications enabled"
      : state === "denied"
        ? "Notifications blocked — enable them in iOS Settings → Notifications → Bulldog Chat"
        : state === "needs-install"
          ? "iOS push needs the app installed: Safari → Share → Add to Home Screen, then open from the icon"
          : state === "unsupported"
            ? "Notifications not supported on this device"
            : "Enable push notifications";

  const isHeader = variant === "header";

  // Unified notification treatment (spec §2): outline icon, no filled
  // background. Idle = muted stroke. "Attention" states (push needs the user's
  // action, or an error/blocked condition) read as the accent (deep blue)
  // stroke plus a small red dot at the top-right — NOT a gold/colored filled
  // rounded rectangle. The dot is the only red element.
  const needsAttention = state === "needs-install" || state === "denied";

  // 40×40 header button per spec; rail keeps its larger Discord-style box.
  const baseClass = isHeader
    ? "relative h-10 w-10 rounded-md flex items-center justify-center transition-colors hover:bg-[hsl(var(--vs-navy-soft))]"
    : "relative w-12 h-12 rounded-2xl flex items-center justify-center transition-all hover:bg-[hsl(220_45%_27%)]";

  // Stroke color: idle muted, attention = accent (deep blue), subscribed reads
  // as success green stroke (no fill).
  const strokeClass = needsAttention
    ? "text-[hsl(var(--vs-accent))]"
    : state === "subscribed"
      ? "text-vs-green"
      : "text-[hsl(var(--vs-text-muted))] hover:text-[hsl(var(--vs-text))]";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={enable}
          disabled={
            state === "loading" ||
            state === "denied" ||
            state === "unsupported" ||
            state === "subscribed"
          }
          className={[baseClass, strokeClass].join(" ")}
          data-testid="button-notifications"
          aria-label={title}
        >
          {icon}
          {needsAttention && (
            <span
              className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[hsl(var(--vs-danger))] ring-2 ring-white"
              aria-hidden="true"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={isHeader ? "bottom" : "right"}
        className="bg-[hsl(220_55%_14%)] border-[hsl(220_40%_25%)] text-white text-xs max-w-[240px]"
      >
        {title}
      </TooltipContent>
    </Tooltip>
  );
}
