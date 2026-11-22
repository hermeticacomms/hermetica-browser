/**
 * `@hermeticor/sdk-browser/extension`: Hermeticor in a browser extension (Chrome, Edge, Firefox; Manifest V3).
 * Runs in the background service worker, a popup or an options page: no DOM, no localStorage, no beacons. The anonymous id,
 * consent and every unsent event live in `chrome.storage.local`, so a service worker that the browser stops after 30 s idle
 * loses nothing: the queue is sent on the next wake. Needs a publishable key whose allowedOrigins list `chrome-extension://<id>`.
 */
import { type ChromeLike, chromeOf, uuid } from './extension-chrome.ts';

export type { ChromeLike } from './extension-chrome.ts';

const SDK_VERSION = 'ext-0.4.15';
const KEY_ID = 'hm_ext_aid';
const KEY_CONSENT = 'hm_ext_consent';
const KEY_QUEUE = 'hm_ext_queue';
/** Events kept while offline; the oldest go first beyond this. */
const MAX_QUEUE = 1000;
const BATCH = 100;

export interface Consent { analytics: boolean; marketing: boolean }
export interface ExtensionEvent { name: string; properties: Record<string, unknown>; dedupeKey: string; occurredAt: string; value?: number; currency?: string; context: Record<string, unknown> }

export interface ExtensionOptions {
  /** Publishable key (`hm_pk_...`) listing this extension's origin, `chrome-extension://<id>`. */
  siteKey: string;
  endpoint?: string;
  /** require-consent (default): nothing is stored or sent until `consent.update({ analytics: true })`. none: always on. */
  consentMode?: 'require-consent' | 'none';
  /** Delay before a batch is sent (ms). Default 2000. */
  flushMs?: number;
  /** For tests, or `browser` on Firefox. Default `globalThis.chrome`. */
  chromeApi?: ChromeLike;
  fetch?: typeof fetch;
}

export interface ExtensionClient {
  /** Resolves once the stored id, consent and queue are loaded and any events left from a previous run are sent. */
  ready: Promise<void>;
  track(name: string, properties?: Record<string, unknown>, o?: { dedupeKey?: string; value?: number; currency?: string }): Promise<void>;
  /** Attaches this install to a person. Needs marketing consent (the server refuses identity without it). */
  identify(externalId: string | null, traits?: { email?: string; phone?: string } & Record<string, unknown>): Promise<void>;
  consent: { get(): Consent; update(c: Partial<Consent>): Promise<void> };
  anonymousId(): Promise<string | null>;
  /** Sends what is queued now. True when the queue is empty afterwards. */
  flush(): Promise<boolean>;
  /** Forgets the anonymous id, consent and queue (sign-out, uninstall flows). */
  reset(): Promise<void>;
}

