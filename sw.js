/* =====================================================================
   sw.js — offline shell.

   The app is used on a two-hour walk through a city, where connectivity
   is somewhere between patchy and absent. Everything it needs is
   precached on first load, and served cache-first thereafter, so a
   reload on a street corner behaves exactly like a reload at home.

   Stale-while-revalidate: the cached copy is returned immediately and a
   fresh one is fetched in the background for next time. Content edits
   therefore land on the second load, never mid-session.
   ===================================================================== */

const CACHE = 'photo-walk-v1';

const SHELL = [
  './',
  'index.html',
  'styles/tokens.css',
  'styles/app.css',
  'scripts/app.js',
  'scripts/clock.js',
  'scripts/session.js',
  'scripts/render.js',
  'content/plan.json',
  'content/copy.json',
  'content/troubleshooting.json',
  'content/missions/mission-01.json',
  'content/missions/mission-02.json',
  'content/missions/mission-03.json',
  'content/missions/mission-04.json',
  'content/missions/mission-05.json',
  'content/missions/mission-06.json',
  'content/theory/aperture.json',
  'content/theory/shutter.json',
  'content/theory/iso.json',
  'content/theory/zoom.json',
  'content/theory/decision-sequence.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      /* Individually, so one missing file cannot fail the whole install. */
      .then((cache) => Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => null)),
      ))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    }),
  );
});
