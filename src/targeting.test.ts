// @vitest-environment happy-dom
/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import { eligible, type Flags, isProductPage, needsFlags, type Visit } from './targeting.ts';

const v = (over: Partial<Visit> = {}): Visit => ({ path: '/', mobile: false, returning: false, pageViews: 1, now: 0, ...over });
const flags = (over: Partial<Flags> = {}): Flags => ({ known: true, subscriber: false, lists: {}, segments: {}, countries: {}, ...over });

describe('eligible: audience, country, utm, referrer, cart, product page', () => {
  it('shows only to members of a targeted list, and hides from them in hide mode', () => {
    const t = { audience: { mode: 'show' as const, listIds: ['L1'] } };
    expect(needsFlags(t)).toBe(true);
    expect(eligible(t, v({ flags: flags({ lists: { L1: true } }) }))).toBe(true);
    expect(eligible(t, v({ flags: flags({ lists: { L1: false } }) }))).toBe(false);
    expect(eligible(t, v())).toBe(false); // flags missing: closed
    expect(eligible({ audience: { mode: 'hide', segmentIds: ['S1'] } }, v({ flags: flags({ segments: { S1: true } }) }))).toBe(false);
  });
  it('hides from known subscribers, and stays hidden while flags are unknown', () => {
    const t = { hideKnownSubscribers: true };
    expect(eligible(t, v({ flags: flags({ subscriber: true }) }))).toBe(false);
    expect(eligible(t, v({ flags: flags({ subscriber: false }) }))).toBe(true);
    expect(eligible(t, v())).toBe(false);
  });
  it('matches countries and exclusions', () => {
    expect(eligible({ countries: ['FR'] }, v({ flags: flags({ countries: { FR: true } }) }))).toBe(true);
    expect(eligible({ countries: ['FR'] }, v({ flags: flags({ countries: { FR: false } }) }))).toBe(false);
    expect(eligible({ countriesExclude: ['DE'] }, v({ flags: flags({ countries: { DE: true } }) }))).toBe(false);
  });
  it('matches utm values case-insensitively and referrer globs', () => {
    expect(eligible({ utm: { source: 'News' } }, v({ utm: { source: 'news' } }))).toBe(true);
    expect(eligible({ utm: { source: 'news' } }, v({ utm: {} }))).toBe(false);
    expect(eligible({ referrerInclude: ['*.google.com'] }, v({ referrer: 'www.google.com' }))).toBe(true);
    expect(eligible({ referrerInclude: ['*.google.com'] }, v({ referrer: '' }))).toBe(false);
  });
  it('applies cart rules (an unreported cart is empty)', () => {
    expect(eligible({ cart: { minValue: 50 } }, v({ cart: { value: 60, items: 2 } }))).toBe(true);
    expect(eligible({ cart: { minValue: 50 } }, v())).toBe(false);
    expect(eligible({ cart: { empty: true } }, v())).toBe(true);
    expect(eligible({ cart: { empty: false, minItems: 2 } }, v({ cart: { value: 5, items: 1 } }))).toBe(false);
  });
  it('applies product-page rules', () => {
    expect(eligible({ productPage: 'only' }, v({ productPage: false }))).toBe(false);
    expect(eligible({ productPage: 'never' }, v({ productPage: true }))).toBe(false);
    expect(eligible({ productPage: 'only' }, v({ productPage: true }))).toBe(true);
  });
});

describe('isProductPage', () => {
  it('detects og:type product and JSON-LD Product', () => {
    document.head.innerHTML = '<meta property="og:type" content="product">';
    expect(isProductPage(document)).toBe(true);
    document.head.innerHTML = '<script type="application/ld+json">{"@type": "Product"}</script>';
    expect(isProductPage(document)).toBe(true);
    document.head.innerHTML = '';
    expect(isProductPage(document)).toBe(false);
  });
});
