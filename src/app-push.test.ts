import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppPush, pushData, type AppPushOptions } from './app-push.ts';

const opts = (track = vi.fn()): AppPushOptions => ({
  siteKey: 'pk', endpoint: 'https://api.test/', platform: 'android', track, retryMs: 0,
  identity: () => ({ email: 'a@b.co', anonymousId: 'anon-1' }), device: { appName: 'shop', osVersion: '15' },
});
const reply = (...statuses: number[]) => {
  const f = vi.fn(async () => new Response('{}', { status: statuses.shift() ?? 200 }));
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());

describe('createAppPush', () => {
  it('registers the token as the push-token JSON:API body, retrying 5xx with one idempotency key', async () => {
    const f = reply(503, 200);
    expect(await createAppPush(opts()).register({ token: 'tok', vendor: 'fcm', enablementStatus: 'DENIED' })).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    const calls = f.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe('https://api.test/client/push-tokens?company_id=pk');
    const keys = calls.map(([, i]) => (i.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    const a = JSON.parse(calls[0]![1].body as string).data.attributes;
    expect(a).toMatchObject({ token: 'tok', platform: 'android', vendor: 'fcm', enablement_status: 'DENIED', background: 'AVAILABLE' });
    expect(a.device_metadata).toMatchObject({ device_id: 'anon-1', app_name: 'shop', os_name: 'android', os_version: '15', environment: 'release' });
    expect(a.profile.data.attributes).toEqual({ email: 'a@b.co', anonymous_id: 'anon-1' });
  });

  it('does not retry a 4xx, and reports it as a failure', async () => {
    const f = reply(400, 200);
    expect(await createAppPush(opts()).unregister({ token: 'tok', vendor: 'apns' })).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('tracks opens and deliveries of Hermetica messages and returns the deep link', () => {
    const track = vi.fn();
    const push = createAppPush(opts(track));
    expect(push.opened({ notification: { data: { hermetica_message_id: 'm1', deep_link: 'shop://sale' } } })).toBe('shop://sale');
    expect(push.received({ additionalData: { hermetica_message_id: 'm1' } })).toBe(true);
    expect(push.received({ data: { other: 1 } })).toBe(false);
    expect(track.mock.calls).toEqual([['$opened_push', { hermetica_message_id: 'm1' }], ['$received_push', { hermetica_message_id: 'm1' }]]);
  });

  it('reads data from the shapes push plugins use', () => {
    expect(pushData({ userInfo: { a: 1 } })).toMatchObject({ a: 1 });
    expect(pushData({ notification: { additionalData: { b: 2 } } })).toMatchObject({ b: 2 });
    expect(pushData('x')).toEqual({});
  });
});
