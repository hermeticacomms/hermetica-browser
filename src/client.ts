/// <reference lib="dom" />
import { startAutocapture } from './autocapture.ts';
import { startVideoTracking } from './video.ts';
import { setCart, startForms } from './forms.ts';
import { readPlatformCart } from './cart.ts';
import { startSiteMessages } from './site-messages.ts';
import { createStore } from './storage.ts';
import { createTransport } from './transport.ts';
import type { Client, ClientOptions, Consent, QueuedEvent } from './types.ts';

const SDK_VERSION = '0.2';
const PRE_CONSENT_CAP = 50;
const SERVER_MAX_BATCH = 50;
const KEY_ID = 'hm_aid';
const KEY_CONSENT = 'hm_consent';
const uuid = () => crypto.randomUUID();

export function createClient(opts: ClientOptions): Client {
  const mode = opts.consentMode ?? 'require-consent';
  const maxSize = Math.min(opts.batch?.maxSize ?? 20, SERVER_MAX_BATCH);
  const flushMs = opts.batch?.flushMs ?? 2000;
  const maxQueue = opts.maxQueue ?? 200;
  const store = createStore(opts.storage ?? 'local');
  const listeners: Record<string, ((d: unknown) => void)[]> = {};
  const emit = (e: string, d?: unknown) => (listeners[e] ?? []).forEach((f) => f(d));
  let debugOn = opts.debug ?? false;
  // oxlint-disable-next-line no-console
  const log = (...a: unknown[]) => debugOn && console.debug('[hermetica]', ...a);
  const transport = createTransport(opts.endpoint, opts.siteKey, (e) => emit('error', e));

  // Reading a stored decision is fine; the decision itself is only written on an explicit update().
  const stored = ((): Consent | null => { try { return JSON.parse(store.get(KEY_CONSENT) ?? 'null'); } catch { return null; } })();
  let consent: Consent = stored ?? (mode === 'require-consent' ? { analytics: false, marketing: false } : { analytics: true, marketing: true });
  let decided = stored !== null || mode !== 'require-consent';
  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aid: string | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const anonymousId = (): string => {
    aid ??= store.get(KEY_ID);
    if (!aid) { aid = uuid(); store.set(KEY_ID, aid); }
    return aid;
  };
  const utm = (): Record<string, string> => {
    const out: Record<string, string> = {};
    try { new URL(location.href).searchParams.forEach((v, k) => { if (k.startsWith('utm_')) out[k.slice(4)] = v.slice(0, 256); }); } catch { /* no location */ }
    return out;
  };
  const landingUtm = utm();
  const pageCtx = () => ({ page: { url: location.href, referrer: document.referrer, title: document.title }, ...(Object.keys(landingUtm).length ? { utm: landingUtm } : {}) });

  function enqueue(name: string, properties: Record<string, unknown>, extra: Partial<QueuedEvent> = {}): void {
    if (decided && !consent.analytics) { log('dropped (analytics denied)', name); return; }
    const ev: QueuedEvent = { name, properties: { ...properties, hm_sdk: SDK_VERSION, ...(globalThis as { hmAd?: () => object }).hmAd?.() }, dedupeKey: uuid(), occurredAt: new Date().toISOString(), context: pageCtx(), ...extra };
    queue.push(ev);
    const cap = decided ? maxQueue : PRE_CONSENT_CAP;
    if (queue.length > cap) queue.splice(0, queue.length - cap); // drop oldest
    log('queued', ev);
    if (!decided) return;
    if (queue.length >= maxSize) void flush();
    else timer ??= setTimeout(() => void flush(), flushMs);
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!decided || !consent.analytics || queue.length === 0) return inflight;
    const id = anonymousId();
    const batch = queue.splice(0, maxSize).map((e) => ({ ...e, anonymousId: id }));
    inflight = inflight.then(async () => {
      const ok = await transport.send('/ingest/v1/batch', { events: batch, consent });
      if (ok) emit('flush', batch);
      else { queue.unshift(...batch); queue.splice(0, queue.length - maxQueue); emit('error', new Error('send failed')); }
      // Not awaited: the next batch chains behind this promise, so awaiting it here would deadlock.
      if (ok && queue.length) void flush();
    });
    return inflight;
  }

  const pagehide = () => {
    if (!decided || !consent.analytics || queue.length === 0) return;
    const id = anonymousId();
    while (queue.length) {
      const events = queue.splice(0, SERVER_MAX_BATCH).map((e) => ({ ...e, anonymousId: id }));
      transport.beacon('/ingest/v1/batch', { events, consent });
    }
  };
  if (typeof addEventListener === 'function') addEventListener('pagehide', pagehide);

  const page = (props: Record<string, unknown> = {}) => enqueue('page_view', props);
  if (opts.autoPageViews) {
    page();
    for (const m of ['pushState', 'replaceState'] as const) {
      const orig = history[m].bind(history);
      history[m] = (...a: Parameters<History['pushState']>) => { orig(...a); page(); };
    }
    addEventListener('popstate', () => page());
  }

  if (opts.autocapture && typeof document !== 'undefined') startAutocapture((n, p) => enqueue(n, p));
  if (opts.trackVideo && typeof document !== 'undefined') startVideoTracking((n, p) => enqueue(n, p));

  const formDeps = () => ({ client: api, endpoint: opts.endpoint, siteKey: opts.siteKey, get: store.get, set: store.set, allowed: () => decided && consent.analytics });
  const forms = { start: async () => { if (opts.cart) await readPlatformCart(opts.cart, setCart); await Promise.all([startForms(formDeps()), startSiteMessages(formDeps())]); }, setCart };
  const api: Client = {
    forms,
    track: (name, props = {}, o = {}) => enqueue(name, props, { ...(o.value !== undefined ? { value: o.value } : {}), ...(o.currency ? { currency: o.currency } : {}), ...(o.dedupeKey ? { dedupeKey: o.dedupeKey } : {}) }),
    page,
    formView: (formId, versionId) => enqueue('form_view', { formId, ...(versionId ? { versionId } : {}) }),
    identify(externalId, traits = {}) {
      // The server also refuses identity without marketing consent; skipping here avoids storing an id we cannot use.
      if (!consent.marketing || (decided && !consent.analytics)) { log('identify skipped (no marketing consent)'); return; }
      const { email, phone, ...rest } = traits as { email?: string; phone?: string };
      void inflight.then(() => transport.send('/ingest/v1/identify', {
        anonymousId: anonymousId(), identifiers: { ...(externalId ? { externalId } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) }, traits: rest, consent,
      }));
    },
    subscribe: (o) => transport.send('/ingest/v1/subscribe', { ...o, pageUrl: location.href, anonymousId: api.anonymousId() ?? undefined }),
    backInStock: (o) => transport.send('/ingest/v1/back-in-stock', o),
    consent: {
      get: () => ({ ...consent }),
      update(c) {
        consent = { ...consent, ...c };
        decided = true;
        store.set(KEY_CONSENT, JSON.stringify(consent));
        emit('consent', { ...consent });
        if (consent.analytics) void flush();
        else { queue = []; aid = null; store.del(KEY_ID); } // denied: pre-consent events are dropped, never sent
      },
    },
    anonymousId: () => (decided && consent.analytics ? anonymousId() : null),
    reset() { queue = []; aid = null; store.del(KEY_ID); },
    flush,
    on(event, cb) { (listeners[event] ??= []).push(cb as (d: unknown) => void); },
    debug: { events: () => [...queue], enable: () => { debugOn = true; }, disable: () => { debugOn = false; } },
  };
  if (opts.forms) void forms.start();
  return api;
}
