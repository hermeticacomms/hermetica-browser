/// <reference lib="dom" />
// Web push helper: a separate entry point so the core bundle (size-budgeted) does not grow. Needs a service worker file (sw/hermetica-sw.js).
export interface WebPushOptions {
  siteKey: string;
  endpoint: string;
  /** Where you serve sw/hermetica-sw.js from (must be on your own origin; root scope is best). */
  serviceWorkerUrl?: string;
  identity?: { externalId?: string; email?: string; phoneNumber?: string; anonymousId?: string };
}

const SDK_VERSION = '0.4.0';
const opt = (k: string, v: string | undefined): Record<string, string> => (v ? { [k]: v } : {});
const base = (o: WebPushOptions) => o.endpoint.replace(/\/$/, '');

const key64 = (s: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** The same Klaviyo JSON:API push-token body the mobile SDK sends. */
export function pushTokenBody(o: WebPushOptions, token: string, status: 'AUTHORIZED' | 'UNAUTHORIZED') {
  const id = o.identity ?? {};
  const attributes = { ...opt('email', id.email), ...opt('phone_number', id.phoneNumber), ...opt('external_id', id.externalId), ...opt('anonymous_id', id.anonymousId) };
  return {
    data: {
      type: 'push-token',
      attributes: {
        token, platform: 'web', vendor: 'web_push', enablement_status: status, background: 'AVAILABLE',
        device_metadata: { device_id: id.anonymousId ?? '', sdk_version: SDK_VERSION, device_model: 'browser', os_name: navigator.platform, os_version: '', app_name: location.hostname, app_version: '', app_build: '', app_id: location.hostname, environment: 'release' },
        profile: { data: { type: 'profile', attributes } },
      },
    },
  };
}

const post = (o: WebPushOptions, path: string, body: unknown) =>
  fetch(`${base(o)}${path}?company_id=${encodeURIComponent(o.siteKey)}`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', authorization: `Bearer ${o.siteKey}`, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });

/** Asks permission, subscribes this browser and registers the subscription. Resolves false when unsupported, denied, or the server has no push config. */
export async function subscribeWebPush(o: WebPushOptions): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  if ((await Notification.requestPermission()) !== 'granted') return false;
  const cfg = await fetch(`${base(o)}/client/push-config?company_id=${encodeURIComponent(o.siteKey)}`, { headers: { authorization: `Bearer ${o.siteKey}` } });
  if (!cfg.ok) return false;
  // GET /client/push-config answers { vapidPublicKey: string }.
  const vapid = ((await cfg.json()) as { vapidPublicKey?: string }).vapidPublicKey;
  if (!vapid) return false;
  const id = o.identity ?? {};
  const reg = await navigator.serviceWorker.register(o.serviceWorkerUrl ?? '/hermetica-sw.js');
  const ready = await navigator.serviceWorker.ready;
  // The worker keeps the settings in IndexedDB; they never appear in its URL.
  (ready.active ?? reg.active)?.postMessage({ type: 'hermetica-config', endpoint: base(o), key: o.siteKey, anon: id.anonymousId ?? '', ext: id.externalId ?? '' });
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key64(vapid) }));
  return (await post(o, '/client/push-tokens', pushTokenBody(o, JSON.stringify(sub.toJSON()), 'AUTHORIZED'))).ok;
}

/** Drops the browser subscription and tells the server to stop sending to it. */
export async function unsubscribeWebPush(o: WebPushOptions): Promise<boolean> {
  const reg = await navigator.serviceWorker?.getRegistration(o.serviceWorkerUrl ?? '/hermetica-sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  const token = JSON.stringify(sub.toJSON());
  await sub.unsubscribe();
  return (await post(o, '/client/push-token-unregister', pushTokenBody(o, token, 'UNAUTHORIZED'))).ok;
}
