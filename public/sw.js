/* =================================================================================================
 * Service Worker
 *   1) Offline: die App-Oberfläche wird zwischengespeichert (erst Netz, damit Updates sofort ankommen; ohne Netz
 *      die gemerkte Version). Daten laufen über /api und werden von der App selbst im Gerät gesichert.
 *   2) Push: Nachrichten des Disponenten erscheinen als Benachrichtigung, die stehen bleibt und nach dem
 *      Wegwischen wiederkommt, bis „Bestätigen“ getippt wird.
 *   3) Push „Auftrag disponiert / geändert“: gewöhnliche Benachrichtigung (nichts gesperrt, keine Bestätigung); Tipp öffnet die App.
 *   4) Push „Chat“ (Nachricht vom Disponenten oder von einem Kollegen des Teams): gewöhnliche Benachrichtigung; Tipp öffnet die App im Chat.
 *   5) Push „Chat mit Bestätigung“ (t: 'cq'): wie 2) – bleibt stehen, kommt wieder, bis „Bestätigen“ getippt wird –, aber je Nachricht eine eigene
 *      Benachrichtigung (Tag „cq<Nummer>“), bestätigt über /api/chat/ack; Tipp öffnet die App im Chat.
 * ================================================================================================= */
// Name des Caches; ändert sich die Dateiliste, hochzählen – alte Caches werden beim Aktivieren gelöscht
const CACHE_NAME = 'auftraege-v4';
// Dateien, die beim Installieren vorab gespeichert werden (App-Hülle)
const APP_SHELL = [
  '/',
  '/index.html',
  '/worker.js',
  '/vendor/xlsx.full.min.js',
  '/manifest.webmanifest',
  '/fonts/inter-regular.woff2',
  '/fonts/inter-medium.woff2',
  '/fonts/inter-semibold.woff2',
  '/fonts/inter-bold.woff2',
  '/icon-192.png',
  '/icon-512.png'
];
// Installieren: App-Hülle laden und sofort aktivieren
self.addEventListener('install', e =>
  e.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(c => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  )
);
// Aktivieren: alte Caches löschen, offene Seiten sofort übernehmen
self.addEventListener('activate', e =>
  e.waitUntil(
    caches
      .keys()
      .then(k => Promise.all(k.filter(x => x !== CACHE_NAME).map(x => caches.delete(x))))
      .then(() => self.clients.claim())
  )
);
// Abrufe der eigenen Seite (GET, nicht /api/): Netz zuerst, erfolgreiche Antworten werden gemerkt, sonst Cache
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // erst Netz (damit Updates sofort ankommen), ohne Netz die gemerkte Version
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const cp = r.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, cp));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('/index.html'))
      )
  );
});

// ---- Push: Nachricht vom Disponenten ----
// bleibt stehen, vibriert, kommt nach dem Wegwischen sofort wieder – bis auf „Bestätigen“ getippt wird
const DEFAULT_TITLE = 'Nachricht vom Disponenten';
// Optionen der Benachrichtigung: bleibt stehen (requireInteraction), vibriert, ersetzt die vorige (Tag „nachricht“; Chat mit Bestätigung: je
// Nachricht „cq<Nummer>“), Button „Bestätigen“. data = { id, did, … } wird für die Bestätigung gebraucht.
const notificationOptions = d => ({
  body: d.body || '',
  tag: d.t === 'cq' ? 'cq' + d.id : 'nachricht',
  renotify: true,
  requireInteraction: true,
  silent: false,
  vibrate: [500, 200, 500, 200, 900],
  icon: '/icon-192.png',
  badge: '/icon-192.png',
  timestamp: d.at || Date.now(),
  data: d,
  actions: [{ action: 'ok', title: '✓ Bestätigen' }]
});
// zeigt die Benachrichtigung zu den Push-Daten d
const showMessage = d => self.registration.showNotification(d.title || DEFAULT_TITLE, notificationOptions(d));
// Meldung „Auftrag disponiert / geändert“ (Push-Daten { t: 'dispo', title, body, at, n }): eine ganz gewöhnliche Benachrichtigung – sperrt nichts,
// bleibt nicht „nervig“ stehen und braucht keine Bestätigung. Tag „dispo“: eine neuere ersetzt die ältere (und meldet sich mit Ton/Vibration).
const showDispo = d =>
  self.registration.showNotification(d.title || 'Disposition geändert', {
    body: d.body || '',
    tag: 'dispo',
    renotify: true,
    silent: false,
    vibrate: [250, 100, 250],
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    timestamp: d.at || Date.now(),
    data: { t: 'dispo' }
  });
