/* ============================================================
   Offline service worker for the organizer console.

   A race venue is often a field with no usable signal, and the console is
   the thing that must not fail there. This worker keeps the app itself on
   the phone: the page, its stylesheet, the local modules, the vendored QR
   libraries, the Leaflet/Tesseract/Firebase scripts and the web fonts.

   It deliberately does NOT touch live race data. Requests to the Firebase
   database, auth and analytics pass straight through to the network, so the
   Firebase SDK's own offline cache stays in charge of the roster and
   results — a service worker replaying stale snapshots of those would be a
   far worse bug than a failed request.

   The roster itself is already on the device (localStorage snapshot plus
   Firebase's IndexedDB cache); nothing here can or should try to cache it.
   ============================================================ */

const VERSION = "v4";
const SHELL_CACHE = `bo5k-shell-${VERSION}`;
const FONT_CACHE = `bo5k-fonts-${VERSION}`;
const RUNTIME_CACHE = `bo5k-runtime-${VERSION}`;

const FONT_CSS =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Roboto+Mono:wght@500;600&family=Rye&family=Special+Elite&display=swap";

/* Everything the console needs to draw itself and to print, scan and time. */
const SHELL = [
  "./organizer.html",
  "./race.css",
  "./fonts/Oakhill.ttf",
  "./race-core.js",
  "./finish-cam.js",
  "./crossing-cam.js",
  "./pdf-export.js",
  "./gun-sensor.js",
  "./vendor/qrcode.min.js",
  "./vendor/jsQR.js",
  "/Favicon%20Generator/favicon-96x96.png",
  "/Favicon%20Generator/favicon.svg",
  "/Favicon%20Generator/favicon.ico",
  // home-screen install: the manifest and the icons it names
  "./organizer.webmanifest",
  "/Favicon%20Generator/apple-touch-icon.png",
  "/Favicon%20Generator/web-app-manifest-192x192.png",
  "/Favicon%20Generator/web-app-manifest-512x512.png",
  "/Favicon%20Generator/web-app-manifest-192x192-maskable.png",
  "/Favicon%20Generator/web-app-manifest-512x512-maskable.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js",
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/11.0.1/firebase-database.js",
];

/* Origins whose GETs are safe to keep a copy of. */
const TRUSTED = [
  self.location.origin,
  "https://unpkg.com",
  "https://cdn.jsdelivr.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://www.gstatic.com",
];

/* Never intercepted: live data, auth, analytics, and map tiles (each tile
   would cost storage for a map nobody reads mid-race, off a phone). */
const PASS_THROUGH = [
  "firebaseio.com",
  "firebaseapp.com",
  "google-analytics.com",
  "googletagmanager.com",
  "arcgisonline.com",
];

const NAV_TIMEOUT_MS = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      // One flaky CDN file must not leave the console with no shell at all,
      // so each asset is cached on its own and failures are only logged.
      await Promise.all(
        SHELL.map((url) =>
          shell
            .add(new Request(url, { cache: "reload" }))
            .catch((err) => console.warn("[sw] skipped", url, err))
        )
      );
      await precacheFonts();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, FONT_CACHE, RUNTIME_CACHE]);
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (PASS_THROUGH.some((host) => url.hostname.endsWith(host))) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }

  if (TRUSTED.some((origin) => url.href.startsWith(origin))) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

/**
 * Pages: fresh copy when the network answers quickly, otherwise the cached
 * console. The copy is stored under the bare path so `?v=` reloads during
 * development keep overwriting one entry instead of piling up.
 */
async function navigate(request) {
  const shell = await caches.open(SHELL_CACHE);
  const canonical = new URL(request.url);
  canonical.search = "";


  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NAV_TIMEOUT_MS)),
    ]);
    if (response && response.ok) {
      await shell.put(canonical.href, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await shell.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // Only the console falls back to its own shell; any other page is simply
    // not available offline, and must not masquerade as the timing console.
    if (canonical.pathname.endsWith("/organizer.html")) {
      const shellCopy = await shell.match("./organizer.html", { ignoreSearch: true });
      if (shellCopy) return shellCopy;
    }
    return new Response("This page has not been saved for offline use — open it once with internet.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/** Cache immediately, refresh in the background: fast, and offline-safe. */
async function staleWhileRevalidate(request) {
  const runtime = await caches.open(RUNTIME_CACHE);
  const shell = await caches.open(SHELL_CACHE);
  const cached =
    (await runtime.match(request, { ignoreSearch: true })) ||
    (await shell.match(request, { ignoreSearch: true }));

  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === "opaque")) {
        runtime.put(request, response.clone()).catch(() => {});
      }
      return response;
    });

  if (cached) {
    network.catch(() => {});
    return cached;
  }
  return network;
}

/**
 * The font files only exist as URLs inside Google's stylesheet, and the page
 * may have been loaded before this worker took control — so fetch the sheet
 * here and cache every font it points at.
 */
async function precacheFonts() {
  try {
    const fonts = await caches.open(FONT_CACHE);
    const response = await fetch(FONT_CSS, { cache: "reload" });
    if (!response || !response.ok) return;
    await fonts.put(FONT_CSS, response.clone());
    const css = await response.text();
    const urls = [...new Set(
      [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1])
    )];
    await Promise.all(
      urls.map((url) => fonts.add(new Request(url, { cache: "reload" })).catch(() => {}))
    );
  } catch (err) {
    console.warn("[sw] fonts not cached", err);
  }
}
