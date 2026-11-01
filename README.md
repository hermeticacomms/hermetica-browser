# @hermeticacomms/sdk-browser

Core tracker: `import { createClient } from '@hermeticacomms/sdk-browser'`. Opt-in entries (`/push`, `/inapp`, `/ads`) are separate bundles with their own gzip budgets in `size.mjs`.

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
