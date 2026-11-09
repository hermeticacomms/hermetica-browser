// Hermeticor web push service worker. Serve it from your site root and register it with
// subscribeWebPush() from '@hermetica/sdk-browser/push', which posts the settings (endpoint, public key, anonymous and external id)
// to this worker; they are kept in IndexedDB so push events work when no page is open.
/* eslint-env serviceworker */
const DB = 'hermetica-sw';
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.addEventListener('upgradeneeded', () => r.result.createObjectStore('kv')); r.addEventListener('success', () => res(r.result)); r.addEventListener('error', () => rej(r.error)); });
const saveCfg = async (c) => { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(c, 'cfg'); t.addEventListener('complete', res); t.addEventListener('error', () => rej(t.error)); }); };
const loadCfg = async () => { try { const db = await idb(); return await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get('cfg'); r.addEventListener('success', () => res(r.result || {})); r.addEventListener('error', () => res({})); }); } catch { return {}; } };

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'hermetica-config' && typeof d.endpoint === 'string' && typeof d.key === 'string') e.waitUntil(saveCfg({ endpoint: d.endpoint.replace(/\/$/, ''), key: d.key, anon: String(d.anon || ''), ext: String(d.ext || '') }));
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Payload: { title, body, icon, image, badge, url, hermetica_message_id, data }
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  const messageId = d.hermetica_message_id || (d.data && d.data.hermetica_message_id) || '';
  event.waitUntil(self.registration.showNotification(d.title || 'Notification', {
    body: d.body || '', icon: d.icon, image: d.image, badge: d.badge, tag: messageId || undefined,
    data: { url: d.url || (d.data && d.data.url) || '/', messageId },
  }));
});

async function trackOpen(messageId) {
  const cfg = await loadCfg();
  if (!cfg.endpoint || !cfg.key || !messageId) return;
  const profile = cfg.ext ? { externalId: cfg.ext } : undefined;
  const event = { name: '$opened_push', properties: { hermetica_message_id: messageId, platform: 'web' }, dedupeKey: 'push-open:' + messageId + ':' + (cfg.ext || cfg.anon), occurredAt: new Date().toISOString(), ...(profile ? { profile } : {}), ...(cfg.anon ? { anonymousId: cfg.anon } : {}) };
  await fetch(cfg.endpoint + '/ingest/v1/batch', {
    method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({ events: [event], consent: { analytics: true, marketing: true } }),
  }).catch(() => undefined);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, messageId } = event.notification.data || {};
  let target = self.location.origin + '/';
  try { const u = new URL(url || '/', self.location.origin); if (u.protocol === 'https:' || u.protocol === 'http:') target = u.href; } catch { /* keep the site root */ }
  event.waitUntil(Promise.all([
    trackOpen(messageId),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const same = list.find((c) => c.url === target && 'focus' in c);
      return same ? same.focus() : self.clients.openWindow(target);
    }),
  ]));
});
