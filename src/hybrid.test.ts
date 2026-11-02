// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHybridClient } from './hybrid.ts';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const server = () => {
  const f = vi.fn(async (url: string) => new Response(url.includes('/client/in-app-messages') ? '{"items":[]}' : '{}', { status: 200 }));
  vi.stubGlobal('fetch', f);
  const calls = () => (f.mock.calls as unknown as [string, RequestInit?][]).map(([u, i]) => ({ path: new URL(u).pathname, url: new URL(u), body: i?.body ? JSON.parse(i.body as string) : null }));
  return { f, calls };
};

describe('createHybridClient', () => {
  it('asks for messages of the app platform and moves the push token to the identified profile', async () => {
    const { calls } = server();
    const hm = createHybridClient({ siteKey: 'pk', endpoint: 'https://api.test', platform: 'ios', consentMode: 'none' });
    await vi.waitFor(() => expect(calls().some((c) => c.path === '/client/in-app-messages')).toBe(true));
    const open = calls().find((c) => c.path === '/client/in-app-messages')!;
    expect(open.url.searchParams.get('platform')).toBe('ios');
    expect(open.url.searchParams.get('trigger')).toBe('app_open');

    expect(await hm.setPushToken({ token: 'apns-1', vendor: 'apns' })).toBe(true);
    hm.identify('user-1', { email: 'a@b.co' });
    await vi.waitFor(() => expect(calls().filter((c) => c.path === '/client/push-tokens')).toHaveLength(2));
    const last = calls().filter((c) => c.path === '/client/push-tokens').at(-1)!;
    expect(last.body.data.attributes.profile.data.attributes).toMatchObject({ external_id: 'user-1', email: 'a@b.co' });

    expect(await hm.unregisterPushToken()).toBe(true);
    hm.reset();
    expect(calls().filter((c) => c.path === '/client/push-tokens')).toHaveLength(2); // unregistered: nothing follows the reset
  });

  it('hands push deep links to onDeepLink', () => {
    server();
    const links: string[] = [];
    const hm = createHybridClient({ siteKey: 'pk', endpoint: 'https://api.test', platform: 'android', consentMode: 'none', inApp: false, onDeepLink: (l) => links.push(l) });
    expect(hm.handlePushOpened({ data: { hermetica_message_id: 'm1', deep_link: 'shop://x' } })).toBe('shop://x');
    expect(links).toEqual(['shop://x']);
    expect(hm.debug.events().map((e) => e.name)).toEqual(['$opened_push']);
  });
});
