import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { queryClient } from "./lib/queryClient";
import { isNativeApp } from "./lib/native-app";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// iOS foreground refresh. The Bulldog iOS app is a bespoke WKWebView shell, NOT
// a Capacitor app — `window.Capacitor` is never injected here (see
// lib/native-app.ts), so there's no `@capacitor/app` `appStateChange` event to
// hook. The signal WKWebView DOES fire when the app returns to the foreground
// is the standard `visibilitychange`. When the WebView was backgrounded it very
// likely dropped its SSE stream and missed events (new messages, a cleared
// channel). On foreground we invalidate every query so React Query refetches
// from the server, forcing the UI back in sync. Gated to the native shell so we
// don't add refetch churn for ordinary browser tab-switching (refetchOnWindow
// focus already covers desktop).
if (isNativeApp()) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      queryClient.invalidateQueries();
    }
  });
}

// Register service worker (PWA). Best-effort; fails silently in dev iframe / sandbox.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // Poll for SW updates every 30s while the tab is open. Without this
      // iOS Safari will happily keep a months-old SW until the OS decides
      // to reload, which is how PWAs get stuck on a stale shell.
      const poll = () => { try { reg.update(); } catch (_) {} };
      setInterval(poll, 30_000);
      poll();
      // When a new SW takes over, hard-reload the page so we don't keep
      // running an old JS bundle that the new SW has invalidated.
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    }).catch(() => {
      /* ignore in sandboxes */
    });
    // When the new SW posts SW_UPDATED to us, reload to pick up the fresh
    // index.html + hashed bundles. Belt-and-suspenders alongside
    // controllerchange (some browsers don't fire it reliably).
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "SW_UPDATED") {
        try { window.location.reload(); } catch (_) {}
      }
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
