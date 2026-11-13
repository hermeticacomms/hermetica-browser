// @vitest-environment happy-dom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, resolveSettings, routeAllowed } from './client.ts';

const sent: { url: string; body: any; auth: string; key: string | undefined }[] = [];
let status = 200;
const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  sent.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization!, key: (init.headers as Record<string, string>)['idempotency-key'] });
  return new Response('{}', { status });
});
const mk = (o: Partial<Parameters<typeof createClient>[0]> = {}) =>
  createClient({ siteKey: 'hm_pk_x', endpoint: 'https://api.test', storage: 'memory', batch: { flushMs: 10 }, ...o });

beforeEach(() => { sent.length = 0; status = 200; vi.stubGlobal('fetch', fetchMock); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('formView', () => {
  it('emits form_view with formId and versionId (consent-gated like any event)', async () => {
    const c = mk();
    c.consent.update({ analytics: true });
    c.formView('f1', 'v1');
    c.formView('f2');
    await c.flush();
    expect(sent[0]!.body.events.map((e: any) => [e.name, e.properties])).toEqual([['form_view', expect.objectContaining({ formId: 'f1', versionId: 'v1' })], ['form_view', expect.objectContaining({ formId: 'f2' })]]);
  });
});

describe('consent gating (scenario 9, client side)', () => {
  it('drops events tracked before the consent decision by default (audit item 13)', async () => {
    const c = mk({ storage: 'local' });
    c.track('a'); c.page();
    expect(c.debug.events()).toHaveLength(0);
    c.consent.update({ analytics: true });
    c.track('b');
    await c.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.events.map((e: any) => e.name)).toEqual(['b']);
  });

  it('bufferUntilConsent: sends nothing and writes no storage before consent; flushes after grant', async () => {
    const c = mk({ storage: 'local', bufferUntilConsent: true });
    c.track('a'); c.page();
    await c.flush();
    expect(sent).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    c.consent.update({ analytics: true });
    await c.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.events.map((e: any) => e.name)).toEqual(['a', 'page_view']);
    expect(sent[0]!.body.consent).toEqual({ analytics: true, marketing: false });
    expect(sent[0]!.auth).toBe('Bearer hm_pk_x');
    expect(localStorage.getItem('hm_aid')).toBe(sent[0]!.body.events[0].anonymousId);
  });

  it('drops queued events when consent is denied', async () => {
    const c = mk({ bufferUntilConsent: true });
    c.track('a');
    c.consent.update({ analytics: false });
    c.track('b');
    await c.flush();
    expect(sent).toHaveLength(0);
    expect(c.debug.events()).toHaveLength(0);
  });

  it('caps the pre-consent queue at 50, dropping the oldest', () => {
    const c = mk({ bufferUntilConsent: true });
    for (let i = 0; i < 60; i++) c.track(`e${i}`);
    expect(c.debug.events()).toHaveLength(50);
    expect(c.debug.events()[0]!.name).toBe('e10');
  });

  it('opt-out and none modes track immediately; identify needs marketing consent', async () => {
    const c = mk({ consentMode: 'opt-out' });
    c.track('a');
    await c.flush();
    expect(sent).toHaveLength(1);
    const d = mk();
    d.consent.update({ analytics: true });
    d.identify('u1', { email: 'a@b.co' });
    await d.flush();
    expect(sent.some((s) => s.url.endsWith('/identify'))).toBe(false);
    d.consent.update({ marketing: true });
    d.identify('u1', { email: 'a@b.co', plan: 'pro' });
    await new Promise((r) => setTimeout(r, 0));
    const id = sent.find((s) => s.url.endsWith('/identify'))!;
    expect(id.body.identifiers).toEqual({ externalId: 'u1', email: 'a@b.co' });
    expect(id.body.traits).toEqual({ plan: 'pro' });
  });
});

