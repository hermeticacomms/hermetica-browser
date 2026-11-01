// @vitest-environment happy-dom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client.ts';

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
  it('sends nothing and writes no storage before consent; flushes after grant', async () => {
    const c = mk({ storage: 'local' });
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
    const c = mk();
    c.track('a');
    c.consent.update({ analytics: false });
    c.track('b');
    await c.flush();
    expect(sent).toHaveLength(0);
    expect(c.debug.events()).toHaveLength(0);
  });

  it('caps the pre-consent queue at 50, dropping the oldest', () => {
    const c = mk();
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

  it('does not retry 4xx', async () => {
    status = 403;
    const c = mk({ consentMode: 'none' });
    c.track('a');
    await c.flush();
    expect(sent).toHaveLength(1);
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
