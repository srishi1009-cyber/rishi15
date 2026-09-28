// ============================================================
// RISHI MUSIC - SERVICE WORKER (VERSION 4)
// ============================================================

const CACHE_NAME = "rishi-music-v4";

// ============================================================
// FILES TO CACHE (APP SHELL)
// ============================================================

const APP_SHELL = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json"
];

// ============================================================
// INSTALL
// ============================================================

self.addEventListener("install", (event) => {
    console.log("[Rishi Music SW] Installing v4...");

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log("[Rishi Music SW] Caching app shell...");
                return cache.addAll(APP_SHELL);
            })
            .then(() => self.skipWaiting())
    );
});

// ============================================================
// ACTIVATE (PURGE OLD CACHES)
// ============================================================

self.addEventListener("activate", (event) => {
    console.log("[Rishi Music SW] Activating v4...");

    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (
                            cacheName.startsWith("rishi-music-") &&
                            cacheName !== CACHE_NAME
                        ) {
                            console.log("[Rishi Music SW] Removing old cache:", cacheName);
                            return caches.delete(cacheName);
                        }
                        return Promise.resolve();
                    })
                );
            })
            .then(() => self.clients.claim())
    );
});

// ============================================================
// FETCH
// ============================================================

self.addEventListener("fetch", (event) => {
    const request = event.request;

    // 1. Only intercept GET requests
    if (request.method !== "GET") return;

    // 2. DO NOT intercept Audio/Video media or Range requests (prevents playback freezes)
    if (
        request.destination === "audio" ||
        request.destination === "video" ||
        request.headers.has("range")
    ) {
        return; // Allow native browser audio pipeline to handle byte-streaming directly
    }

    const url = new URL(request.url);

    // 3. Do not interfere with external origins or blob schemes
    if (url.origin !== self.location.origin || url.protocol === "blob:") {
        return;
    }

    // 4. HTML Documents: Network first, fallback to cached index.html
    if (request.mode === "navigate" || request.destination === "document") {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => {
                    return caches.match(request).then((cached) => {
                        return cached || caches.match("./index.html");
                    });
                })
        );
        return;
    }

    // 5. App Shell Scripts, Styles, and Manifest: Network first, update cache
    if (
        request.destination === "script" ||
        request.destination === "style" ||
        request.destination === "manifest"
    ) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // 6. Static assets (Images, Icons, Fonts): Cache first, fallback to network
    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;

            return fetch(request).then((response) => {
                if (
                    response &&
                    response.status === 200 &&
                    response.type === "basic"
                ) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            });
        })
    );
});

// ============================================================
// MESSAGE HANDLER
// ============================================================

self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") {
        self.skipWaiting();
    }
});