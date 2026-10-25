/**
 * AltiCorrige Service Worker – cache-busting strategy
 * Network-first for HTML/JS/CSS, cache-first for static assets.
 * Version bumped on each deploy to force refresh.
 */
const CACHE_VERSION = "alticorrige-v1.0.0-" + new Date().toISOString().slice(0, 10);
const STATIC_CACHE = CACHE_VERSION + "-static";
const RUNTIME_CACHE = CACHE_VERSION + "-runtime";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Install – precache core assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate – delete old caches (cache-busting)
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("alticorrige-") && k !== STATIC_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache IGN API calls
  if (url.hostname === "data.geopf.fr") {
    event.respondWith(fetch(request));
    return;
  }

  // CDN libs – cache-first
  if (
    url.hostname === "cdn.jsdelivr.net" ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".woff2")
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(RUNTIME_CACHE).then((c) => c.put(request, clone));
            }
            return res;
          })
      )
    );
    return;
  }

  // HTML / JS / CSS – network-first (fresh updates), fallback to cache
  if (
    request.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("manifest.json")
  ) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // Default: try cache then network
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});

// Allow page to force update
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
