// Service worker: deixa o app abrir rápido e funcionar sem internet.
// Ao lançar uma versão nova, aumente este número junto com o ?v= do index.html.
const CACHE = 'meu-ciclo-v5';
const SHELL = [
  './',
  './index.html',
  './app.js?v=5',
  './firebase-config.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Arquivos do próprio app: tenta a internet primeiro (pega atualizações),
  // e usa a cópia salva quando estiver sem conexão.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req, { cache: 'no-cache' }) // sempre confere se há versão nova no servidor
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Biblioteca do Firebase (arquivos com versão fixa): usa a cópia salva.
  if (url.hostname === 'www.gstatic.com') {
    e.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
      )
    );
  }
  // Todo o resto (banco de dados, login) passa direto.
});
