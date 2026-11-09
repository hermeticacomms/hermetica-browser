/// <reference lib="dom" />
import { type Flags, arm, eligible, isProductPage, needsFlags, type Targeting } from './targeting.ts';
import type { Client } from './types.ts';
import { LAYOUT_CSS, type Teaser, padForBar, teaserOf, teaserSpot } from './forms-layout.ts';

interface Cond { field: string; op: string; value: string }
interface Field { type: string; key: string; when?: Cond[]; label?: string; required?: boolean; options?: string[]; value?: string; disclosureText?: string; privacyUrl?: string; text?: string; style?: string; min?: number; max?: number; step?: number; choices?: { label: string; scores?: Record<string, number> }[] }
interface Theme { primary: string; background: string; text: string; radius: number; buttonStyle: string; font: string; logoUrl?: string }
interface Success { type: string; text?: string; title?: string; url?: string; code?: string }
interface Product { title: string; url: string | null; imageUrl: string | null }
interface Quiz { outcomes: { key: string; title: string; text?: string }[]; emailCapture?: string }
interface Answer { quiz?: { products?: Product[] }; spin?: { index: number }; success?: Success; pendingConfirmation?: boolean; stepToken?: string; error?: { message?: string } }
export interface OnSiteForm {
  id: string; kind: string; versionId: string; targeting: Targeting;
  definition: { submitLabel?: string; failureText?: string; captcha?: { provider: string; siteKey: string }; redirects?: { error?: string }; spin?: { segments: unknown[] }; quiz?: Quiz; teaser?: Teaser; bar?: { position?: string; text?: string }; saveEachStep?: boolean; countdown?: { to: string; label: string; expiredText: string }; steps: { title?: string; submitLabel?: string; optional?: boolean; fields: Field[] }[]; success: Success; theme?: Theme; minFillMs?: number };
}
export interface FormsDeps {
  client: Client; endpoint: string; siteKey: string;
  get(k: string): string | null; set(k: string, v: string): void; allowed(): boolean;
}

const HEX = /^#[0-9a-f]{3,8}$/i;
const FONTS: Record<string, string> = { system: 'system-ui,sans-serif', serif: 'Georgia,serif', mono: 'ui-monospace,monospace' };
const SEEN = 'hm_pv';
const CAP: Record<string, [string, string]> = { turnstile: ['challenges.cloudflare.com/turnstile/v0', 'turnstile'], hcaptcha: ['js.hcaptcha.com/1', 'hcaptcha'], recaptcha: ['www.google.com/recaptcha', 'grecaptcha'], friendlycaptcha: ['cdn.jsdelivr.net/npm/friendly-challenge@0.9.18', 'friendlyChallenge'] };
/** Cart state the site reports with `client.forms.setCart` (cart targeting rules). */
let cart: { value: number; items: number } | undefined;
export const cartState = () => cart;
/** Re-checks forms with cart rules on this page (set by `startForms`), so a cart change can open one without a reload. */
let onCart: (() => void) | undefined;
export const setCart = (c: { value: number; items: number }) => { cart = { value: Math.max(0, Number(c.value) || 0), items: Math.max(0, Math.floor(Number(c.items) || 0)) }; onCart?.(); };
const W = globalThis as unknown as Record<string, { render(e: HTMLElement, o: object): void; ready?(f: () => void): void; reset?(): void } | undefined>;
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
    `button{cursor:pointer;padding:9px 16px;border:2px solid ${p};border-radius:inherit;background:${solid ? p : 'transparent'};color:${solid ? '#fff' : p};margin:8px 8px 0 0}button.x{position:absolute;top:6px;right:10px;border:0;background:none;color:inherit;font-size:20px}.box{position:relative}.wheel{width:150px;height:150px;border-radius:50%;margin:8px auto;transition:transform 3s ease-out}.err{color:#b42318}.hp{position:absolute;left:-9999px}img{max-height:40px;display:block;margin-bottom:8px}${LAYOUT_CSS}`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

