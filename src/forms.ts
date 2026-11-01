/// <reference lib="dom" />
import { arm, eligible, type Targeting } from './targeting.ts';
import type { Client } from './types.ts';

interface Cond { field: string; op: string; value: string }
interface Field { type: string; key: string; when?: Cond[]; label?: string; required?: boolean; options?: string[]; value?: string; disclosureText?: string; privacyUrl?: string; text?: string; style?: string; min?: number; max?: number; step?: number }
interface Theme { primary: string; background: string; text: string; radius: number; buttonStyle: string; font: string; logoUrl?: string }
interface Success { type: string; text?: string; title?: string; url?: string; code?: string }
export interface OnSiteForm {
  id: string; kind: string; versionId: string; targeting: Targeting;
  definition: { captcha?: { provider: string; siteKey: string }; redirects?: { error?: string }; spin?: { segments: unknown[] }; teaser?: { text: string; side: string }; countdown?: { to: string; label: string; expiredText: string }; steps: { title?: string; fields: Field[] }[]; success: Success; theme?: Theme; minFillMs?: number };
}
export interface FormsDeps {
  client: Client; endpoint: string; siteKey: string;
  get(k: string): string | null; set(k: string, v: string): void; allowed(): boolean;
}

const HEX = /^#[0-9a-f]{3,8}$/i;
const FONTS: Record<string, string> = { system: 'system-ui,sans-serif', serif: 'Georgia,serif', mono: 'ui-monospace,monospace' };
const SEEN = 'hm_pv';
const CAP: Record<string, [string, string]> = { turnstile: ['challenges.cloudflare.com/turnstile/v0', 'turnstile'], hcaptcha: ['js.hcaptcha.com/1', 'hcaptcha'], recaptcha: ['www.google.com/recaptcha', 'grecaptcha'] };
const W = window as unknown as Record<string, { render(e: HTMLElement, o: object): void; ready?(f: () => void): void; reset?(): void } | undefined>;
const list = (v: unknown): string[] => [v].flat().filter((x) => x !== undefined && x !== false && x !== '').map(String);
/** Same rules the server applies to form conditions (it re-checks on submit). */
const holds = (w: Cond[] = [], d: Record<string, unknown>) => w.every((c) => { const s = list(d[c.field]); return c.op === 'filled' ? !!s.length : c.op === 'empty' ? !s.length : c.op === 'neq' ? !s.includes(c.value) : c.op === 'contains' ? s.some((x) => x.toLowerCase().includes(c.value.toLowerCase())) : s.includes(c.value); });

