'use strict';
const SHELL = 'shell-v1';
const FOTOS = 'fotos-v1';
const ASSETS = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== FOTOS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data === 'clear-private') caches.delete(FOTOS);
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // la API la cachea la app (IndexedDB)

  if (url.pathname.startsWith('/uploads/')) {          // fotos: cache primero
    e.respondWith(caches.open(FOTOS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (req.mode === 'navigate') {                       // la app: red primero, caché si no hay conexión
    e.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.open(SHELL).then(async (c) => { // recursos: devolver caché y actualizar
    const hit = await c.match(req);
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
