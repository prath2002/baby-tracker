/* Baby Health service worker.
 * Privacy: API responses (health data) are never cached. Only the static app shell is cached for offline start.
 * Offline writes are queued in IndexedDB by the page and flushed when back online (Background Sync when available). */
const VERSION = "bh-v1";
const SHELL = ["/offline.html", "/icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache PHI
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname.endsWith(".woff2")) {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
      .catch(async () => (await caches.match(e.request)) || caches.match("/offline.html")));
  }
});
self.addEventListener("sync", (e) => { if (e.tag === "bh-flush") e.waitUntil(self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage("bh-flush")))); });
self.addEventListener("push", (e) => {
  let d = { title: "Baby Health", path: "/notifications" };
  try { d = { ...d, ...e.data.json() }; } catch {}
  e.waitUntil(self.registration.showNotification(d.title, { body: "Open the app for details.", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { path: d.path }, tag: d.id }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const path = (e.notification.data && e.notification.data.path) || "/notifications";
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => { for (const c of cs) if ("focus" in c) { c.navigate(path); return c.focus(); } return self.clients.openWindow(path); }));
});