function fieldEl(f: Field, suggest: (q: string) => Promise<string[]>): HTMLElement {
  const req = !!f.required;
  if (f.type === 'password') return h('label', {}, f.label ?? '', h('input', { type: 'password', name: f.key, required: req, autocomplete: 'new-password' }));
  if (f.type === 'company') { // names-only suggestions from the site-key endpoint; free text still counts
    const id = `hm-co-${f.key}-${Math.random().toString(36).slice(2, 8)}`, dl = h('datalist', { id });
    const input = h('input', { type: 'text', name: f.key, required: req, autocomplete: 'organization' });
    input.setAttribute('list', id);
    let t: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener('input', () => { clearTimeout(t); const q = input.value.trim(); if (q.length < 2) return; t = setTimeout(() => void suggest(q).then((n) => dl.replaceChildren(...n.map((v) => h('option', { value: v })))), 250); });
    return h('label', {}, f.label ?? '', input, dl);
  }
  if (f.type === 'freetext') return h(f.style === 'heading' ? 'strong' : 'p', {}, (f.text ?? '').replace(/<[^>]*>/g, ''));
  if (f.type === 'textarea') return h('label', {}, f.label ?? '', h('textarea', { name: f.key, required: req }));
  if (f.type === 'hidden') return h('input', { type: 'hidden', name: f.key, value: f.value ?? '' });
  const isChk = f.type === 'checkbox' || f.type.startsWith('consent_');
  if (isChk) return h('label', {}, h('input', { type: 'checkbox', name: f.key, required: req }), ` ${f.disclosureText ?? f.label ?? ''} `, ...(f.privacyUrl ? [h('a', { href: f.privacyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Privacy policy')] : [])); // consent boxes start unticked
  if (f.type === 'radio' || f.type === 'checkbox_group' || f.type === 'quiz') {
    const t = f.type === 'checkbox_group' ? 'checkbox' : 'radio';
    const opts = f.type === 'quiz' ? (f.choices ?? []).map((c) => c.label) : f.options ?? [];
    return h('fieldset', { className: 'grp' }, h('legend', {}, f.label ?? ''), ...opts.map((o) => h('label', {}, h('input', { type: t, name: f.key, value: o, required: req && t === 'radio' }), ` ${o}`)));
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
    if (el.name === 'website' || el.type === 'file' || el.disabled || el.name.endsWith('-response') || el.name.endsWith('-solution')) continue;
    if (el.closest('.grp')) { if (el.checked) { if (el.type === 'radio') d[el.name] = el.value; else ((d[el.name] ??= []) as string[]).push(el.value); } continue; }
    d[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return d;
}

const go = (u?: string) => !!u && /^https?:/.test(u) && !!(location.href = u);

/** Same scoring as the server (which scores again on submit): highest total wins, ties go to the outcome listed first. */
export function quizOutcome(q: Quiz, fields: Field[], d: Record<string, unknown>): Quiz['outcomes'][number] | undefined {
  const t: Record<string, number> = Object.fromEntries(q.outcomes.map((o) => [o.key, 0]));
  for (const f of fields) for (const [k, n] of Object.entries(f.choices?.find((c) => c.label === d[f.key])?.scores ?? {})) if (k in t) t[k] = t[k]! + n;
  return q.outcomes.reduce<Quiz['outcomes'][number] | undefined>((b, o) => (!b || t[o.key]! > t[b.key]! ? o : b), undefined);
}

/** Clears a skipped step's answers so nothing from it is sent (the server treats an empty optional step as skipped). */
const clearStep = (s: HTMLElement) => s.querySelectorAll<HTMLInputElement>('input:not([type=hidden]),select,textarea').forEach((x) => { x.required = false; if (x.type === 'checkbox' || x.type === 'radio') x.checked = false; else x.value = ''; });

/**
 * Renders one form into `host`. `startAsTab` shows only the teaser tab until it is clicked (or `open()` runs). Closing a popup/flyout that has a teaser
 * leaves the tab behind; anything else removes the host. `onClose` records frequency and dismissals. Returns `open` for the trigger.
 */
function mount(f: OnSiteForm, host: HTMLElement, deps: FormsDeps, onClose: (submitted: boolean) => void, startAsTab = false): () => void {
  const def = f.definition;
  const t0 = Date.now();
  const auth = { authorization: `Bearer ${deps.siteKey}` };
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = css(def.theme);
  if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet !== 'undefined') { const s = new CSSStyleSheet(); s.replaceSync(sheet); shadow.adoptedStyleSheets = [s]; } else shadow.append(h('style', {}, sheet));
  let i = 0;
  const err = h('p', { className: 'err', role: 'alert' });
  const rows: [Field, HTMLElement][] = [];
  const suggest = async (q: string): Promise<string[]> => { try { const r = await fetch(`${deps.endpoint.replace(/\/$/, '')}/ingest/v1/forms/${f.id}/companies?q=${encodeURIComponent(q)}`, { headers: auth }); return r.ok ? ((await r.json()) as { items: string[] }).items : []; } catch { return []; } };
  const steps = def.steps.map((s) => h('fieldset', {}, ...(s.title ? [h('strong', {}, s.title)] : []), ...s.fields.map((x) => { const e = fieldEl(x, suggest); rows.push([x, e]); return e; })));
  const last = steps.length - 1;
  // Step-by-step saving: every step is its own submit, so leaving after step 1 keeps the signup; later steps carry step 1's signed token.
  const staged = !!def.saveEachStep && last > 0;
  let stepTok = '';
  let saved: Answer | undefined;
  const reached = new Set<number>();
  const step = (action: 'reached' | 'completed' | 'skipped') => { if (last > 0) deps.client.track('form_step', { formId: f.id, versionId: f.versionId, step: i, action }); };
  const box = h('div');
  const hp = h('input', { name: 'website', tabIndex: -1, autocomplete: 'off' });
  const next = h('button', { type: 'button' }), back = h('button', { type: 'button' }, 'Back'), skip = h('button', { type: 'button', className: 'skip' }, 'No thanks');
  const form = h('form', { noValidate: false }, ...steps, h('div', { className: 'hp', ariaHidden: 'true' }, hp), box, err, back, next, skip);
  const bar = f.kind === 'bar';
  const body = h('div', { className: 'box', role: bar ? 'region' : 'dialog', ariaLabel: 'Sign up' }, ...(def.theme?.logoUrl && def.theme.logoUrl.startsWith('https:') && !bar ? [h('img', { src: def.theme.logoUrl, alt: '' })] : []), ...(bar && def.bar?.text ? [h('p', { className: 'msg' }, def.bar.text)] : []), form);
  if (f.kind === 'popup') body.setAttribute('aria-modal', 'true');
  const cap = def.captcha && CAP[def.captcha.provider];
  let tok = '';
  if (cap && def.captcha?.provider === 'friendlycaptcha') { // proof-of-work puzzle: the widget instance reports the solution
    const FC = () => new (window as unknown as { friendlyChallenge: { WidgetInstance: new (e: HTMLElement, o: object) => unknown } }).friendlyChallenge.WidgetInstance(box, { sitekey: def.captcha!.siteKey, doneCallback: (t: string) => (tok = t) });
    if ((window as unknown as Record<string, unknown>).friendlyChallenge) FC(); else document.head.append(h('script', { src: `https://${cap[0]}/widget.min.js`, async: true, onload: FC }));
  } else if (cap && def.captcha) { // explicit render: the widget lives inside the form's shadow root
    const [u, g] = cap, draw = () => W[g]!.render(box, { sitekey: def.captcha!.siteKey, callback: (t: string) => (tok = t), 'expired-callback': () => (tok = '') });
    if (W[g]?.render) draw(); else document.head.append(h('script', { src: `https://${u}/api.js?render=explicit`, async: true, onload: () => (W[g]!.ready ? W[g]!.ready!(draw) : draw()) }));
  }
  let collected: Record<string, unknown> = {}; // answers of steps already saved (staged), for show-when rules in later steps
  const sync = () => { // show-when: re-enable all, then switch off (and drop the answers of) fields whose rules fail, in field order
    const on = (e: HTMLElement, v: boolean) => { e.hidden = !v; e.querySelectorAll<HTMLInputElement>('[name]').forEach((x) => (x.disabled = !v)); };
    rows.forEach(([, e]) => on(e, true));
    const d = { ...collected, ...collect(form) };
    for (const [fd, e] of rows) if (!holds(fd.when, d)) { on(e, false); delete d[fd.key]; }
  };
  if (rows.some(([fd]) => fd.when)) { form.addEventListener('input', sync); sync(); }
  if (def.countdown) { // ticks until the form is removed
    const c = def.countdown, to = Date.parse(c.to), p = h('p');
    const tk = () => { const s = Math.max(0, (to - Date.now()) / 1e3 | 0); p.textContent = s ? `${c.label} ${s / 86400 | 0}d ${s / 3600 % 24 | 0}h ${s / 60 % 60 | 0}m ${s % 60}s` : c.expiredText; };
    const iv = setInterval(() => { tk(); if (!host.isConnected) clearInterval(iv); }, 1000); tk(); body.prepend(p);
  }
  if (f.kind !== 'embed') body.prepend(h('button', { className: 'x', type: 'button', ariaLabel: 'Close', onclick: () => close(false) }, '×'));
  const qz = def.quiz?.emailCapture === 'after' && last > 0 ? h('p', { className: 'msg', role: 'status' }) : null;
  if (qz) steps[last]!.prepend(qz);
  const show = () => {
    steps.forEach((s, n) => (s.hidden = n !== i));
    if (qz && i === last) { const o = quizOutcome(def.quiz!, rows.map(([x]) => x), collect(form)); qz.textContent = o ? `${o.title}${o.text ? ` ${o.text}` : ''}` : ''; }
    back.hidden = i === 0 || staged; // a saved step is not re-sent
    skip.hidden = !def.steps[i]?.optional;
    const label = def.steps[i]?.submitLabel;
    next.textContent = label ?? (i === last ? def.submitLabel ?? 'Submit' : 'Next');
    next.type = i === last || staged ? 'submit' : 'button';
    if (!reached.has(i)) { reached.add(i); step('reached'); }
  };
  const focusFirst = () => (steps[i]?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea') ?? next).focus();
  next.addEventListener('click', () => { if (i < last && !staged) { const bad = [...steps[i]!.querySelectorAll<HTMLInputElement>('input,select')].find((x) => !x.checkValidity()); if (bad) bad.reportValidity(); else { step('completed'); i++; show(); focusFirst(); } } });
  back.addEventListener('click', () => { i--; show(); focusFirst(); });
  skip.addEventListener('click', () => {
    step('skipped');
    clearStep(steps[i]!);
    if (i < last) { i++; show(); focusFirst(); } else if (staged && saved) done(saved); else form.requestSubmit();
  });
  const go2 = (s: Success) => (s.type === 'redirect' || s.type === 'download') && go(s.url);
  const done = (j: Answer) => {
    const s = j.success!;
    if (go2(s)) return; // download: the browser fetches the file
    const msg = h('p', { role: 'status' }, `${s.text ?? 'Thanks!'}${s.type === 'coupon' && s.code ? ` Code: ${s.code}` : ''}${j.pendingConfirmation ? ' Check your email to confirm.' : ''}`);
    const wheel = j.spin && def.spin ? h('div', { className: 'wheel' }) : null;
    if (wheel) { // the prize was drawn server-side; the wheel only lands on it
      const n = def.spin!.segments.length;
      wheel.style.background = `conic-gradient(${Array.from({ length: n }, (_, k) => `hsl(${(k * 360) / n} 70% ${k % 2 ? 60 : 45}%) ${(k * 100) / n}% ${((k + 1) * 100) / n}%`)})`;
      msg.hidden = true;
      setTimeout(() => { wheel.style.transform = `rotate(${1440 - ((j.spin!.index + 0.5) / n) * 360}deg)`; }, 50);
      setTimeout(() => { msg.hidden = false; }, 3100);
    }
    const ok = h('button', { type: 'button', onclick: () => close(true) }, 'Close');
    const picks = (j.quiz?.products ?? []).map((p) => h(p.url && /^https?:/.test(p.url) ? 'a' : 'span', { className: 'msg', ...(p.url && /^https?:/.test(p.url) ? { href: p.url } : {}) }, ...(p.imageUrl?.startsWith('https:') ? [h('img', { src: p.imageUrl, alt: '' })] : []), p.title));
    form.replaceChildren(...(s.title ? [h('strong', {}, s.title)] : []), ...(wheel ? [h('div', {}, '▼'), wheel] : []), msg, ...picks, ...(f.kind === 'embed' ? [] : [ok]));
    submitted = true;
    if (f.kind !== 'embed') ok.focus();
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cap && !tok && !(staged && i > 0)) { err.textContent = 'Please complete the captcha'; return; }
    next.disabled = true;
    const fail = (m: string) => { err.textContent = def.failureText ?? m; next.disabled = false; if (cap && !(staged && i > 0)) { tok = ''; W[cap[1]!]?.reset?.(); } };
    try {
      const aid = deps.client.anonymousId();
      const ep = `${deps.endpoint.replace(/\/$/, '')}/ingest/v1/forms/${f.id}`;
      const scope = staged ? steps[i]! : form;
      const data = collect(scope);
      for (const x of scope.querySelectorAll<HTMLInputElement>('input[type=file]')) { // upload first; the answer is the returned URL
        if (!x.files?.[0]) continue;
        const fd = new FormData(); fd.append('field', x.name); fd.append('file', x.files[0]);
        const u = await fetch(`${ep}/upload`, { method: 'POST', headers: { ...auth, 'idempotency-key': crypto.randomUUID() }, body: fd });
        const uj = await u.json() as { url?: string; error?: { message?: string } };
        if (!u.ok || !uj.url) return fail(uj.error?.message ?? 'Upload failed');
        data[x.name] = uj.url;
      }
      const res = await fetch(`${ep}/submit`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ data, startedAt: t0, website: hp.value, ...(tok ? { captchaToken: tok } : {}), pageUrl: location.href, ...(aid ? { anonymousId: aid } : {}), ...(staged ? { step: i, ...(stepTok ? { stepToken: stepTok } : {}) } : {}) }),
      });
      const j = await res.json() as Answer;
      if (!res.ok || !j.success) { if (res.status >= 500 && go(def.redirects?.error)) return; fail(j.error?.message ?? 'Something went wrong'); return; }
      step('completed');
      // Saved; more to ask. No token back (e.g. a bot-like submit was quietly acknowledged): finish here.
      if (staged && i < last && j.stepToken) { stepTok = j.stepToken; saved = j; submitted = true; collected = { ...collected, ...data }; i++; show(); next.disabled = false; focusFirst(); return; }
      done(j);
    } catch { if (!go(def.redirects?.error)) fail('Network error, please try again'); }
  });
  show();

  const w = f.kind === 'popup' ? h('div', { className: 'pop', onclick: (e: Event) => { if (e.target === w) close(false); } }, body)
    : f.kind === 'flyout' ? h('div', { className: 'fly' }, body) : bar ? h('div', { className: `bar ${def.bar?.position === 'top' ? 'top' : 'bottom'}` }, body) : body;
  const tz = teaserOf(f.kind, def.teaser);
  const tab = tz ? h('button', { type: 'button', className: 'tab', ariaLabel: `${tz.text}: open the sign-up form`, onclick: () => open(true) }, tz.text) : null;
  if (tab) tab.style.cssText = teaserSpot(tz!.side);
  let submitted = false, viewed = false, prev: Element | null = null, unpad = () => {};
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && w.isConnected && f.kind !== 'embed') close(false); };
  function open(focus = f.kind === 'popup'): void {
    if (w.isConnected || !host.isConnected) return;
    prev = document.activeElement;
    tab?.remove();
    shadow.append(w);
    if (bar) unpad = padForBar(w, def.bar?.position === 'top');
    if (f.kind !== 'embed') document.addEventListener('keydown', esc);
    if (!viewed) { viewed = true; deps.client.formView(f.id, f.versionId); }
    if (focus) focusFirst(); // modal popups and tab clicks take focus; a bar or flyout opening on its own does not steal it
  }
  function close(didSubmit: boolean): void {
    document.removeEventListener('keydown', esc);
    unpad();
    const ret = prev as HTMLElement | null;
    onClose(didSubmit || submitted);
    if (tab && !(didSubmit || submitted)) { w.remove(); shadow.append(tab); tab.focus(); return; } // teaser stays until a submit
    host.remove();
    ret?.focus?.();
  }
  if (tab && startAsTab) shadow.append(tab); else open();
  return () => { if (!viewed) open(); }; // the trigger never reopens a form the visitor already opened and closed
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
  const touch = firstTouch(deps, persist);
  // Audience rules need the visitor's membership booleans; fetched once, only when a form uses them.
  let flags: Flags | undefined;
  if (forms.some((f) => needsFlags(f.targeting ?? {}))) {
    try {
      const aid = deps.client.anonymousId();
      const r = await fetch(`${deps.endpoint.replace(/\/$/, '')}/ingest/v1/forms/visitor${aid ? `?aid=${encodeURIComponent(aid)}` : ''}`, { headers: { authorization: `Bearer ${deps.siteKey}` } });
      if (r.ok) flags = (await r.json()) as Flags;
    } catch { /* rules that need flags stay closed */ }
  }
  const mobile = matchMedia('(pointer:coarse)').matches || innerWidth < 768;
  const shown = new Map<string, () => void>(); // form id -> open(); memory fallback so a form shows once per page load even without consent
  let disposers: (() => void)[] = [];
  let armed = new Set<string>(); // armed on this page; a cart change only re-checks the others
  let href = '';
  const run = () => { // once per page, including single-page-app navigations
    if (href === location.href) return;
    href = location.href;
    disposers.forEach((d) => d());
    disposers = [];
    armed = new Set();
    views++;
    if (persist) deps.set(SEEN, String(views));
    forms.forEach(consider);
  };
  // Shown, dismissed and frequency-capped forms stay out: `shown` and `eligible` already say so.
  onCart = () => forms.forEach((f) => { if (f.targeting?.cart && !armed.has(f.id)) consider(f); });
  function consider(f: OnSiteForm): void {
    const t = f.targeting ?? {};
    const last = deps.get(`hm_c_${f.id}`);
    if (shown.has(f.id) || !eligible(t, { path: location.pathname, mobile, returning: views > 1, pageViews: views, now: Date.now(), lastClosedAt: last ? Number(last) : undefined, submitted: deps.get(`hm_s_${f.id}`) === '1', ...touch, cart, productPage: isProductPage(document), flags })) return;
    armed.add(f.id);
    const show = (asTab: boolean) => {
      const host = f.kind === 'embed' ? document.querySelector<HTMLElement>(`[data-hm-form="${f.id}"]`) : document.body.appendChild(h('div'));
      if (!host || shown.has(f.id)) return;
      shown.set(f.id, mount(f, host, deps, (submitted) => {
        if (persist) { deps.set(`hm_c_${f.id}`, String(Date.now())); if (submitted) deps.set(`hm_s_${f.id}`, '1'); }
        if (!submitted) deps.client.track('form_dismiss', { formId: f.id, versionId: f.versionId });
      }, asTab));
    };
    const tz = teaserOf(f.kind, f.definition.teaser);
    if (tz?.show === 'before_trigger') show(true); // the tab is up from page load; the trigger below opens the form
    disposers.push(arm(f.kind === 'embed' ? {} : t, mobile, () => { const opened = shown.get(f.id); if (opened) opened(); else show(!!tz && tz.show !== 'after_close'); }));
  }
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m].bind(history);
    history[m] = (...a: Parameters<History['pushState']>) => { orig(...a); run(); };
  }
  addEventListener('popstate', run);
  run();
}

/** First-touch UTM values and referrer host of the visit; kept (with consent) so later pages of the same visit still match. */
export function firstTouch(deps: Pick<FormsDeps, 'get' | 'set'>, persist: boolean): { utm: Record<string, string>; referrer: string } {
  const saved = persist ? deps.get('hm_ft') : null;
  if (saved) { try { return JSON.parse(saved) as { utm: Record<string, string>; referrer: string }; } catch { /* rebuilt below */ } }
  const q = new URLSearchParams(location.search);
  const utm: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign']) { const v = q.get(`utm_${k}`); if (v) utm[k] = v.slice(0, 100); }
  let referrer = '';
  try { const r = document.referrer ? new URL(document.referrer).hostname : ''; referrer = r === location.hostname ? '' : r; } catch { /* no referrer */ }
  const out = { utm, referrer };
  if (persist) deps.set('hm_ft', JSON.stringify(out));
  return out;
}
