# @hermeticacomms/sdk-browser

Core tracker: `import { createClient } from '@hermeticacomms/sdk-browser'`. Opt-in entries (`/push`, `/inapp`, `/ads`, `/reviews`, `/app-push`, `/hybrid`) are separate bundles with their own gzip budgets in `size.mjs`.

Install: `npm i @hermeticacomms/sdk-browser`, or from GitHub with `npm i github:hermeticacomms/hermetica-browser` (its `prepare` script builds `dist/`).

Privacy options: `consentMode: 'require-consent'` (default) drops events tracked before the visitor decides, unless `bufferUntilConsent: true`; `beforeSend(event) => event | null` edits or drops any event; `stripQuery: true` / `allowParams: ['ref']` keep tokens and emails in URLs out of `context.page`. Failed sends fire `error` (4xx carry `status` and are not retried); `hm.debug.lastError()` returns the last one.

Site settings: `remoteConfig: true` applies the settings saved on the Sites screen (consent mode for the visitor's region, automatic page views and `pageViewRoutes`, URL cleaning, `identify` rules, batching) to every option not passed in code; calls wait up to 3 s for them. `hm.debug.test()` checks the queued events against the server's schema and consent rules without storing them.

## Ad click ids (`@hermeticacomms/sdk-browser/ads`)

Captures ad click ids so server-side conversion forwarding (Meta CAPI, Google, TikTok, Snapchat, Pinterest) matches better. Off by default.

```ts
import { enableAdTracking } from '@hermeticacomms/sdk-browser/ads';
enableAdTracking(true); // call only once the visitor has allowed ads tracking; false clears everything stored
```

- Reads URL params (`fbclid gclid gbraid wbraid ttclid ScCid epik li_fat_id msclkid utm_*`) and first-party cookies (`_fbp _fbc _ttp _scid _epik _gcl_aw`). `_fbc` is built as `fb.1.<ms>.<fbclid>` when only `fbclid` is present.
- Persists them in localStorage (cookie fallback) for 90 days, each with its capture time.
- Every event the core SDK sends then carries a `$ad` property object, including `client_user_agent`. Server-side, forwarders read `$ad` from the converting event, or the profile's latest `$ad` inside the platform's attribution window.
- Nothing is captured or sent when off, or when the browser sends Global Privacy Control / Do Not Track (`enableAdTracking(true)` returns `false` then).

## Review widgets (`@hermeticacomms/sdk-browser/reviews`)

`mountReviews`, `fetchReviews`, `fetchReviewSummary` and `starsEl`. With a bundler, import them from the package as before; with a
script tag, load `dist/reviews.js` (global `HermeticaReviews`): they left the core `dist/hermetica.js`, so pages that only track
events no longer download them.

## Hybrid apps (`@hermeticacomms/sdk-browser/app-push`)

For apps whose UI runs in a WebView (Capacitor, Cordova): registers the native APNs/FCM token from the app's push plugin with
the profile and tracks notification opens. `/hybrid` (`createHybridClient`) bundles it with the core tracker and in-app messages for
the app's platform; the Capacitor and Cordova SDKs wrap it and wire their push plugins.

## Cart events and abandoned carts

Track the standard cart events with `track`; once the visitor is identified (`identify`, a form sign-up), the cart they built in
the browser becomes a server cart and, after an hour without changes, a `cart_abandoned` event for the Abandoned cart flows.
A cart the store platform also reports (Shopify checkout, API cart) or an order placed since wins, so a shopper gets one message.

```js
hm.track('add_to_cart', { productId: 'P1', variantId: 'V2', title: 'Mug', quantity: 1, priceMinor: 1200 }, { value: 1200, currency: 'USD' });
hm.track('remove_from_cart', { productId: 'P1', variantId: 'V2' });
hm.track('cart_updated', { productId: 'P1', variantId: 'V2', quantity: 3, priceMinor: 1200 }); // quantity 0 removes
hm.track('checkout_started', { cart: { currency: 'USD', recoveryUrl: 'https://shop.test/cart', lines: [/* items as above */] } });
hm.track('purchase', { orderId: 'O1' }, { value: 3600, currency: 'USD' }); // closes the cart
```

A `cart` snapshot (`{ currency, recoveryUrl, lines: [...] }`) on any of these events replaces the whole cart, which is what the
WordPress plugin sends. `price` in major units is accepted instead of `priceMinor` for two-decimal currencies.
