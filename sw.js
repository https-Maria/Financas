/* Service worker — cache do "casco" do app.
   Os dados vêm sempre do Supabase; aqui só guardamos a interface,
   para o app abrir mesmo sem internet. */
const CACHE = 'dueto-v114.0';
const SHELL = ['./', './index.html', './app.js?v=114.0', './finance-core.mjs?v=113.0', './notas-editor.mjs?v=114.0', './notas-avancadas.css?v=114.0', './manifest.json',
               './dueto-icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(new Request(u,{cache:'reload'})))))
    .then(() => self.skipWaiting()));
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
