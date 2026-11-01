export interface Targeting {
  urlInclude?: string[]; urlExclude?: string[]; delaySeconds?: number; scrollPercent?: number; exitIntent?: boolean; mobileBackExit?: boolean; inactivitySeconds?: number;
  device?: 'all' | 'desktop' | 'mobile'; visitor?: 'all' | 'new' | 'returning'; minPageViews?: number; frequencyDays?: number;
}
export interface Visit { path: string; mobile: boolean; returning: boolean; pageViews: number; now: number; lastClosedAt?: number | undefined; submitted?: boolean | undefined }

const glob = (p: string, s: string) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(s);

/** Static rules: can this visitor see the form on this page at all. Triggers (delay, scroll, exit) are `arm`ed afterwards. */
export function eligible(t: Targeting, v: Visit): boolean {
  if (v.submitted) return false;
  if (t.frequencyDays !== undefined && v.lastClosedAt !== undefined && v.now - v.lastClosedAt < t.frequencyDays * 864e5) return false;
  if ((t.device === 'mobile' && !v.mobile) || (t.device === 'desktop' && v.mobile)) return false;
  if ((t.visitor === 'new' && v.returning) || (t.visitor === 'returning' && !v.returning)) return false;
  if (t.minPageViews && v.pageViews < t.minPageViews) return false;
  if (t.urlExclude?.some((p) => glob(p, v.path))) return false;
  if (t.urlInclude?.length && !t.urlInclude.some((p) => glob(p, v.path))) return false;
  return true;
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