describe('batching, retry, beacon, reset', () => {
  it('flushes when the batch is full and gives every event a dedupe key', async () => {
    const c = mk({ consentMode: 'none', batch: { maxSize: 3, flushMs: 60_000 } });
    for (let i = 0; i < 3; i++) c.track(`e${i}`);
    await c.flush();
    expect(sent).toHaveLength(1);
    expect(new Set(sent[0]!.body.events.map((e: any) => e.dedupeKey)).size).toBe(3);
  });

  it('retries 5xx with backoff then re-queues', async () => {
    vi.useFakeTimers();
    status = 503;
    const c = mk({ consentMode: 'none' });
    c.track('a');
    const p = c.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1); // every retry of the batch carries the same Idempotency-Key
    expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.debug.events()).toHaveLength(1);
  });

  it('gives each batch its own Idempotency-Key', async () => {
    const c = mk({ consentMode: 'none' });
    c.track('a');
    await c.flush();
    c.track('b');
    await c.flush();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.key).not.toBe(sent[1]!.key);
  });

  it('does not retry 4xx, emits error with the status and keeps it in debug.lastError()', async () => {
    const c = mk({ consentMode: 'none' });
    const errors: any[] = [];
    c.on('error', (e) => errors.push(e));
    const flushed: any[] = [];
    c.on('flush', (b) => flushed.push(b));
    expect(c.debug.lastError()).toBeNull();
    for (const code of [401, 403]) {
      status = code;
      fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(init.body as string), auth: '', key: undefined });
        return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Origin not allowed' } }), { status: code });
      });
      c.track('a');
      await c.flush();
    }
    expect(sent).toHaveLength(2);
    expect(errors.map((e) => e.status)).toEqual([401, 403]); // only the refusal: no extra 'send failed'
    expect(flushed).toHaveLength(0); // a refused batch is never reported as delivered
    expect(c.debug.lastError()).toMatchObject({ status: 403, code: 'forbidden', message: 'Origin not allowed' });
    expect(c.debug.events()).toHaveLength(0);
  });

  it('uses sendBeacon on pagehide', () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const c = mk({ consentMode: 'none' });
    c.track('a');
    dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalled(); // earlier tests' clients also listen on the shared window
    expect(String((beacon.mock.calls[0] as unknown[])[0])).toContain('/ingest/v1/batch?k=hm_pk_x');
    expect(c.debug.events()).toHaveLength(0);
  });

  it('captures utm on landing and reset clears id + queue', async () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://shop.test/?utm_source=ad&utm_campaign=x');
    const c = mk({ consentMode: 'none', storage: 'local' });
    c.track('a');
    expect(c.debug.events()[0]!.context).toMatchObject({ utm: { source: 'ad', campaign: 'x' } });
    await c.flush();
    expect(localStorage.getItem('hm_aid')).not.toBeNull();
    c.track('b');
    c.reset();
    expect(localStorage.getItem('hm_aid')).toBeNull();
    expect(c.debug.events()).toHaveLength(0);
  });

  it('auto page views patch history for SPAs', () => {
    const c = mk({ consentMode: 'none', autoPageViews: true });
    history.pushState({}, '', '/next');
    expect(c.debug.events().map((e) => e.name)).toEqual(['page_view', 'page_view']);
  });
});

describe('beforeSend and URL filtering (audit item 14)', () => {
  it('beforeSend can change or drop an event; a throwing hook drops it and reports the error', async () => {
    let n = 0;
    const c = mk({ consentMode: 'none', beforeSend: (e) => { n++; if (e.name === 'secret') return null; if (e.name === 'boom') throw new Error('hook'); return { ...e, properties: { ...e.properties, tagged: true } }; } });
    c.track('secret'); c.track('boom'); c.track('ok');
    expect(n).toBe(3);
    expect(c.debug.events().map((e) => [e.name, e.properties.tagged])).toEqual([['ok', true]]);
    expect(c.debug.lastError()).toMatchObject({ message: 'hook' });
  });

  it('stripQuery drops query and fragment; allowParams keeps only the listed params', () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://shop.test/reset?token=abc&email=a%40b.co&ref=x#frag');
    const strip = mk({ consentMode: 'none', stripQuery: true });
    strip.track('a');
    expect(strip.debug.events()[0]!.context).toMatchObject({ page: { url: 'https://shop.test/reset' } });
    const allow = mk({ consentMode: 'none', allowParams: ['ref'] });
    allow.track('a');
    expect(allow.debug.events()[0]!.context).toMatchObject({ page: { url: 'https://shop.test/reset?ref=x' } });
    const raw = mk({ consentMode: 'none' });
    raw.track('a');
    expect((raw.debug.events()[0]!.context as any).page.url).toContain('token=abc');
  });
});

