import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

if (!window.location.hash) {
  window.location.hash = "#/";
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
