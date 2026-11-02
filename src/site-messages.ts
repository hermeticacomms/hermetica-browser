/// <reference lib="dom" />
import { eligible, type Flags, isProductPage, needsFlags, type Targeting } from './targeting.ts';
import { cartState, firstTouch, type FormsDeps } from './forms.ts';

export interface OnSiteMessage { id: string; html: string; style: 'banner' | 'modal' | 'slide_in'; targeting: Targeting; ctaLabel: string | null; ctaUrl: string | null; queued: boolean }

const BOX: Record<OnSiteMessage['style'], string> = {
  banner: 'position:fixed;left:0;right:0;top:0;padding:12px 44px 12px 16px',
  modal: 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);max-width:min(92vw,440px);padding:24px;border-radius:8px;box-shadow:0 4px 24px #0004',
  slide_in: 'position:fixed;right:16px;bottom:16px;max-width:min(92vw,360px);padding:20px;border-radius:8px;box-shadow:0 4px 24px #0004',
};

/** Content-only site messages: one at a time, journey-queued first. The html was sanitised server-side on save. */
export async function startSiteMessages(deps: FormsDeps): Promise<void> {
  const base = deps.endpoint.replace(/\/$/, ''), auth = { authorization: `Bearer ${deps.siteKey}` };
  const aid = deps.client.anonymousId();
  let messages: OnSiteMessage[] = [];
  try {
    const r = await fetch(`${base}/ingest/v1/site-messages${aid ? `?aid=${encodeURIComponent(aid)}` : ''}`, { headers: auth });
    if (r.ok) messages = ((await r.json()) as { messages: OnSiteMessage[] }).messages;
  } catch { return; }
  if (!messages.length) return;
  let flags: Flags | undefined;
  if (messages.some((x) => needsFlags(x.targeting ?? {}))) {
    try { const r = await fetch(`${base}/ingest/v1/forms/visitor${aid ? `?aid=${encodeURIComponent(aid)}` : ''}`, { headers: auth }); if (r.ok) flags = (await r.json()) as Flags; } catch { /* flag rules stay closed */ }
  }
  const persist = deps.allowed(), views = persist ? Number(deps.get('hm_pv') ?? 1) : 1;
  const visit = { path: location.pathname, mobile: matchMedia('(pointer:coarse)').matches || innerWidth < 768, returning: views > 1, pageViews: views, now: Date.now(), ...firstTouch(deps, persist), cart: cartState(), productPage: isProductPage(document), flags };
  const m = messages.toSorted((a, b) => Number(b.queued) - Number(a.queued)).find((x) => {
    const last = deps.get(`hm_m_${x.id}`);
    return eligible(x.targeting ?? {}, { ...visit, lastClosedAt: last ? Number(last) : undefined, submitted: false }) && !(last && x.targeting?.frequencyDays === undefined);
  });
  if (!m) return;
  const host = document.createElement('div'), root = host.attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  box.setAttribute('role', m.style === 'modal' ? 'dialog' : 'status');
  box.style.cssText = `${BOX[m.style]};background:#fff;color:#111;font:15px/1.5 system-ui,sans-serif;z-index:2147483000;box-sizing:border-box`;
  box.innerHTML = m.html;
  if (m.ctaLabel && m.ctaUrl && /^https?:\/\//.test(m.ctaUrl)) {
    const a = Object.assign(document.createElement('a'), { href: m.ctaUrl, textContent: m.ctaLabel, rel: 'noopener' });
    a.style.cssText = 'display:inline-block;margin-top:10px;padding:8px 14px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none';
    box.append(a);
  }
  const x = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', ariaLabel: 'Close' });
  x.style.cssText = 'position:absolute;top:6px;right:10px;border:0;background:none;font-size:20px;cursor:pointer;color:inherit';
  x.addEventListener('click', () => { host.remove(); if (deps.allowed()) deps.set(`hm_m_${m.id}`, String(Date.now())); });
  box.append(x);
  root.append(box);
  document.body.append(host);
  void fetch(`${base}/ingest/v1/site-messages/${m.id}/shown`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(aid ? { aid } : {}) }).catch(() => undefined);
}
