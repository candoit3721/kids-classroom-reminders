/* Minimal service worker. Exists so the site qualifies as installable on
   Android; deliberately caches NOTHING — every request goes to the network,
   so a deploy is never masked by a stale cache. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* pass-through */ });
