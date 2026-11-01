/// <reference lib="dom" />
// Ad click-id capture: a separate entry point so the core bundle (size-budgeted) does not grow. Off until the site calls enableAdTracking(true).
// Core merges whatever globalThis.hmAd() returns into every event's properties, so the ids ride along as `$ad`.
export type AdIds = Record<string, string>;
type Saved = Record<string, [string, number]>; // key -> [value, captured-at ms]

export const AD_TTL_MS = 90 * 864e5;
const KEY = 'hm_ad';
const PARAMS: Record<string, string> = { fbclid: 'fbclid', gclid: 'gclid', gbraid: 'gbraid', wbraid: 'wbraid', ttclid: 'ttclid', ScCid: 'scclid', epik: 'epik', li_fat_id: 'li_fat_id', msclkid: 'msclkid' };
const COOKIES: Record<string, string> = { _fbp: 'fbp', _fbc: 'fbc', _ttp: 'ttp', _scid: 'sccookie1', _epik: 'epik', _gcl_aw: 'gclid' };

/** Ids visible right now: URL params, utm_*, first-party ad cookies. Meta's fbc is built from fbclid (`fb.1.<ms>.<fbclid>`) when no _fbc cookie exists. */
export function readAdIds(href: string, cookie: string, now: number): AdIds {
  const out: AdIds = {};
  try {
    new URL(href).searchParams.forEach((v, k) => {
      const key = (Object.hasOwn(PARAMS, k) ? PARAMS[k] : k.startsWith('utm_') ? k : '');
      if (key && v) out[key] = v.slice(0, 256);
    });
  } catch { /* no usable URL */ }
  for (const c of cookie.split('; ')) {
    const i = c.indexOf('=');
    const name = c.slice(0, i);
    const key = Object.hasOwn(COOKIES, name) ? COOKIES[name] : undefined;
    const v = decodeURIComponent(c.slice(i + 1));
    if (key && v) out[key] = (key === 'gclid' ? v.split('.').pop()! : v).slice(0, 256); // _gcl_aw is GCL.<ts>.<gclid>
  }
  if (out.fbclid && !out.fbc) out.fbc = `fb.1.${now}.${out.fbclid}`;
  return out;
}

/** Newly seen ids replace stored ones (stamped now); anything older than 90 days drops. */
export function mergeAdIds(saved: Saved, seen: AdIds, now: number): Saved {
  const out: Saved = {};
  for (const [k, [v, t]] of Object.entries(saved)) if (now - t < AD_TTL_MS) out[k] = [v, t];
  for (const [k, v] of Object.entries(seen)) if (out[k]?.[0] !== v) out[k] = [v, now];
  return out;
}

const optedOut = (): boolean => {
  const n = navigator as Navigator & { globalPrivacyControl?: boolean };
  return n.globalPrivacyControl === true || n.doNotTrack === '1' || n.doNotTrack === 'yes';
};
const load = (): Saved => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {}; } catch { /* blocked: cookie */ }
  try { return JSON.parse(decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith(`${KEY}=`))?.slice(KEY.length + 1) ?? 'null')) ?? {}; } catch { return {}; }
};
const save = (s: Saved): void => {
  const json = JSON.stringify(s);
  try { localStorage.setItem(KEY, json); } catch { document.cookie = `${KEY}=${encodeURIComponent(json)}; max-age=${AD_TTL_MS / 1000}; path=/; SameSite=Lax`; }
};
const wipe = (): void => {
  try { localStorage.removeItem(KEY); } catch { /* blocked */ }
  document.cookie = `${KEY}=; max-age=0; path=/`;
};

const g = globalThis as { hmAd?: () => object };

function ids(): AdIds {
  const now = Date.now();
  const saved = mergeAdIds(load(), readAdIds(location.href, document.cookie, now), now);
  save(saved);
  return { ...Object.fromEntries(Object.entries(saved).map(([k, [v]]) => [k, v])), client_user_agent: navigator.userAgent };
}

/** Site-level switch. false (or GPC / Do Not Track) stops capture, removes the hook and clears stored ids. Returns whether tracking is now on. */
export function enableAdTracking(on: boolean): boolean {
  const active = on && !optedOut();
  if (active) g.hmAd = () => ({ $ad: ids() });
  else { delete g.hmAd; wipe(); }
  if (active) ids(); // capture the landing page right away
  return active;
}
