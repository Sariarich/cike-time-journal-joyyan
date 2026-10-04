const CACHE = "right-now-v51";
const ASSETS = ["./", "./index.html", "./styles-ui-v23.css", "./migration.js?v=1", "./sync-queue.js?v=1", "./sync-engine.js?v=1", "./conflict.js?v=1", "./app.js?v=53", "./right-now.webmanifest", "./right-now-mark-192-v2.png", "./right-now-mark-512.png", "./right-now-apple-touch-icon.png", "./right-now-logo.png"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener("activate", (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./") : Response.error()))));
});
