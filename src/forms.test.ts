// @vitest-environment happy-dom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OnSiteForm, setCart, startForms } from './forms.ts';
import { teaserSpot } from './forms-layout.ts';

const EMAIL = { type: 'email', key: 'email', label: 'Email', required: true };
const PHONE = { type: 'phone', key: 'phone', label: 'Phone' };
const SMS = { type: 'consent_sms', key: 'okSms', disclosureText: 'Texts from Acme. Msg & data rates may apply. Reply STOP to cancel.' };

function form(over: Partial<OnSiteForm> = {}, def: Partial<OnSiteForm['definition']> = {}): OnSiteForm {
  return { id: 'f1', kind: 'popup', versionId: 'v1', targeting: {}, ...over, definition: { steps: [{ fields: [EMAIL] }], success: { type: 'message', text: 'Done' }, ...def } };
}

let posts: { url: string; body: Record<string, unknown> }[];
let tracked: [string, Record<string, unknown>][];
function setup(f: OnSiteForm, answers: Record<string, unknown>[] = []) {
  posts = []; tracked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/ingest/v1/forms?')) return new Response(JSON.stringify({ forms: [f] }));
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(answers.shift() ?? { ok: true, success: { type: 'message', text: 'Done' } }));
  }));
  const client = { anonymousId: () => 'anon-1', formView: vi.fn(), track: (n: string, p: Record<string, unknown>) => tracked.push([n, p]) };
  return startForms({ client: client as never, endpoint: 'https://api.test', siteKey: 'sk', get: () => null, set: () => undefined, allowed: () => false });
}
const root = () => document.body.lastElementChild!.shadowRoot!;
const submit = async () => { root().querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await vi.waitFor(() => expect((root().querySelector('form button[type=submit]') as HTMLButtonElement | null)?.disabled ?? false).toBe(false)); };
const input = (name: string, v: string | boolean) => { const el = root().querySelector<HTMLInputElement>(`[name=${name}]`)!; if (typeof v === 'boolean') el.checked = v; else el.value = v; };

beforeEach(() => { document.body.innerHTML = ''; document.body.style.cssText = ''; });
afterEach(() => vi.unstubAllGlobals());

describe('step-by-step forms', () => {
  const twoSteps = form({}, { saveEachStep: true, steps: [{ fields: [EMAIL], submitLabel: 'Continue' }, { fields: [PHONE, SMS], optional: true, submitLabel: 'Text me' }] });

  it('saves step 1 on its own, then sends step 2 with the signed token, and tracks the funnel', async () => {
    await setup(twoSteps, [{ ok: true, success: { type: 'message', text: 'Done' }, stepToken: 'tok-1' }]);
    expect(root().querySelector('button[type=submit]')!.textContent).toBe('Continue');
    input('email', 'ada@example.com');
    await submit();
    expect(posts[0]!.body).toMatchObject({ data: { email: 'ada@example.com' }, step: 0 });
    expect(posts[0]!.body.data).not.toHaveProperty('phone');
    expect(root().querySelector('button[type=submit]')!.textContent).toBe('Text me');
    input('phone', '+14155550123');
    await submit();
    expect(posts[1]!.body).toMatchObject({ data: { phone: '+14155550123', okSms: false }, step: 1, stepToken: 'tok-1' });
    expect(tracked.filter(([n]) => n === 'form_step').map(([, p]) => [p.step, p.action])).toEqual([[0, 'reached'], [0, 'completed'], [1, 'reached'], [1, 'completed']]);
  });

  it('"No thanks" on an optional last step finishes with step 1\'s answer and sends nothing more', async () => {
    await setup(twoSteps, [{ ok: true, success: { type: 'message', text: 'Welcome' }, stepToken: 'tok-1' }]);
    input('email', 'ada@example.com');
    await submit();
    const skip = [...root().querySelectorAll('button')].find((b) => b.textContent === 'No thanks')!;
    expect(skip.hidden).toBe(false);
    skip.click();
    expect(posts).toHaveLength(1);
    expect(root().textContent).toContain('Welcome');
    expect(tracked.some(([n, p]) => n === 'form_step' && p.action === 'skipped')).toBe(true);
  });

  it('never pre-ticks the SMS consent box', async () => {
    await setup(form({}, { steps: [{ fields: [EMAIL, PHONE, SMS] }] }));
    const box = root().querySelector<HTMLInputElement>('[name=okSms]')!;
    expect(box.checked).toBe(false);
    expect(box.closest('label')!.textContent).toContain('Reply STOP to cancel');
  });
});

describe('teaser tab', () => {
  it('shows after the visitor closes the form, reopens it on click and goes after a submit', async () => {
    await setup(form({}, { teaser: { text: 'Get 10% off', side: 'bottom_left', show: 'after_close' } }));
    expect(root().querySelector('.pop')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const tab = root().querySelector<HTMLButtonElement>('button.tab')!;
    expect(root().querySelector('.pop')).toBeNull();
    expect(tab.getAttribute('aria-label') ?? (tab as unknown as { ariaLabel: string }).ariaLabel).toContain('Get 10% off');
    expect(tracked.map(([n]) => n)).toContain('form_dismiss');
    tab.click();
    expect(root().querySelector('.pop')).not.toBeNull();
    expect(root().querySelector('button.tab')).toBeNull();
    input('email', 'a@b.co');
    await submit();
    [...root().querySelectorAll('button')].find((b) => b.textContent === 'Close')!.click();
    expect(document.body.children).toHaveLength(0);
  });

  it('`instead` starts as the tab only', async () => {
    await setup(form({ kind: 'flyout' }, { teaser: { text: 'Join', show: 'instead' } }));
    expect(root().querySelector('.fly')).toBeNull();
    expect(root().querySelector('button.tab')).not.toBeNull();
  });

  it('places the tab in each corner', () => {
    expect(teaserSpot('top_right')).toBe('top:16px;right:16px');
    expect(teaserSpot('nonsense')).toBe(teaserSpot('right'));
  });
});

describe('sticky bar', () => {
  it('renders a full-width bar with its message, pads the page while up, and Escape dismisses it for good', async () => {
    await setup(form({ kind: 'bar' }, { bar: { position: 'top', text: 'Free shipping over $50' } }));
    const bar = root().querySelector('.bar.top')!;
    expect(bar.textContent).toContain('Free shipping over $50');
    expect(root().querySelector('label')!.textContent).toContain('Email');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.children).toHaveLength(0);
    expect(document.body.style.paddingTop).toBe('');
    expect(tracked.map(([n]) => n)).toContain('form_dismiss');
  });
});

describe('cart rules', () => {
  it('opens a cart-targeted form when the cart changes after start, without a reload, and only once', async () => {
    setCart({ value: 0, items: 0 });
    await setup(form({ targeting: { cart: { minValue: 50 } } }));
    expect(document.body.children).toHaveLength(0);
    setCart({ value: 20, items: 1 });
    expect(document.body.children).toHaveLength(0);
    setCart({ value: 80, items: 2 });
    expect(root().querySelector('.pop')).not.toBeNull();
    setCart({ value: 90, items: 3 });
    expect(document.body.children).toHaveLength(1);
  });

  it('does not bring back a form the visitor dismissed', async () => {
    setCart({ value: 80, items: 2 });
    await setup(form({ targeting: { cart: { minValue: 50 } } }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.children).toHaveLength(0);
    setCart({ value: 120, items: 3 });
    expect(document.body.children).toHaveLength(0);
  });
});
