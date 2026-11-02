/** Shopify's storefront `/cart.js` (same origin, the visitor's own cart): `total_price` is in minor units, `item_count` counts units. */
export function fromShopifyCart(j: unknown): { value: number; items: number } | null {
  const c = j as { total_price?: unknown; item_count?: unknown } | null;
  if (!c || typeof c.total_price !== 'number' || typeof c.item_count !== 'number') return null;
  return { value: c.total_price / 100, items: c.item_count };
}

/** Reads the cart before targeting runs, so cart rules work without the site calling `setCart`. A failed read leaves the cart unreported (empty). */
export async function readPlatformCart(platform: 'shopify', set: (c: { value: number; items: number }) => void, f: typeof fetch = fetch): Promise<void> {
  if (platform !== 'shopify') return;
  try {
    const r = await f('/cart.js', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const c = r.ok ? fromShopifyCart(await r.json()) : null;
    if (c) set(c);
  } catch { /* not a Shopify storefront, or offline */ }
}