describe('site settings (remoteConfig) and route allowlist', () => {
  const remote = (settings: Record<string, unknown> | null) => {
    const posts: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return settings ? new Response(JSON.stringify(settings), { status: 200 }) : new Response('{}', { status: 500 });
      posts.push({ url, body: JSON.parse(init.body as string) });
      return new Response('{"ok":true}', { status: 200 });
    }));
    return posts;
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('routeAllowed: empty = all; /shop is the page and below; /blog/* is a prefix', () => {
    expect(routeAllowed([], '/x')).toBe(true);
    expect(routeAllowed(['/shop'], '/shop')).toBe(true);
    expect(routeAllowed(['/shop'], '/shop/boots')).toBe(true);
    expect(routeAllowed(['/shop'], '/shopping')).toBe(false);
    expect(routeAllowed(['/blog/*'], '/blog/a')).toBe(true);
    expect(routeAllowed(['/blog/*'], '/about')).toBe(false);
  });

  it('resolveSettings: without saved settings the SDK defaults are unchanged; code options win over saved ones', () => {
    const d = resolveSettings({ siteKey: 'k', endpoint: 'e' });
    expect(d).toMatchObject({ mode: 'require-consent', maxSize: 20, flushMs: 2000, maxQueue: 200, autoPageViews: false, stripQuery: false, allowParams: undefined });
    const r = resolveSettings({ siteKey: 'k', endpoint: 'e', batch: { maxSize: 5 } }, { batchSize: 40, flushMs: 500, consentMode: 'opt-out', allowParams: [] });
    expect(r).toMatchObject({ maxSize: 5, flushMs: 500, mode: 'opt-out', allowParams: undefined });
  });

  it('holds calls until the settings arrive, then applies consent mode, URL rules and identify rules', async () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://shop.test/shop/boots?token=abc&ref=x');
    const posts = remote({ consentMode: 'none', autoPageViews: true, pageViewRoutes: ['/shop'], stripQuery: true, allowParams: ['ref'], identify: { email: false, phone: true, externalId: true }, batchSize: 20, flushMs: 10, maxQueue: 200 });
    const c = createClient({ siteKey: 'hm_pk_x', endpoint: 'https://api.test', storage: 'memory', remoteConfig: true });
    c.track('early');
    expect(c.debug.events()).toHaveLength(0); // waiting for the settings
    await settle(); await settle();
    expect(c.debug.events().map((e) => e.name)).toEqual(['page_view', 'early']);
    expect(c.debug.events()[0]!.context).toMatchObject({ page: { url: 'https://shop.test/shop/boots?ref=x' } });
    history.pushState({}, '', '/about'); // outside the route allowlist: no automatic page view
    expect(c.debug.events()).toHaveLength(2);
    c.identify('u1', { email: 'a@b.co' });
    await c.flush(); await settle();
    const id = posts.find((p) => p.url.endsWith('/ingest/v1/identify'));
    expect(id!.body.identifiers).toEqual({ externalId: 'u1' });
  });

  it('falls back to the safe defaults when the settings cannot be read', async () => {
    remote(null);
    const c = createClient({ siteKey: 'hm_pk_x', endpoint: 'https://api.test', storage: 'memory', remoteConfig: true });
    c.track('a');
    await settle(); await settle();
    expect(c.debug.events()).toHaveLength(0); // require-consent default: dropped before a decision
  });

  it('debug.test posts the queue to the test endpoint', async () => {
    const posts = remote({});
    const c = mk({ consentMode: 'none' });
    c.track('a');
    expect(await c.debug.test()).toEqual({ ok: true });
    expect(posts[0]!.url).toBe('https://api.test/ingest/v1/test');
    expect(posts[0]!.body.events[0].name).toBe('a');
  });
});

describe('queue survives a reload (localStorage, per site)', () => {
  const KEY = 'hm_queue:hm_pk_reload';
  const local = (o: Partial<Parameters<typeof createClient>[0]> = {}) => mk({ siteKey: 'hm_pk_reload', storage: 'local', consentMode: 'opt-out', batch: { flushMs: 10_000 }, ...o });

  it('keeps unsent consented events and sends them once on the next page', async () => {
    const first = local();
    first.track('a'); first.track('b');
    expect(JSON.parse(localStorage.getItem(KEY)!).map((e: any) => e.name)).toEqual(['a', 'b']);
    const second = local(); // the reload: a fresh client reads what the first left
    await second.flush();
    expect(sent.map((s) => s.body.events.map((e: any) => e.name))).toEqual([['a', 'b']]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a failed send stays saved; duplicate dedupeKeys are restored once; corrupt data is ignored', async () => {
    status = 400; // refused for good: dropped, not saved
    const c = local();
    c.track('x');
    await c.flush();
    expect(localStorage.getItem(KEY)).toBeNull();
    status = 200;
    const ev = { name: 'y', properties: {}, dedupeKey: 'k1', occurredAt: new Date().toISOString(), context: {} };
    localStorage.setItem(KEY, JSON.stringify([ev, ev, { bogus: true }]));
    sent.length = 0;
    await local().flush();
    expect(sent[0]!.body.events.map((e: any) => e.dedupeKey)).toEqual(['k1']);
    localStorage.setItem(KEY, '{not json');
    expect(() => local()).not.toThrow();
  });

  it('never saves events without analytics consent, and denying consent clears what was saved', () => {
    const pending = mk({ siteKey: 'hm_pk_reload', storage: 'local', bufferUntilConsent: true });
    pending.track('before');
    expect(localStorage.getItem(KEY)).toBeNull();
    const c = local();
    c.track('a');
    expect(localStorage.getItem(KEY)).not.toBeNull();
    c.consent.update({ analytics: false });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('cookie and memory storage never persist the queue', () => {
    local({ storage: 'memory' }).track('a');
    local({ storage: 'cookie' }).track('b');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('events a beacon could not take on pagehide are saved for the next page', () => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
    const c = local();
    c.track('leaving');
    dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(localStorage.getItem(KEY)!).map((e: any) => e.name)).toEqual(['leaving']);
  });
});
