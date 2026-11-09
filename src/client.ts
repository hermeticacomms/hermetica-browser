/// <reference lib="dom" />
import { startAutocapture } from './autocapture.ts';
import { startVideoTracking } from './video.ts';
import { setCart, startForms } from './forms.ts';
import { readPlatformCart } from './cart.ts';
import { startSiteMessages } from './site-messages.ts';
import { createStore } from './storage.ts';
import { createTransport } from './transport.ts';
import type { Client, ClientOptions, Consent, QueuedEvent, RemoteSettings } from './types.ts';

const SDK_VERSION = '0.2';
const PRE_CONSENT_CAP = 50;
const SERVER_MAX_BATCH = 50;
const KEY_ID = 'hm_aid';
const KEY_CONSENT = 'hm_consent';
const REMOTE_TIMEOUT_MS = 3000;
const uuid = () => crypto.randomUUID();

/** Options passed in code win; the site's saved settings (remoteConfig) fill the rest; then the SDK defaults. */
export function resolveSettings(o: ClientOptions, r: Partial<RemoteSettings> = {}) {
  return {
    mode: o.consentMode ?? r.consentMode ?? 'require-consent',
    bufferUntilConsent: o.bufferUntilConsent ?? r.bufferUntilConsent ?? false,
    stripQuery: o.stripQuery ?? r.stripQuery ?? false,
    // An empty saved list means "keep every parameter"; an empty list in code means "keep none" (as before).
    allowParams: o.allowParams ?? (r.allowParams?.length ? r.allowParams : undefined),
    autoPageViews: o.autoPageViews ?? r.autoPageViews ?? false,
    pageViewRoutes: o.pageViewRoutes ?? r.pageViewRoutes ?? [],
    identify: { email: true, phone: true, externalId: true, ...r.identify, ...o.identify },
    maxSize: Math.min(o.batch?.maxSize ?? r.batchSize ?? 20, SERVER_MAX_BATCH),
    flushMs: o.batch?.flushMs ?? r.flushMs ?? 2000,
    maxQueue: o.maxQueue ?? r.maxQueue ?? 200,
    autocapture: o.autocapture ?? r.autocapture ?? false,
    trackVideo: o.trackVideo ?? r.trackVideo ?? false,
  };
}

/** `/shop` matches the page and everything below it, `/blog/*` any path starting /blog/; no routes = every page. */
export function routeAllowed(routes: readonly string[], path: string): boolean {
  if (!routes.length) return true;
  return routes.some((r) => {
    if (r.endsWith('*')) return path.startsWith(r.slice(0, -1));
    const base = r.replace(/\/$/, '');
    return path === base || path.startsWith(`${base}/`);
  });
}

type Snap = { url: string; referrer: string; title: string; path: string };

