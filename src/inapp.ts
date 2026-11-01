/// <reference lib="dom" />
// Web in-app messages: a separate entry point so the core bundle (size-budgeted) does not grow.
export interface InAppBlock { type: 'heading' | 'text' | 'image' | 'buttons'; text?: string; url?: string; alt?: string; buttons?: { label: string; action: 'dismiss' | 'deep_link' | 'url' | 'event'; value?: string; style?: string }[] }
export interface InAppMessage {
  id: string; variant: string; layout: 'modal' | 'banner_top' | 'banner_bottom' | 'fullscreen' | 'bottom_sheet';
  content: { blocks: InAppBlock[]; html?: string };
  style: { background: string; textColor: string; accentColor: string; radius: number; dismissible: boolean };
}
export interface WebInAppOptions {
  siteKey: string;
  endpoint: string;
  /** Pass `client.anonymousId` from the core client (null before analytics consent: nothing is fetched then). */
  anonymousId: () => string | null;
  identity?: () => { externalId?: string; email?: string; phoneNumber?: string };
  /** Runs for `event` buttons (track the named event) and for links before they open; return false to stop the default link handling. */
  onAction?: (action: 'deep_link' | 'url' | 'event', value: string, message: InAppMessage) => boolean | void;
}
export type InAppTriggerArg = { type: 'app_open' } | { type: 'screen_view'; name: string } | { type: 'event'; name: string; properties?: Record<string, unknown> } | { type: 'page_url'; url?: string };

const safeUrl = (u: string): string | null => { try { const x = new URL(u, location.href); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };

/** Strips scripts, frames, inline handlers and javascript: links from message HTML. */
export function sanitizeHtml(html: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form').forEach((n) => n.remove());
  t.content.querySelectorAll('*').forEach((n) => {
    for (const a of Array.from(n.attributes)) { // copy: attributes are removed while iterating
      if (a.name.startsWith('on') || ((a.name === 'href' || a.name === 'src' || a.name === 'action') && !safeUrl(a.value))) n.removeAttribute(a.name);
    }
  });
  return t.content;
}

const el = (tag: string, css: string, text?: string): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };

export function renderMessage(m: InAppMessage, on: { click: (b: { label: string; action: string; value?: string }) => void; dismiss: () => void }): HTMLElement {
  const s = m.style;
  const banner = m.layout === 'banner_top' || m.layout === 'banner_bottom';
  const root = el('div', `position:fixed;z-index:2147483000;display:flex;${banner ? `left:0;right:0;${m.layout === 'banner_top' ? 'top:0' : 'bottom:0'};` : `inset:0;background:rgba(0,0,0,.5);align-items:${m.layout === 'bottom_sheet' ? 'flex-end' : 'center'};justify-content:center;`}`);
  root.setAttribute('data-hermetica-inapp', m.id);
  const full = m.layout === 'fullscreen';
  const sheet = m.layout === 'bottom_sheet';
  const card = el('div', `background:${s.background};color:${s.textColor};font:16px/1.4 system-ui,sans-serif;box-sizing:border-box;padding:20px;position:relative;${banner ? 'width:100%;' : full ? 'width:100%;height:100%;overflow:auto;' : `width:min(92vw,420px);${sheet ? `border-radius:${s.radius}px ${s.radius}px 0 0;width:min(100vw,520px);` : `border-radius:${s.radius}px;`}`}`);
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', String(!banner));
  if (m.content.html) card.append(sanitizeHtml(m.content.html));
  else for (const b of m.content.blocks) {
    if (b.type === 'heading') card.append(el('h2', 'margin:0 0 8px;font-size:20px', b.text));
    else if (b.type === 'text') card.append(el('p', 'margin:0 0 12px', b.text));
    else if (b.type === 'image' && b.url && safeUrl(b.url)) { const i = el('img', 'max-width:100%;display:block;margin:0 0 12px') as HTMLImageElement; i.src = b.url; i.alt = b.alt ?? ''; card.append(i); }
    else if (b.type === 'buttons') {
      const row = el('div', 'display:flex;gap:8px;flex-wrap:wrap');
      for (const x of b.buttons ?? []) {
        const primary = x.style !== 'secondary';
        const btn = el('button', `cursor:pointer;padding:10px 16px;border-radius:${Math.min(s.radius, 10)}px;font:inherit;border:1px solid ${s.accentColor};background:${primary ? s.accentColor : 'transparent'};color:${primary ? '#fff' : s.accentColor}`, x.label);
        btn.addEventListener('click', () => on.click(x));
        row.append(btn);
      }
      card.append(row);
    }
  }
  if (s.dismissible) { const x = el('button', 'position:absolute;top:8px;right:8px;border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer', '×'); x.setAttribute('aria-label', 'Close'); x.addEventListener('click', on.dismiss); card.append(x); }
  root.append(card);
  return root;
}

