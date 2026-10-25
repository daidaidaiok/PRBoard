/* PRboard service worker — offline shell for the dashboard.
 *
 * Strategy:
 *  - /_next/static/* (content-hashed, immutable by construction): cache-first.
 *  - Same-origin navigations: network-first, falling back to the last cached
 *    HTML — a dead network still opens the last-visited page, and the app
 *    itself then renders from its localStorage snapshot and shows its own
 *    offline banner.
 *  - /api/* and everything else: untouched. PR data must be live; the app
 *    already degrades gracefully (server snapshot → localStorage cache →
 *    error card) without a middleman.
 */
const SHELL_CACHE = "prboard-shell-v1";
// Every deploy adds new hashed chunks to the same cache; without a cap it
// grows forever. 200 entries (~2-4 builds) keeps recent chunks for tabs
// that outlive a deploy while bounding storage.
const MAX_SHELL_ENTRIES = 200;

/** Drops the oldest cached entries beyond the cap (keys() is insertion-ordered). */
async function pruneShellCache() {
  const cache = await caches.open(SHELL_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_SHELL_ENTRIES) return;
  await Promise.all(
    keys.slice(0, keys.length - MAX_SHELL_ENTRIES).map((request) => cache.delete(request)),
  );
}

self.addEventListener("install", (event) => {
  // No precache list: Next's hashed chunks are discovered at runtime, and
  // the newest HTML lands in the cache on every successful visit.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith("prboard-") && name !== SHELL_CACHE).map((name) => caches.delete(name)),
      );
      await pruneShellCache();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })(),
    );
    return;
  }

  if (request.mode === "navigate") {
    // Network-first so a deploy goes out immediately; the cached HTML is an
    // offline fallback, never a serving layer.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        } catch (error) {
          const cached = await caches.match(request);
          if (cached) return cached;
          throw error;
        }
      })(),
    );
  }
});