export function createClient(opts: ClientOptions): Client {
  const cfg = resolveSettings(opts);
  const store = createStore(opts.storage ?? 'local');
  const listeners: Record<string, ((d: unknown) => void)[]> = {};
  const emit = (e: string, d?: unknown) => (listeners[e] ?? []).forEach((f) => f(d));
  let debugOn = opts.debug ?? false;
  // oxlint-disable-next-line no-console
  const log = (...a: unknown[]) => debugOn && console.debug('[hermetica]', ...a);
  let lastError: unknown = null;
  const fail = (e: unknown) => { lastError = e; emit('error', e); };
  const transport = createTransport(opts.endpoint, opts.siteKey, fail);

  // Reading a stored decision is fine; the decision itself is only written on an explicit update().
  const stored = ((): Consent | null => { try { return JSON.parse(store.get(KEY_CONSENT) ?? 'null'); } catch { return null; } })();
  const initialConsent = (): Consent => stored ?? (cfg.mode === 'require-consent' ? { analytics: false, marketing: false } : { analytics: true, marketing: true });
  let consent: Consent = initialConsent();
  let decided = stored !== null || cfg.mode !== 'require-consent';
  let explicit = false;
  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aid: string | null = null;
  let inflight: Promise<void> = Promise.resolve();
  // remoteConfig: calls made before the site settings arrive wait here (capped), then run with those settings.
  let ready = !opts.remoteConfig;
  const held: (() => void)[] = [];
  const whenReady = (fn: () => void) => { if (ready) fn(); else if (held.length < PRE_CONSENT_CAP) held.push(fn); };

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
  /** stripQuery / allowParams: query strings (and fragments) can carry tokens or emails; keep only the allowed params. */
  const cleanUrl = (u: string): string => {
    if (!cfg.stripQuery && !cfg.allowParams) return u;
    try {
      const x = new URL(u);
      const keep = new Set(cfg.allowParams ?? []);
      for (const k of Array.from(x.searchParams.keys())) if (!keep.has(k)) x.searchParams.delete(k);
      x.hash = '';
      return x.href;
    } catch { return u; }
  };
  const snap = (): Snap => ({ url: location.href, referrer: document.referrer, title: document.title, path: location.pathname });
  const pageCtx = (s: Snap) => ({ page: { url: cleanUrl(s.url), referrer: cleanUrl(s.referrer), title: s.title }, ...(Object.keys(landingUtm).length ? { utm: landingUtm } : {}) });

  function push(name: string, properties: Record<string, unknown>, extra: Partial<QueuedEvent>, s: Snap): void {
    if (decided && !consent.analytics) { log('dropped (analytics denied)', name); return; }
    if (!decided && !cfg.bufferUntilConsent) { log('dropped (consent not decided yet)', name); return; }
    let ev: QueuedEvent | null = { name, properties: { ...properties, hm_sdk: SDK_VERSION, ...(globalThis as { hmAd?: () => object }).hmAd?.() }, dedupeKey: uuid(), occurredAt: new Date().toISOString(), context: pageCtx(s), ...extra };
    if (opts.beforeSend) {
      try { ev = opts.beforeSend(ev); } catch (e) { fail(e); ev = null; } // a throwing hook drops the event: never send what it was meant to filter
      if (!ev) { log('dropped (beforeSend)', name); return; }
    }
    queue.push(ev);
    const cap = decided ? cfg.maxQueue : PRE_CONSENT_CAP;
    if (queue.length > cap) queue.splice(0, queue.length - cap); // drop oldest
    log('queued', ev);
    if (!decided) return;
    if (queue.length >= cfg.maxSize) void flush();
    else timer ??= setTimeout(() => void flush(), cfg.flushMs);
  }
  // The page is read when the call is made, so a call held for the settings still describes the page it came from.
  const enqueue = (name: string, properties: Record<string, unknown>, extra: Partial<QueuedEvent> = {}) => { const s = snap(); whenReady(() => push(name, properties, extra, s)); };

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!decided || !consent.analytics || queue.length === 0) return inflight;
    const id = anonymousId();
    const batch = queue.splice(0, cfg.maxSize).map((e) => ({ ...e, anonymousId: id }));
    inflight = inflight.then(async () => {
      const ok = await transport.send('/ingest/v1/batch', { events: batch, consent });
      if (ok) emit('flush', batch);
      else if (ok === false) { queue.unshift(...batch); queue.splice(0, queue.length - cfg.maxQueue); fail(new Error('send failed')); }
      // null = refused (4xx): already reported as `error`, dropped, never `flush`. Not awaited: the next batch chains behind this promise.
      if (ok !== false && queue.length) void flush();
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
  // Automatic page views follow the route allowlist; explicit page() calls are the site's own decision and always go.
  const autoPage = () => { const s = snap(); whenReady(() => { if (cfg.autoPageViews && routeAllowed(cfg.pageViewRoutes, s.path)) push('page_view', {}, {}, s); }); };
  if (opts.autoPageViews || (opts.remoteConfig && opts.autoPageViews !== false)) {
    autoPage();
    for (const m of ['pushState', 'replaceState'] as const) {
      const orig = history[m].bind(history);
      history[m] = (...a: Parameters<History['pushState']>) => { orig(...a); autoPage(); };
    }
    addEventListener('popstate', autoPage);
  }

  const startModules = () => {
    if (cfg.autocapture && typeof document !== 'undefined') startAutocapture((n, p) => enqueue(n, p));
    if (cfg.trackVideo && typeof document !== 'undefined') startVideoTracking((n, p) => enqueue(n, p));
  };

  const formDeps = () => ({ client: api, endpoint: opts.endpoint, siteKey: opts.siteKey, get: store.get, set: store.set, allowed: () => decided && consent.analytics });
  const forms = { start: async () => { if (opts.cart) await readPlatformCart(opts.cart, setCart); await Promise.all([startForms(formDeps()), startSiteMessages(formDeps())]); }, setCart };
  const api: Client = {
    forms,
    track: (name, props = {}, o = {}) => enqueue(name, props, { ...(o.value !== undefined ? { value: o.value } : {}), ...(o.currency ? { currency: o.currency } : {}), ...(o.dedupeKey ? { dedupeKey: o.dedupeKey } : {}) }),
    page,
    formView: (formId, versionId) => enqueue('form_view', { formId, ...(versionId ? { versionId } : {}) }),
    identify: (externalId, traits = {}, o = {}) => whenReady(() => {
      // The server also refuses identity without marketing consent; skipping here avoids storing an id we cannot use.
      if (!consent.marketing || (decided && !consent.analytics)) { log('identify skipped (no marketing consent)'); return; }
      const { email, phone, ...rest } = traits as { email?: string; phone?: string };
      // Identify rules: identifiers this site does not take from browsers are left out (the server refuses them too).
      const ids = { ...(externalId && cfg.identify.externalId ? { externalId } : {}), ...(email && cfg.identify.email ? { email } : {}), ...(phone && cfg.identify.phone ? { phone } : {}) };
      if (!Object.keys(ids).length) { log('identify skipped (identifiers not allowed for this site)'); return; }
      void inflight.then(() => transport.send('/ingest/v1/identify', { anonymousId: anonymousId(), identifiers: ids, traits: rest, consent, ...(o.signature ? { signature: o.signature } : {}) }));
    }),
    subscribe: (o) => transport.send('/ingest/v1/subscribe', { ...o, pageUrl: cleanUrl(location.href), anonymousId: api.anonymousId() ?? undefined }),
    backInStock: (o) => transport.send('/ingest/v1/back-in-stock', o),
    consent: {
      get: () => ({ ...consent }),
      update(c) {
        consent = { ...consent, ...c };
        decided = true;
        explicit = true;
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
    debug: {
      events: () => [...queue], lastError: () => lastError as ReturnType<Client['debug']['lastError']>, enable: () => { debugOn = true; }, disable: () => { debugOn = false; },
      test: (events) => transport.post('/ingest/v1/test', { events: events ?? (queue.length ? queue : [{ name: 'test_event', properties: { hm_sdk: SDK_VERSION }, context: pageCtx(snap()) }]), consent }),
    },
  };

  const settle = (r: Partial<RemoteSettings> | null) => {
    if (ready) return; // a late answer after the timeout is ignored: the defaults are already in force
    if (r) {
      Object.assign(cfg, resolveSettings(opts, r));
      // No decision yet: the site's consent mode sets the starting state (it was the SDK default until now).
      if (!explicit && stored === null) { consent = initialConsent(); decided = cfg.mode !== 'require-consent'; }
      log('settings', cfg);
    }
    ready = true;
    startModules();
    for (const f of held.splice(0)) f();
  };
  if (opts.remoteConfig) {
    setTimeout(() => settle(null), REMOTE_TIMEOUT_MS);
    void transport.get('/ingest/v1/config').then((r) => settle(r as Partial<RemoteSettings> | null), () => settle(null));
  } else startModules();
  if (opts.forms) void forms.start();
  return api;
}
