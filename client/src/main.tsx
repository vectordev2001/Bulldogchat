import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Register service worker (PWA). Best-effort; fails silently in dev iframe / sandbox.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* ignore in sandboxes */
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
