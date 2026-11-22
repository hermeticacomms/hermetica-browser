import { describe, expect, it, vi } from 'vitest';
import { type ChromeLike, createExtensionClient, relayTracking, trackFromContent } from './extension.ts';

/** chrome.storage.local backed by a Map that outlives a client, the way storage outlives a stopped service worker. */
function fakeChrome(data = new Map<string, unknown>()) {
  const listeners: ((m: unknown, s: { id?: string }) => void)[] = [];
  const pick = (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
  const chrome: ChromeLike = {
    storage: { local: {
      get: async (k) => pick(k),
      set: async (items) => { for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v)); },
      remove: async (k) => { for (const key of Array.isArray(k) ? k : [k]) data.delete(key); },
    } },
    runtime: {
      id: 'extabc', getManifest: () => ({ version: '1.2.0', name: 'Crossly' }),
      sendMessage: async (m) => { for (const l of listeners) l(m, { id: 'extabc' }); },
      onMessage: { addListener: (fn) => void listeners.push(fn) },
    },
  };
  return { chrome, data, deliver: (m: unknown, id: string) => { for (const l of listeners) l(m, { id }); } };
}

function server(status = 200) {
  const calls: { path: string; body: { events?: { name: string; anonymousId: string; dedupeKey: string; context: Record<string, unknown> }[]; identifiers?: unknown }; auth: string }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? "" });
    return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), { status });
  });
  return { f: f as unknown as typeof fetch, calls, mock: f };
}

describe('createExtensionClient', () => {
  it('sends nothing before consent, then batches events with the stored anonymous id and the extension context', async () => {
    const { chrome } = fakeChrome();
    const s = server();
    const hm = createExtensionClient({ siteKey: 'hm_pk_x', endpoint: 'https://api.test', chromeApi: chrome, fetch: s.f, flushMs: 5 });
    await hm.ready;
    await hm.track('opened_popup');
    expect(await hm.flush()).toBe(true);
    expect(s.calls).toHaveLength(0); // require-consent: dropped, never stored

    await hm.consent.update({ analytics: true });
    await hm.track('saved_item', { sku: 'A1' });
    await vi.waitFor(() => expect(s.calls).toHaveLength(1));
    const [c] = s.calls;
    expect(c).toMatchObject({ path: '/ingest/v1/batch', auth: 'Bearer hm_pk_x' });
    expect(c!.body.events![0]).toMatchObject({ name: 'saved_item', anonymousId: await hm.anonymousId(), context: { extension: { id: 'extabc', version: '1.2.0' } } });
  });

  it('keeps events across a stopped service worker and offline sends, without sending one twice', async () => {
    const { chrome, data } = fakeChrome();
    const down = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    const first = createExtensionClient({ siteKey: 'k', chromeApi: chrome, fetch: down, consentMode: 'none', flushMs: 60_000 });
    await first.ready;
    await first.track('a');
    await first.track('b');
    expect(await first.flush()).toBe(false);
    expect((data.get('hm_ext_queue') as unknown[]).length).toBe(2);

    // The worker restarts: a new client finds the queue and sends it once on start.
    const s = server();
    const second = createExtensionClient({ siteKey: 'k', chromeApi: chrome, fetch: s.f, consentMode: 'none' });
    await second.ready;
    await vi.waitFor(() => expect(s.calls).toHaveLength(1));
    expect(s.calls[0]!.body.events!.map((e) => e.name)).toEqual(['a', 'b']);
    expect(await second.flush()).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it('retries after 5xx and 429, drops a batch the server refused for good', async () => {
    const { chrome, data } = fakeChrome();
    const busy = server(503);
    const hm = createExtensionClient({ siteKey: 'k', chromeApi: chrome, fetch: busy.f, consentMode: 'none', flushMs: 60_000 });
    await hm.ready;
    await hm.track('a');
    expect(await hm.flush()).toBe(false);
    expect((data.get('hm_ext_queue') as unknown[]).length).toBe(1);
    const bad = server(400);
    const again = createExtensionClient({ siteKey: 'k', chromeApi: chrome, fetch: bad.f, consentMode: 'none', flushMs: 60_000 });
    await again.ready;
    expect(await again.flush()).toBe(true);
    expect(data.get('hm_ext_queue')).toEqual([]);
  });

  it('denying consent deletes the queue and the id; identify needs marketing consent', async () => {
    const { chrome, data } = fakeChrome();
    const s = server();
    const hm = createExtensionClient({ siteKey: 'k', chromeApi: chrome, fetch: s.f, flushMs: 60_000 });
    await hm.ready;
    await hm.consent.update({ analytics: true });
    await hm.identify('u1', { email: 'a@b.co' });
    expect(s.calls.filter((c) => c.path === '/ingest/v1/identify')).toHaveLength(0);
    await hm.consent.update({ marketing: true });
    await hm.identify('u1', { email: 'a@b.co' });
    expect(s.calls.find((c) => c.path === '/ingest/v1/identify')!.body.identifiers).toEqual({ externalId: 'u1', email: 'a@b.co' });

    s.mock.mockImplementation(async () => { throw new TypeError('offline'); });
    await hm.track('x');
    await hm.consent.update({ analytics: false });
    expect([data.has('hm_ext_queue'), data.has('hm_ext_aid')]).toEqual([false, false]);
    // a restart remembers the denial
    const again = createExtensionClient({ siteKey: 'k', chromeApi: chrome, fetch: s.f });
    await again.ready;
    expect(again.consent.get()).toEqual({ analytics: false, marketing: true });
  });

  it('relays events from this extension\'s content scripts only', async () => {
    const { chrome, deliver } = fakeChrome();
    const s = server();
    const hm = createExtensionClient({ siteKey: 'k', chromeApi: chrome, fetch: s.f, consentMode: 'none', flushMs: 60_000 });
    await hm.ready;
    relayTracking(hm, chrome);
    await trackFromContent('clicked_buy', { page: 'ebay' }, chrome);
    deliver({ type: 'hermetica:track', name: 'spoofed' }, 'otherextension');
    await vi.waitFor(async () => expect(await hm.flush()).toBe(true));
    expect(s.calls.flatMap((c) => c.body.events!.map((e) => e.name))).toEqual(['clicked_buy']);
  });
});
