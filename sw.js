/* Service worker — cache do "casco" do app.
   Os dados vêm sempre do Supabase; aqui só guardamos a interface,
   para o app abrir mesmo sem internet. */
const CACHE = 'financeiro-v21';
const SHELL = ['./', './index.html', './app.js', './manifest.json',
               './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Nunca cachear chamadas ao Supabase: dados têm que ser frescos.
  if (url.hostname.endsWith('supabase.co')) return;
  // arquivos versionados (?v=) vêm sempre da rede quando possível

  if (e.request.method !== 'GET') return;

  // Interface: rede primeiro, cache como rede de segurança.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
