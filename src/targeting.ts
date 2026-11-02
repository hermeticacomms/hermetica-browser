export interface Targeting {
  urlInclude?: string[]; urlExclude?: string[]; delaySeconds?: number; scrollPercent?: number; exitIntent?: boolean; mobileBackExit?: boolean; inactivitySeconds?: number;
  device?: 'all' | 'desktop' | 'mobile'; visitor?: 'all' | 'new' | 'returning'; minPageViews?: number; frequencyDays?: number;
  audience?: { mode?: 'show' | 'hide'; listIds?: string[]; segmentIds?: string[] }; hideKnownSubscribers?: boolean;
  countries?: string[]; countriesExclude?: string[]; utm?: { source?: string; medium?: string; campaign?: string }; referrerInclude?: string[];
  cart?: { minValue?: number; minItems?: number; empty?: boolean }; productPage?: 'only' | 'never';
}
/** Booleans from `/ingest/v1/forms/visitor`: never profile data. */
export interface Flags { known: boolean; subscriber: boolean; lists: Record<string, boolean>; segments: Record<string, boolean>; countries: Record<string, boolean> }
export interface Visit {
  path: string; mobile: boolean; returning: boolean; pageViews: number; now: number; lastClosedAt?: number | undefined; submitted?: boolean | undefined;
  /** First-touch UTM values and referrer host of this session. */
  utm?: Record<string, string> | undefined; referrer?: string | undefined;
  cart?: { value: number; items: number } | undefined; productPage?: boolean | undefined; flags?: Flags | undefined;
}

const glob = (p: string, s: string) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(s);

/** Rules that need the visitor-flags call: audience, known subscriber, country. */
export const needsFlags = (t: Targeting) => !!(t.audience?.listIds?.length || t.audience?.segmentIds?.length || t.hideKnownSubscribers || t.countries?.length || t.countriesExclude?.length);

function audienceOk(t: Targeting, f: Flags | undefined): boolean {
  if (t.hideKnownSubscribers && (!f || f.subscriber)) return false; // flags not loaded: stay hidden rather than nag a subscriber
  const ids = [...(t.audience?.listIds ?? []).map((i) => f?.lists[i]), ...(t.audience?.segmentIds ?? []).map((i) => f?.segments[i])];
  if (ids.length) { const member = ids.some((x) => x === true); if ((t.audience?.mode ?? 'show') === 'show' ? !member : member) return false; }
  const inCountry = (cs: string[]) => cs.some((c) => f?.countries[c] === true);
  if (t.countries?.length && !inCountry(t.countries)) return false;
  if (t.countriesExclude?.length && inCountry(t.countriesExclude)) return false;
  return true;
}

/** Static rules: can this visitor see the form on this page at all. Triggers (delay, scroll, exit) are `arm`ed afterwards. */
export function eligible(t: Targeting, v: Visit): boolean {
  if (v.submitted) return false;
  if (t.frequencyDays !== undefined && v.lastClosedAt !== undefined && v.now - v.lastClosedAt < t.frequencyDays * 864e5) return false;
  if ((t.device === 'mobile' && !v.mobile) || (t.device === 'desktop' && v.mobile)) return false;
  if ((t.visitor === 'new' && v.returning) || (t.visitor === 'returning' && !v.returning)) return false;
  if (t.minPageViews && v.pageViews < t.minPageViews) return false;
  if (t.urlExclude?.some((p) => glob(p, v.path))) return false;
  if (t.urlInclude?.length && !t.urlInclude.some((p) => glob(p, v.path))) return false;
  if (t.utm) for (const k of ['source', 'medium', 'campaign'] as const) { const want = t.utm[k]; if (want && (v.utm?.[k] ?? '').toLowerCase() !== want.toLowerCase()) return false; }
  if (t.referrerInclude?.length && !t.referrerInclude.some((p) => glob(p.toLowerCase(), (v.referrer ?? '').toLowerCase()))) return false;
  if (t.cart) {
    const c = v.cart ?? { value: 0, items: 0 };
    if (t.cart.empty === true && c.items > 0) return false;
    if (t.cart.empty === false && c.items === 0) return false;
    if (t.cart.minValue !== undefined && c.value < t.cart.minValue) return false;
    if (t.cart.minItems !== undefined && c.items < t.cart.minItems) return false;
  }
  if ((t.productPage === 'only' && !v.productPage) || (t.productPage === 'never' && v.productPage)) return false;
  if (needsFlags(t) && !audienceOk(t, v.flags)) return false;
  return true;
}

/** Product page: `og:type=product`, or schema.org Product markup in JSON-LD or microdata. */
export function isProductPage(doc: Document): boolean {
  if (doc.querySelector('meta[property="og:type"][content="product" i], meta[property="og:type"][content="og:product" i], [itemtype*="schema.org/Product"]')) return true;
  return [...doc.querySelectorAll('script[type="application/ld+json"]')].some((s) => /"@type"\s*:\s*"Product"/.test(s.textContent ?? ''));
}

/** Fires `fire` once, when the first configured trigger trips (none configured: immediately). Returns a disposer. */
export function arm(t: Targeting, mobile: boolean, fire: () => void): () => void {
  const offs: (() => void)[] = [];
  let done = false;
  const stop = () => { done = true; offs.forEach((f) => f()); };
  const go = () => { if (!done) { stop(); fire(); } };
  const on = (tg: EventTarget, ev: string, fn: (e: Event) => void) => { tg.addEventListener(ev, fn, { passive: true }); offs.push(() => tg.removeEventListener(ev, fn)); };
  const idle = mobile && (t.exitIntent || t.inactivitySeconds !== undefined);
  if (t.delaySeconds === undefined && t.scrollPercent === undefined && !t.exitIntent && t.inactivitySeconds === undefined) { go(); return stop; }
  if (t.delaySeconds !== undefined) { const id = setTimeout(go, t.delaySeconds * 1000); offs.push(() => clearTimeout(id)); }
  if (t.scrollPercent !== undefined) on(window, 'scroll', () => { if (((scrollY + innerHeight) / document.documentElement.scrollHeight) * 100 >= t.scrollPercent!) go(); });
  if (t.exitIntent && !mobile) on(document, 'mouseout', (e) => { const m = e as MouseEvent; if (!m.relatedTarget && m.clientY <= 0) go(); });
  if (idle) { // no mouse to leave with on touch devices: inactivity stands in for exit intent
    let id: ReturnType<typeof setTimeout>;
    const reset = () => { clearTimeout(id); id = setTimeout(go, (t.inactivitySeconds ?? 30) * 1000); };
    reset();
    for (const e of ['touchstart', 'scroll', 'keydown']) on(window, e, reset);
    if (t.exitIntent && t.mobileBackExit) { history.pushState({ hm: 1 }, ''); on(window, 'popstate', go); } // back button = leaving: the sentinel entry absorbs the press
    offs.push(() => clearTimeout(id));
  }
  return stop;
}
