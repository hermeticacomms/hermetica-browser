import { describe, expect, it } from 'vitest';
import { fromShopifyCart, readPlatformCart } from './cart.ts';

describe('Shopify cart connector', () => {
  it('maps /cart.js (minor units) to the cart rules shape and ignores anything else', () => {
    expect(fromShopifyCart({ total_price: 12950, item_count: 3, items: [] })).toEqual({ value: 129.5, items: 3 });
    expect(fromShopifyCart({ total: 1 })).toBeNull();
    expect(fromShopifyCart(null)).toBeNull();
  });
  it('reports the cart it reads, and nothing when the request fails', async () => {
    const got: unknown[] = [];
    await readPlatformCart('shopify', (c) => got.push(c), (async () => new Response(JSON.stringify({ total_price: 500, item_count: 1 }))) as typeof fetch);
    await readPlatformCart('shopify', (c) => got.push(c), (async () => { throw new Error('offline'); }) as typeof fetch);
    await readPlatformCart('shopify', (c) => got.push(c), (async () => new Response('no', { status: 404 })) as typeof fetch);
    expect(got).toEqual([{ value: 5, items: 1 }]);
  });
});
