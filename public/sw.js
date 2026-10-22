/*
 * Vocal Repair service worker. Static file: what to precache comes from /precache-manifest.js, which
 * `npm run build` generates (scripts/build-precache.mjs) from the real build output. Because the manifest
 * is importScripts()'d, a new build changes the worker's byte content and the browser installs the update.
 *
 * Precached: both pages, every /_next/static file (all JS/CSS the repair page and its workers need),
 * the RNNoise WASM, the MP3 encoder worker + the unmodified lamejs file, icons, manifest, licences.
 * Strategy: precached assets are cache-first; page navigations are network-first (4 s) with the cached page as fallback.
 */
importScripts("/precache-manifest.js"); // sets self.__PRECACHE = { version, urls }
const { version, urls } = self.__PRECACHE;
const CACHE = "vr-precache-" + version;
const NAV_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // all-or-nothing: if any file is missing the install fails and the old worker keeps serving
      cache.addAll(urls.map((u) => new Request(u, { cache: "reload" }))),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith("vr-precache-") && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  if (d.type === "STATUS" && event.ports[0]) {
    caches.open(CACHE).then((c) => c.keys()).then((keys) => event.ports[0].postMessage({ type: "STATUS", version, cached: keys.length, expected: urls.length }));
  }
});

const cacheMatch = (request) => caches.open(CACHE).then((c) => c.match(request, { ignoreSearch: true }));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const net = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), NAV_TIMEOUT_MS))]);
          return net;
        } catch {
          return (await cacheMatch(req)) || (await cacheMatch("/repair")) || (await cacheMatch("/")) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const hit = await cacheMatch(req);
      if (hit) return hit;
      return fetch(req);
    })(),
  );
});
