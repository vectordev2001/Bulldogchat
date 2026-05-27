/* Vector Chat service worker — push + notification click */

const SW_VERSION = "vector-chat-1.0.0";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { title: "Vector Chat", body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Vector Chat";
  const opts = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "vector-chat",
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
