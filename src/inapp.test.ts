// @vitest-environment happy-dom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebInApp, renderMessage, sanitizeHtml, type InAppMessage } from './inapp.ts';
import { pushTokenBody } from './push.ts';

const msg = (over: Partial<InAppMessage> = {}): InAppMessage => ({
  id: '0190c9a0-0000-7000-8000-000000000001', variant: 'a', layout: 'modal',
  content: { blocks: [{ type: 'heading', text: 'Hi' }, { type: 'buttons', buttons: [{ label: 'Go', action: 'event', value: 'clicked_go' }, { label: 'Later', action: 'dismiss' }] }] },
  style: { background: '#fff', textColor: '#111', accentColor: '#06f', radius: 12, dismissible: true }, ...over,
});

describe('sanitizeHtml', () => {
  it('drops scripts, handlers and javascript links', () => {
    const d = document.createElement('div');
    d.append(sanitizeHtml('<p onclick="x()">a</p><script>1</script><a href="javascript:alert(1)">b</a><a href="https://ok.test">c</a>'));
    expect(d.querySelector('script')).toBeNull();
    expect(d.querySelector('p')!.getAttribute('onclick')).toBeNull();
    expect(d.querySelectorAll('a')[0]!.getAttribute('href')).toBeNull();
    expect(d.querySelectorAll('a')[1]!.getAttribute('href')).toBe('https://ok.test');
  });
});

describe('renderMessage', () => {
  it('renders blocks and wires buttons and the close control', () => {
    const click = vi.fn(); const dismiss = vi.fn();
    const root = renderMessage(msg(), { click, dismiss });
    expect(root.textContent).toContain('Hi');
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Go', 'Later', '×']);
    buttons[0]!.click(); buttons[2]!.click();
    expect(click).toHaveBeenCalledWith(expect.objectContaining({ label: 'Go', action: 'event' }));
    expect(dismiss).toHaveBeenCalled();
  });
  it('pins banners to the edge', () => {
    expect(renderMessage(msg({ layout: 'banner_bottom' }), { click: vi.fn(), dismiss: vi.fn() }).style.cssText).toContain('bottom');
  });
});

describe('createWebInApp', () => {
  const calls: { url: string; body?: any }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({ items: url.includes('/client/in-app-messages') ? [msg()] : [] }), { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

  it('fetches, shows the best message once and reports the impression', async () => {
    const hm = createWebInApp({ siteKey: 'pk', endpoint: 'https://api.test', anonymousId: () => 'anon-1' });
    await hm.trigger();
    await hm.trigger();
    expect(document.querySelectorAll('[data-hermetica-inapp]')).toHaveLength(1);
    expect(calls[0]!.url).toContain('anonymous_id=anon-1');
    expect(calls.find((c) => c.url.includes('in-app-events'))!.body.events[0]).toMatchObject({ type: 'impression', platform: 'web' });
  });
  it('does nothing without any identity', async () => {
    await createWebInApp({ siteKey: 'pk', endpoint: 'https://api.test', anonymousId: () => null }).trigger();
    expect(calls).toHaveLength(0);
  });
});

describe('pushTokenBody', () => {
  it('is the Klaviyo push-token shape', () => {
    const b = pushTokenBody({ siteKey: 'pk', endpoint: 'x', identity: { email: 'a@b.co', anonymousId: 'z' } }, 'tok', 'AUTHORIZED');
    expect(b.data.type).toBe('push-token');
    expect(b.data.attributes).toMatchObject({ token: 'tok', platform: 'web', vendor: 'web_push', enablement_status: 'AUTHORIZED' });
    expect(b.data.attributes.profile.data.attributes).toEqual({ email: 'a@b.co', anonymous_id: 'z' });
  });
});