function css(t?: Theme): string {
  const c = (v: string | undefined, d: string) => (v && HEX.test(v) ? v : d);
  const p = c(t?.primary, '#1f6feb');
  const solid = t?.buttonStyle !== 'outline';
  return `:host{all:initial}.box{font:15px/1.5 ${FONTS[t?.font ?? 'system'] ?? FONTS.system};background:${c(t?.background, '#fff')};color:${c(t?.text, '#111')};padding:20px;border-radius:${Math.min(32, Number(t?.radius ?? 8)) | 0}px;box-shadow:0 4px 24px #0004;max-width:min(92vw,400px);box-sizing:border-box}` +
    `.pop{position:fixed;inset:0;display:grid;place-items:center;background:#0006;z-index:2147483000}.fly{position:fixed;right:16px;bottom:16px;z-index:2147483000}` +
    `label{display:block;margin:10px 0}input:not([type=checkbox]):not([type=radio]),select{display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:4px}fieldset{border:0;padding:0;margin:0}` +
    `button{cursor:pointer;padding:9px 16px;border:2px solid ${p};border-radius:inherit;background:${solid ? p : 'transparent'};color:${solid ? '#fff' : p};margin:8px 8px 0 0}button.x{position:absolute;top:6px;right:10px;border:0;background:none;color:inherit;font-size:20px}.box{position:relative}.wheel{width:150px;height:150px;border-radius:50%;margin:8px auto;transition:transform 3s ease-out}.err{color:#b42318}.hp{position:absolute;left:-9999px}img{max-height:40px;display:block;margin-bottom:8px}`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

function fieldEl(f: Field): HTMLElement {
  const req = !!f.required;
  if (f.type === 'freetext') return h(f.style === 'heading' ? 'strong' : 'p', {}, (f.text ?? '').replace(/<[^>]*>/g, ''));
  if (f.type === 'textarea') return h('label', {}, f.label ?? '', h('textarea', { name: f.key, required: req }));
  if (f.type === 'hidden') return h('input', { type: 'hidden', name: f.key, value: f.value ?? '' });
  const isChk = f.type === 'checkbox' || f.type.startsWith('consent_');
  if (isChk) return h('label', {}, h('input', { type: 'checkbox', name: f.key, required: req }), ` ${f.disclosureText ?? f.label ?? ''} `, ...(f.privacyUrl ? [h('a', { href: f.privacyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Privacy policy')] : [])); // consent boxes start unticked
  if (f.type === 'radio' || f.type === 'checkbox_group') {
    const t = f.type === 'radio' ? 'radio' : 'checkbox';
    return h('fieldset', { className: 'grp' }, h('legend', {}, f.label ?? ''), ...(f.options ?? []).map((o) => h('label', {}, h('input', { type: t, name: f.key, value: o, required: req && t === 'radio' }), ` ${o}`)));
  }
  if (f.type === 'select') return h('label', {}, f.label ?? '', h('select', { name: f.key, required: req }, h('option', { value: '' }), ...(f.options ?? []).map((o) => h('option', {}, o))));
  // Unknown types (e.g. country) degrade to a text box; the server validates and normalises the answer.
  const type = ({ email: 'email', phone: 'tel', number: 'number', rating: 'number', date: 'date', url: 'url', datetime: 'datetime-local', slider: 'range', file: 'file' } as Record<string, string>)[f.type] ?? 'text';
  const rng = f.type === 'slider' ? { min: f.min, max: f.max, step: f.step } : f.type === 'rating' ? { min: 1, max: f.max } : {};
  return h('label', {}, f.label ?? '', h('input', { type, name: f.key, required: req, ...rng }));
}

function collect(root: HTMLElement): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  for (const el of root.querySelectorAll<HTMLInputElement>('[name]')) {
    if (el.name === 'website' || el.type === 'file' || el.disabled || el.name.endsWith('-response')) continue;
    if (el.closest('.grp')) { if (el.checked) { if (el.type === 'radio') d[el.name] = el.value; else ((d[el.name] ??= []) as string[]).push(el.value); } continue; }
    d[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return d;
}

const go = (u?: string) => !!u && /^https?:/.test(u) && !!(location.href = u);

function mount(f: OnSiteForm, host: HTMLElement, deps: FormsDeps, close: (submitted: boolean) => void): void {
  const def = f.definition;
  const t0 = Date.now();
  const auth = { authorization: `Bearer ${deps.siteKey}` };
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = css(def.theme);
  if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet !== 'undefined') { const s = new CSSStyleSheet(); s.replaceSync(sheet); shadow.adoptedStyleSheets = [s]; } else shadow.append(h('style', {}, sheet));
  let i = 0;
  const err = h('p', { className: 'err', role: 'alert' });
  const rows: [Field, HTMLElement][] = [];
  const steps = def.steps.map((s) => h('fieldset', {}, ...(s.title ? [h('strong', {}, s.title)] : []), ...s.fields.map((x) => { const e = fieldEl(x); rows.push([x, e]); return e; })));
  const box = h('div');
  const hp = h('input', { name: 'website', tabIndex: -1, autocomplete: 'off' });
  const next = h('button', { type: 'button' }), back = h('button', { type: 'button' }, 'Back');
  const form = h('form', { noValidate: false }, ...steps, h('div', { className: 'hp', ariaHidden: 'true' }, hp), box, err, back, next);
  const body = h('div', { className: 'box', role: 'dialog', ariaLabel: 'Sign up' }, ...(def.theme?.logoUrl && def.theme.logoUrl.startsWith('https:') ? [h('img', { src: def.theme.logoUrl, alt: '' })] : []), form);
  const cap = def.captcha && CAP[def.captcha.provider];
  let tok = '';
  if (cap && def.captcha) { // explicit render: the widget lives inside the form's shadow root
    const [u, g] = cap, draw = () => W[g]!.render(box, { sitekey: def.captcha!.siteKey, callback: (t: string) => (tok = t), 'expired-callback': () => (tok = '') });
    if (W[g]?.render) draw(); else document.head.append(h('script', { src: `https://${u}/api.js?render=explicit`, async: true, onload: () => (W[g]!.ready ? W[g]!.ready!(draw) : draw()) }));
  }
  const sync = () => { // show-when: re-enable all, then switch off (and drop the answers of) fields whose rules fail, in field order
    const on = (e: HTMLElement, v: boolean) => { e.hidden = !v; e.querySelectorAll<HTMLInputElement>('[name]').forEach((x) => (x.disabled = !v)); };
    rows.forEach(([, e]) => on(e, true));
    const d = collect(form);
    for (const [fd, e] of rows) if (!holds(fd.when, d)) { on(e, false); delete d[fd.key]; }
  };
  if (rows.some(([fd]) => fd.when)) { form.addEventListener('input', sync); sync(); }
  if (def.countdown) { // ticks until the form is removed
    const c = def.countdown, to = Date.parse(c.to), p = h('p');
    const tk = () => { const s = Math.max(0, (to - Date.now()) / 1e3 | 0); p.textContent = s ? `${c.label} ${s / 86400 | 0}d ${s / 3600 % 24 | 0}h ${s / 60 % 60 | 0}m ${s % 60}s` : c.expiredText; };
    const iv = setInterval(() => { tk(); if (!host.isConnected) clearInterval(iv); }, 1000); tk(); body.prepend(p);
  }
  if (f.kind !== 'embed') body.prepend(h('button', { className: 'x', type: 'button', ariaLabel: 'Close', onclick: () => close(false) }, '×'));
  const show = () => { steps.forEach((s, n) => (s.hidden = n !== i)); back.hidden = i === 0; next.textContent = i === steps.length - 1 ? 'Submit' : 'Next'; next.type = i === steps.length - 1 ? 'submit' : 'button'; };
  next.addEventListener('click', () => { if (i < steps.length - 1) { const bad = [...steps[i]!.querySelectorAll<HTMLInputElement>('input,select')].find((x) => !x.checkValidity()); if (bad) bad.reportValidity(); else { i++; show(); } } });
  back.addEventListener('click', () => { i--; show(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cap && !tok) { err.textContent = 'Please complete the captcha'; return; }
    next.disabled = true;
    const fail = (m: string) => { err.textContent = m; next.disabled = false; if (cap) { tok = ''; W[cap[1]!]?.reset?.(); } };
    try {
      const aid = deps.client.anonymousId();
      const ep = `${deps.endpoint.replace(/\/$/, '')}/ingest/v1/forms/${f.id}`;
      const data = collect(form);
      for (const x of form.querySelectorAll<HTMLInputElement>('input[type=file]')) { // upload first; the answer is the returned URL
        if (!x.files?.[0]) continue;
        const fd = new FormData(); fd.append('field', x.name); fd.append('file', x.files[0]);
        const u = await fetch(`${ep}/upload`, { method: 'POST', headers: auth, body: fd });
        const uj = await u.json() as { url?: string; error?: { message?: string } };
        if (!u.ok || !uj.url) return fail(uj.error?.message ?? 'Upload failed');
        data[x.name] = uj.url;
      }
      const res = await fetch(`${ep}/submit`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ data, startedAt: t0, website: hp.value, ...(tok ? { captchaToken: tok } : {}), pageUrl: location.href, ...(aid ? { anonymousId: aid } : {}) }),
      });
      const j = await res.json() as { spin?: { index: number }; success?: Success; pendingConfirmation?: boolean; error?: { message?: string } };
      if (!res.ok || !j.success) { if (res.status >= 500 && go(def.redirects?.error)) return; fail(j.error?.message ?? 'Something went wrong'); return; }
      const s = j.success;
      if ((s.type === 'redirect' || s.type === 'download') && go(s.url)) return; // download: the browser fetches the file
      const msg = h('p', {}, `${s.text ?? 'Thanks!'}${s.type === 'coupon' && s.code ? ` Code: ${s.code}` : ''}${j.pendingConfirmation ? ' Check your email to confirm.' : ''}`);
      const wheel = j.spin && def.spin ? h('div', { className: 'wheel' }) : null;
      if (wheel) { // the prize was drawn server-side; the wheel only lands on it
        const n = def.spin!.segments.length;
        wheel.style.background = `conic-gradient(${Array.from({ length: n }, (_, k) => `hsl(${(k * 360) / n} 70% ${k % 2 ? 60 : 45}%) ${(k * 100) / n}% ${((k + 1) * 100) / n}%`)})`;
        msg.hidden = true;
        setTimeout(() => { wheel.style.transform = `rotate(${1440 - ((j.spin!.index + 0.5) / n) * 360}deg)`; }, 50);
        setTimeout(() => { msg.hidden = false; }, 3100);
      }
      form.replaceChildren(...(s.title ? [h('strong', {}, s.title)] : []), ...(wheel ? [h('div', {}, '\u25bc'), wheel] : []), msg, ...(f.kind === 'embed' ? [] : [h('button', { type: 'button', onclick: () => close(true) }, 'Close')]));
    } catch { if (!go(def.redirects?.error)) fail('Network error, please try again'); }
  });
  show();
  const w = f.kind === 'popup' ? h('div', { className: 'pop', onclick: (e: Event) => { if (e.target === w) close(false); } }, body) : f.kind === 'flyout' ? h('div', { className: 'fly' }, body) : body;
  const tz = def.teaser;
  if (tz && f.kind !== 'embed') { // teaser tab: the form opens when the tab is clicked
    const tab = h('button', { className: 'tab', onclick: () => { tab.remove(); shadow.append(w); } }, tz.text);
    tab.style.cssText = `position:fixed;z-index:2147483000;${tz.side === 'bottom' ? 'bottom:0;left:50%' : `${tz.side}:0;top:50%`}`;
    shadow.append(tab);
  } else shadow.append(w);
  deps.client.formView(f.id, f.versionId);
}

/** Loads published on-site forms and shows each one that passes its targeting. Visitor state is only persisted with analytics consent. */
export async function startForms(deps: FormsDeps): Promise<void> {
  let forms: OnSiteForm[] = [];
  try {
    // `v` buckets the visitor for form A/B; without consent it is a throwaway id (a different arm per page load).
    const r = await fetch(`${deps.endpoint.replace(/\/$/, '')}/ingest/v1/forms?v=${deps.client.anonymousId() ?? crypto.randomUUID()}`, { headers: { authorization: `Bearer ${deps.siteKey}` } });
    if (!r.ok) return;
    forms = ((await r.json()) as { forms: OnSiteForm[] }).forms;
  } catch { return; }
  const persist = deps.allowed();
  let views = persist ? Number(deps.get(SEEN) ?? 0) : 0;
  const mobile = matchMedia('(pointer:coarse)').matches || innerWidth < 768;
  const shown = new Set<string>(); // memory fallback so a form shows once per page load even without consent
  let disposers: (() => void)[] = [];
  let href = '';
  const run = () => { // once per page, including single-page-app navigations
    if (href === location.href) return;
    href = location.href;
    disposers.forEach((d) => d());
    disposers = [];
    views++;
    if (persist) deps.set(SEEN, String(views));
    for (const f of forms) {
      const t = f.targeting ?? {};
      const last = deps.get(`hm_c_${f.id}`);
      if (shown.has(f.id) || !eligible(t, { path: location.pathname, mobile, returning: views > 1, pageViews: views, now: Date.now(), lastClosedAt: last ? Number(last) : undefined, submitted: deps.get(`hm_s_${f.id}`) === '1' })) continue;
      disposers.push(arm(f.kind === 'embed' ? {} : t, mobile, () => {
        const host = f.kind === 'embed' ? document.querySelector<HTMLElement>(`[data-hm-form="${f.id}"]`) : document.body.appendChild(h('div'));
        if (!host || shown.has(f.id)) return;
        shown.add(f.id);
        mount(f, host, deps, (submitted) => {
          host.remove();
          if (persist) { deps.set(`hm_c_${f.id}`, String(Date.now())); if (submitted) deps.set(`hm_s_${f.id}`, '1'); }
          if (!submitted) deps.client.track('form_dismiss', { formId: f.id, versionId: f.versionId });
        });
      }));
    }
  };
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m].bind(history);
    history[m] = (...a: Parameters<History['pushState']>) => { orig(...a); run(); };
  }
  addEventListener('popstate', run);
  run();
}
