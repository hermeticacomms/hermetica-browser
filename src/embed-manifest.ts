/**
 * Served as /.well-known/hermetica-embed.json (build.mjs writes dist/hermetica-embed.json; nginx serves it) in Cookie Munch's embed-v1 shape
 * (https://cookiemunch.net/schemas/embed-v1.json): every origin the browser SDK touches and every key it writes in a visitor's browser.
 * A new storage key in src/ needs a row here: embed-manifest.test.ts fails otherwise. Bump `updated` when this changes.
 * `pattern: true` rows end in `*` (one key per form, message or site key). `sdkStorage` is the `storage` option that writes the row (null = always this type).
 */
type Row = { name: string; type: 'cookie' | 'localStorage' | 'sessionStorage' | 'indexedDB'; category: string; lifetime: string; pattern?: true; sdkStorage: 'local' | 'cookie' | null; purpose: { en: string } };

const YEAR = '365d';
/** Keys the SDK's store writes: localStorage with `storage: 'local'` (default), a 1-year cookie with `storage: 'cookie'`. */
const both = (name: string, category: string, en: string, pattern?: true): Row[] => [
  { name, type: 'localStorage', category, lifetime: 'persistent', ...(pattern ? { pattern } : {}), sdkStorage: 'local', purpose: { en } },
  { name, type: 'cookie', category, lifetime: YEAR, ...(pattern ? { pattern } : {}), sdkStorage: 'cookie', purpose: { en } },
];

export const EMBED_STORAGE: Row[] = [
  ...both('hm_consent', 'necessary', 'Remembers the visitor\'s analytics and marketing consent answer for this site.'),
  ...both('hm_aid', 'statistics', 'Anonymous visitor id, set only after analytics consent, that ties events to one browser.'),
  ...both('hm_pv', 'statistics', 'Counts page views so on-site forms and messages can target returning visitors.'),
  ...both('hm_ft', 'statistics', 'First-touch UTM values and referrer of the visit, for form targeting.'),
  ...both('hm_c_*', 'statistics', 'When an on-site form was last closed, so it is not shown again too soon.', true),
  ...both('hm_s_*', 'statistics', 'That an on-site form was submitted, so it is not shown again.', true),
  ...both('hm_m_*', 'statistics', 'When an on-site message was closed, so it is not shown again.', true),
  { name: 'hm_queue:*', type: 'localStorage', category: 'statistics', lifetime: 'persistent', pattern: true, sdkStorage: 'local', purpose: { en: 'Consented events not yet sent, so a reload does not lose them.' } },
  { name: 'hm_ad', type: 'localStorage', category: 'marketing', lifetime: 'persistent', sdkStorage: null, purpose: { en: 'Ad click ids from the landing link (ads module, opt-in), kept 90 days for conversion reporting.' } },
  { name: 'hm_ad', type: 'cookie', category: 'marketing', lifetime: '90d', sdkStorage: null, purpose: { en: 'The same ad click ids where localStorage is blocked.' } },
  { name: 'hm_sid', type: 'sessionStorage', category: 'statistics', lifetime: 'session', sdkStorage: null, purpose: { en: 'In-app messaging session id (inapp module), for impression and click counts.' } },
  { name: 'hermetica-sw', type: 'indexedDB', category: 'marketing', lifetime: 'persistent', sdkStorage: null, purpose: { en: 'Web push settings the service worker needs to show notifications the visitor allowed (push module).' } },
];

export const embedManifest = (origin = 'https://hermeticor.com') => ({
  schema: 'https://cookiemunch.net/schemas/embed-v1.json',
  product: 'hermetica',
  updated: '2026-11-16T00:00:00Z',
  openapi: `${origin}/openapi.json`,
  llms: `${origin}/llms.txt`,
  status: `${origin}/status`,
  changelog: `${origin}/changelog`,
  docs: `${origin}/guides/cookie-munch`,
  surfaces: {
    // shortcut: forms with a captcha also load that vendor's script (Turnstile, hCaptcha, reCAPTCHA, Friendly Captcha); list them per surface if a site's CSP needs it.
    sdk: { csp: { 'script-src': [origin], 'connect-src': [origin] }, consentCategory: 'statistics', storage: EMBED_STORAGE },
  },
});