// Chat-Nachricht (Push-Daten { t: 'chat', title, body, at, team } – team = Raum: Teamname oder * für den Gruppenchat): gewöhnliche Benachrichtigung
// ohne Bestätigung (auch Disponenten bekommen sie). Tag „chat“: eine neuere ersetzt die
// ältere, meldet sich aber wieder mit Ton/Vibration. (Auch bei geöffneter App wird sie gezeigt: iPhones verlangen zu jedem Push eine Benachrichtigung.)
const showChat = d =>
  self.registration.showNotification(d.title || 'Chat', {
    body: d.body || '',
    tag: 'chat',
    renotify: true,
    silent: false,
    vibrate: [200, 100, 200],
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    timestamp: d.at || Date.now(),
    data: { t: 'chat', team: d.team || '' }
  });
// sagt allen offenen App-Fenstern, dass es Neues gibt (die App gleicht dann sofort ab)
const notifyApp = () =>
  self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.forEach(w => w.postMessage({ t: 'msg' })));

// Push vom Server (Daten: { id, did, team, title, body, at }): anzeigen und die App informieren
self.addEventListener('push', e => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(Promise.all([d.t === 'chat' ? showChat(d) : d.t === 'dispo' ? showDispo(d) : showMessage(d), notifyApp()]));
});

// Bestätigung direkt aus der Benachrichtigung an den Server melden (POST /api/msg/ack, Chat: /api/chat/ack); true bei Erfolg
const acknowledge = d =>
  fetch(d.t === 'cq' ? '/api/chat/ack' : '/api/msg/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: d.id, did: d.did, at: Date.now() })
  })
    .then(r => r.ok)
    .catch(() => false);
// Tipp auf die Benachrichtigung: Button „Bestätigen“ bestätigt direkt, sonst wird die App geöffnet/fokussiert
self.addEventListener('notificationclick', e => {
  const n = e.notification,
    d = n.data || {};
  n.close();
  if (e.action === 'ok') {
    // direkt in der Benachrichtigung bestätigt
    e.waitUntil(
      acknowledge(d).then(ok =>
        ok
          ? notifyApp()
          : showMessage({ ...d, body: '⚠ Keine Verbindung – bitte erneut bestätigen.\n' + (d.body || '') })
      )
    );
    return;
  }
  // Tipp auf die Nachricht: App öffnen, dort wird bestätigt (Chat: die App öffnet den Chat, bei geschlossener App über ?chat=1)
  const chat = d.t === 'chat' || d.t === 'cq';
  e.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(ws =>
        ws.length
          ? ws[0].focus().then(w => (w || ws[0]).postMessage({ t: chat ? 'chat' : 'msg', team: d.team || '' }))
          : self.clients.openWindow(chat ? '/?chat=1&team=' + encodeURIComponent(d.team || '') : '/')
      )
  );
});
self.addEventListener('notificationclose', e => {
  // weggewischt ohne Bestätigung -> wieder anzeigen, solange die Nachricht offen ist
  const d = e.notification.data || {};
  if (!d.id) return;
  e.waitUntil(
    fetch(`/api/${d.t === 'cq' ? 'chat' : 'msg'}/state?id=${d.id}&did=${encodeURIComponent(d.did || '')}`)
      .then(r => r.json())
      .then(s => s.open)
      .catch(() => true)
      .then(open => open && showMessage(d))
  );
});
self.addEventListener('pushsubscriptionchange', e => {
  // Browser hat das Abo erneuert -> beim Server nachziehen
  const old = e.oldSubscription && e.oldSubscription.endpoint;
  e.waitUntil(
    (e.newSubscription
      ? Promise.resolve(e.newSubscription)
      : fetch('/api/push/key')
          .then(r => r.json())
          .then(k =>
            self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k.key })
          )
    )
      .then(sub =>
        fetch('/api/push/resub', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old, sub: sub.toJSON() })
        })
      )
      .catch(() => {})
  );
});
