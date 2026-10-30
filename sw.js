const CACHE_NAME = "Img-Editor-v2"; // غيّر الرقم عند أي تحديث كبير

const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // cache: "reload" حتى لا يُخزَّن ملف قديم من كاش المتصفح
      cache.addAll(
        FILES_TO_CACHE.map((url) => new Request(url, { cache: "reload" })),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)),
        ),
      ),
  );
  self.clients.claim();
});

// Stale-while-revalidate: يرد من الكاش فورًا ويحدّثه من الشبكة في الخلفية
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200)
            cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      if (res) return res;
      if (req.mode === "navigate") return cache.match("./index.html");
      return Response.error();
    }),
  );
});
