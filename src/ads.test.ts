// @vitest-environment happy-dom
/// <reference lib="dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { AD_TTL_MS, enableAdTracking, mergeAdIds, readAdIds } from './ads.ts';

const hook = () => (globalThis as { hmAd?: () => { $ad: Record<string, string> } }).hmAd;

describe('readAdIds', () => {
  it('reads URL ids and utm, and builds fbc from fbclid', () => {
    const ids = readAdIds('https://s.test/?fbclid=F1&ScCid=S1&gclid=G1&utm_source=ig&x=1', '', 1700);
    expect(ids).toEqual({ fbclid: 'F1', scclid: 'S1', gclid: 'G1', utm_source: 'ig', fbc: 'fb.1.1700.F1' });
  });
  it('prefers the _fbc cookie and reads the other ad cookies', () => {
    const ids = readAdIds('https://s.test/?fbclid=F1', '_fbc=fb.1.5.OLD; _fbp=fb.1.6.7; _ttp=T; _scid=SC; _epik=E; _gcl_aw=GCL.9.G2', 1700);
    expect(ids).toMatchObject({ fbc: 'fb.1.5.OLD', fbp: 'fb.1.6.7', ttp: 'T', sccookie1: 'SC', epik: 'E', gclid: 'G2' });
  });
  it('ignores prototype names', () => expect(readAdIds('https://s.test/?constructor=1', 'toString=1', 1)).toEqual({}));
});

describe('mergeAdIds', () => {
  it('stamps new ids and expires old ones after 90 days', () => {
    const saved = { gclid: ['old', 0], fbp: ['keep', 1000] } as Record<string, [string, number]>;
    const out = mergeAdIds(saved, { ttclid: 'T' }, AD_TTL_MS + 500);
    expect(out).toEqual({ fbp: ['keep', 1000], ttclid: ['T', AD_TTL_MS + 500] });
  });
});

describe('enableAdTracking', () => {
  afterEach(() => { enableAdTracking(false); localStorage.clear(); });
  it('is off by default, captures when enabled and clears when disabled', () => {
    expect(hook()).toBeUndefined();
    document.cookie = '_fbp=fb.1.1.2';
    expect(enableAdTracking(true)).toBe(true);
    expect(hook()!().$ad).toMatchObject({ fbp: 'fb.1.1.2', client_user_agent: navigator.userAgent });
    expect(localStorage.getItem('hm_ad')).toContain('fb.1.1.2');
    enableAdTracking(false);
    expect(hook()).toBeUndefined();
    expect(localStorage.getItem('hm_ad')).toBeNull();
  });
  it('honours Global Privacy Control', () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    expect(enableAdTracking(true)).toBe(false);
    expect(hook()).toBeUndefined();
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true });
  });
});
