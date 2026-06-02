/* Bulldog Chat service worker — push + notification click */

const SW_VERSION = "bulldog-chat-1.2.17";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Aggressively nuke any caches the old SW (1.0.0/1.0.1) created. We are
  // not a caching SW now (push-only), so there should be nothing legitimate
  // in caches. Deleting them forces the iOS PWA "shell" out of stale-HTML
  // hell where index.html points to a since-deleted hashed JS bundle.
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch (_) { /* ignore */ }
    await self.clients.claim();
    // Tell every controlled tab to hard-reload so it picks up the fresh
    // index.html (and thus the current hashed JS bundles).
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      try { c.postMessage({ type: "SW_UPDATED", version: SW_VERSION }); } catch (_) {}
    }
  })());
});

// If a page asks us to reload, do it. Used in tandem with the SW_UPDATED
// postMessage on the client side.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: "Bulldog Chat", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Bulldog Chat";
  const opts = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "bulldog-chat",
    data: { url: data.url || "/#/" },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/#/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.focus();
          if ("navigate" in c) c.navigate(url).catch(() => {});
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
