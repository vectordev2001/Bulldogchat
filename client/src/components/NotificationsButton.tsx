import { useState } from "react";
import { Bell, BellRing, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type State = "idle" | "loading" | "subscribed" | "denied" | "unsupported";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function NotificationsButton() {
  const initial: State =
    typeof Notification === "undefined" || !("serviceWorker" in navigator)
      ? "unsupported"
      : Notification.permission === "denied"
      ? "denied"
      : "idle";
  const [state, setState] = useState<State>(initial);

  const enable = async () => {
    if (state === "unsupported" || state === "denied") return;
    setState("loading");
    try {
      const { key, configured } = await apiRequest<{ key: string | null; configured: boolean }>(
        "GET", "/api/push/vapid-public-key",
      );
      if (!configured || !key) {
        alert("Push notifications are not configured on the server (missing VAPID keys).");
        setState("idle");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "idle");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      const json = sub.toJSON();
      await apiRequest("POST", "/api/push/subscribe", {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        deviceLabel: navigator.userAgent.slice(0, 80),
      });
      setState("subscribed");
    } catch (err) {
      console.warn("push subscribe failed", err);
      setState("idle");
    }
  };

  const icon = state === "subscribed" ? <BellRing className="w-5 h-5" /> :
               state === "loading" ? <Loader2 className="w-5 h-5 animate-spin" /> :
               <Bell className="w-5 h-5" />;

  const title =
    state === "subscribed" ? "Push notifications enabled" :
    state === "denied" ? "Notifications blocked in browser" :
    state === "unsupported" ? "Notifications not supported on this device" :
    "Enable push notifications";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={enable}
          disabled={state === "loading" || state === "denied" || state === "unsupported" || state === "subscribed"}
          className={[
            "w-12 h-12 rounded-2xl flex items-center justify-center transition-all",
            state === "subscribed"
              ? "bg-vs-green/15 text-vs-green ring-1 ring-vs-green/40"
              : "hover:bg-[hsl(232_45%_27%)] text-[hsl(0_0%_70%)]",
          ].join(" ")}
          data-testid="button-notifications"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="bg-[hsl(232_55%_14%)] border-[hsl(232_40%_25%)] text-white text-xs">
        {title}
      </TooltipContent>
    </Tooltip>
  );
}
