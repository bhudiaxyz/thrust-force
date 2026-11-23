/**
 * sw.js — the service worker that makes Thrust Force installable and playable offline.
 *
 * Purpose
 *   Caches what the game needs so a returning (or offline) player starts instantly, without
 *   ever pinning an old build.
 *
 * Operations
 *   - Pages (navigations): network first, falling back to the cached copy when offline, so a
 *     new deploy is picked up on the next visit.
 *   - Build assets (hashed file names under assets/), icons, the manifest and Google Fonts:
 *     cache first, filled on first use. Hashed names never change content, so they never go
 *     stale; a new build simply requests new names.
 *   - activate: deletes caches from older CACHE versions. Bump CACHE to force a clean slate.
 *
 * Usage
 *   Registered by main.ts in production builds only (never on the Vite dev server). Lives in
 *   public/, so Vite copies it to the site root under the base path (/thrust-force/sw.js).
 *
 * See also: src/main.ts (registerServiceWorker), public/manifest.webmanifest; DESIGN.md
 * "16. Build and deployment".
 */
const CACHE = "thrust-force-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
    if (url.origin !== self.location.origin && !fonts) return;

    if (req.mode === "navigate") {
        // Network first: fresh builds win; the cache only serves offline.
        e.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                    return res;
                })
                .catch(() => caches.match(req).then((r) => r || caches.match("./")))
        );
        return;
    }

    // Cache first for everything else (hashed assets, icons, fonts).
    e.respondWith(
        caches.match(req).then(
            (hit) =>
                hit ||
                fetch(req).then((res) => {
                    if (res.ok || res.type === "opaque") {
                        const copy = res.clone();
                        caches.open(CACHE).then((c) => c.put(req, copy));
                    }
                    return res;
                })
        )
    );
});