export function createWebInApp(o: WebInAppOptions) {
  const base = o.endpoint.replace(/\/$/, '');
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${o.siteKey}` };
  const sid = ((): string => { try { return sessionStorage.getItem('hm_sid') ?? (sessionStorage.setItem('hm_sid', crypto.randomUUID()), sessionStorage.getItem('hm_sid')!); } catch { return crypto.randomUUID(); } })();
  const who = () => ({ ...o.identity?.(), anonymousId: o.anonymousId() ?? undefined });
  const shown = new Set<string>();

  const report = (m: InAppMessage, type: 'impression' | 'click' | 'dismiss', button?: string) =>
    void fetch(`${base}/client/in-app-events?company_id=${encodeURIComponent(o.siteKey)}`, {
      method: 'POST', keepalive: true, headers: { ...auth, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ events: [{ messageId: m.id, variant: m.variant, type, platform: 'web', sessionId: sid, ...(button ? { button } : {}) }], profile: who() }),
    }).catch(() => undefined);

  function display(m: InAppMessage): void {
    if (shown.has(m.id)) return;
    shown.add(m.id);
    const close = () => root.remove();
    const root = renderMessage(m, {
      dismiss: () => { report(m, 'dismiss'); close(); },
      click: (b) => {
        report(m, 'click', b.label);
        close();
        if (b.action === 'dismiss' || !b.value) return;
        if (o.onAction?.(b.action as 'deep_link' | 'url' | 'event', b.value, m) === false || b.action === 'event') return;
        const url = safeUrl(b.value);
        if (url) location.assign(url);
      },
    });
    document.body.append(root);
    report(m, 'impression');
  }

  /** Asks the server which message fits this moment and shows the best one. Resolves the messages it was given. */
  async function trigger(t: InAppTriggerArg = { type: 'page_url' }): Promise<InAppMessage[]> {
    const id = who();
    if (!id.anonymousId && !id.externalId && !id.email && !id.phoneNumber) return [];
    const q = new URLSearchParams({ company_id: o.siteKey, platform: 'web', trigger: t.type, session_id: sid });
    if ('name' in t) q.set('name', t.name);
    if (t.type === 'page_url') q.set('url', t.url ?? location.href);
    if (t.type === 'event' && t.properties) q.set('properties', JSON.stringify(t.properties));
    if (id.externalId) q.set('external_id', id.externalId);
    if (id.email) q.set('email', id.email);
    if (id.phoneNumber) q.set('phone_number', id.phoneNumber);
    if (id.anonymousId) q.set('anonymous_id', id.anonymousId);
    const res = await fetch(`${base}/client/in-app-messages?${q}`, { headers: { authorization: auth.authorization } }).catch(() => null);
    if (!res?.ok) return [];
    const items = ((await res.json()) as { items: InAppMessage[] }).items;
    if (items[0]) display(items[0]);
    return items;
  }
  return { trigger, display };
}