export function createExtensionClient(o: ExtensionOptions): ExtensionClient {
  const chrome = chromeOf(o.chromeApi);
  const store = chrome.storage.local;
  const base = (o.endpoint ?? 'https://hermeticor.com').replace(/\/$/, '');
  const send = o.fetch ?? fetch;
  const required = (o.consentMode ?? 'require-consent') === 'require-consent';
  let consent: Consent = required ? { analytics: false, marketing: false } : { analytics: true, marketing: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One operation at a time: storage reads and writes of the queue never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };

  const readQueue = async () => ((await store.get(KEY_QUEUE))[KEY_QUEUE] as ExtensionEvent[] | undefined) ?? [];
  const writeQueue = (q: ExtensionEvent[]) => store.set({ [KEY_QUEUE]: q.slice(-MAX_QUEUE) });
  const id = async (create: boolean): Promise<string | null> => {
    const got = (await store.get(KEY_ID))[KEY_ID];
    if (typeof got === 'string') return got;
    if (!create) return null;
    const fresh = uuid();
    await store.set({ [KEY_ID]: fresh });
    return fresh;
  };
  const context = () => {
    const m = chrome.runtime?.getManifest?.();
    return { library: { name: 'hermetica-extension', version: SDK_VERSION }, extension: { id: chrome.runtime?.id, version: m?.version, name: m?.name } };
  };
  const post = (path: string, body: unknown) => send(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.siteKey}` }, body: JSON.stringify(body),
  });
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, o.flushMs ?? 2000); };

  const flush = () => serial(async () => {
    let q = await readQueue();
    while (q.length && consent.analytics) {
      const batch = q.slice(0, BATCH);
      const anonymousId = await id(true);
      let res: Response;
      try { res = await post('/ingest/v1/batch', { events: batch.map((e) => ({ ...e, anonymousId })), consent }); } catch { return false; } // offline: kept for the next wake
      // 429 and 5xx: try again later. Other answers (accepted, rejected per event, or a 4xx on the whole batch) are final.
      if (res.status === 429 || res.status >= 500) return false;
      const sent = new Set(batch.map((e) => e.dedupeKey));
      q = (await readQueue()).filter((e) => !sent.has(e.dedupeKey));
      await writeQueue(q);
    }
    return q.length === 0;
  });

  const ready = serial(async () => {
    const c = (await store.get(KEY_CONSENT))[KEY_CONSENT] as Consent | undefined;
    if (c && required) consent = c;
  }).then(() => void flush());

  return {
    ready,
    track: (name, properties = {}, t = {}) => serial(async () => {
      if (!consent.analytics) return; // before consent nothing is stored, as in the page SDK
      const ev: ExtensionEvent = {
        name, properties: { ...properties, hm_sdk: SDK_VERSION }, dedupeKey: t.dedupeKey ?? uuid(), occurredAt: new Date().toISOString(), context: context(),
        ...(t.value !== undefined ? { value: t.value } : {}), ...(t.currency ? { currency: t.currency } : {}),
      };
      await writeQueue([...(await readQueue()), ev]);
    }).then(schedule),
    identify: (externalId, traits = {}) => serial(async () => {
      if (!consent.marketing || !consent.analytics) return;
      const { email, phone, ...rest } = traits;
      const identifiers = { ...(externalId ? { externalId } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
      if (!Object.keys(identifiers).length) return;
      await post('/ingest/v1/identify', { anonymousId: await id(true), identifiers, traits: rest, consent }).catch(() => undefined);
    }),
    consent: {
      get: () => ({ ...consent }),
      update: (c) => serial(async () => {
        consent = { ...consent, ...c };
        await store.set({ [KEY_CONSENT]: consent });
        if (!consent.analytics) await store.remove([KEY_QUEUE, KEY_ID]); // denied: queued events and the id go, never sent
      }).then(() => { if (consent.analytics) void flush(); }),
    },
    anonymousId: () => serial(() => id(false)),
    flush,
    reset: () => serial(() => store.remove([KEY_ID, KEY_CONSENT, KEY_QUEUE])).then(() => { consent = required ? { analytics: false, marketing: false } : { analytics: true, marketing: true }; }),
  };
}

const RELAY = 'hermetica:track';
interface RelayMessage { type: typeof RELAY; name: string; properties?: Record<string, unknown> }

/**
 * Background service worker: take events from this extension's content scripts and pages. Content scripts run in the web page,
 * so their own requests would carry the page's origin (which the key refuses); they hand events to the background instead.
 */
export function relayTracking(client: ExtensionClient, chromeApi?: ChromeLike): void {
  const chrome = chromeOf(chromeApi);
  chrome.runtime?.onMessage?.addListener((m, sender) => {
    const msg = m as Partial<RelayMessage> | null;
    if (msg?.type !== RELAY || typeof msg.name !== 'string' || sender.id !== chrome.runtime?.id) return; // only this extension's own scripts
    void client.track(msg.name, msg.properties ?? {});
  });
}

/** Content script or popup: send an event through the background (which called relayTracking). Needs no key. */
export async function trackFromContent(name: string, properties: Record<string, unknown> = {}, chromeApi?: ChromeLike): Promise<void> {
  const chrome = chromeOf(chromeApi);
  await chrome.runtime?.sendMessage?.({ type: RELAY, name, properties } satisfies RelayMessage);
}
