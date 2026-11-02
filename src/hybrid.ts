/// <reference lib="dom" />
// The client for hybrid apps (Capacitor, Cordova): the core tracker in the WebView, plus native push tokens and in-app messages for
// the app's platform. A separate entry: it bundles the core, so web pages never load it. The Capacitor and Cordova SDKs wrap it.
import { createAppPush, type AppDevice, type AppPushToken } from './app-push.ts';
import { createClient } from './client.ts';
import { createWebInApp } from './inapp.ts';
import type { Client, ClientOptions } from './types.ts';

export type { AppDevice, AppPushToken };
export interface ProfileIds { externalId?: string; email?: string; phoneNumber?: string }
export interface HybridOptions extends Omit<ClientOptions, 'autoPageViews'> {
  platform: 'ios' | 'android';
  device?: AppDevice;
  sdkVersion?: string;
  /** Show in-app messages (default true): on start, on `screen`, and on every `track`. */
  inApp?: boolean;
  /** Receives deep links from tapped pushes you pass to `handlePushOpened` and from in-app link buttons. */
  onDeepLink?: (link: string) => void;
}
export type HybridClient = Client & {
  /** A screen view: a page view with the screen name, offered to in-app messages as a screen trigger. */
  screen(name: string, props?: Record<string, unknown>): void;
  /** Tell push and in-app who this is. `identify()` sets the external id (and email / phone from its traits) too. */
  setProfile(p: ProfileIds): void;
  /** Registers the native token with the profile, and keeps it following the profile across identify / reset. */
  setPushToken(t: AppPushToken): Promise<boolean>;
  /** Stops pushes to this device (logout). */
  unregisterPushToken(): Promise<boolean>;
  /** A notification was tapped: tracks the open, passes the deep link to `onDeepLink` and returns it. */
  handlePushOpened(payload: unknown): string | null;
  handlePushReceived(payload: unknown): boolean;
};

export function createHybridClient(o: HybridOptions): HybridClient {
  const { platform, device, sdkVersion, inApp: wantInApp = true, onDeepLink, ...rest } = o;
  const client = createClient(rest);
  const profile: ProfileIds = {};
  let token: AppPushToken | null = null;
  const identity = () => ({ ...profile, anonymousId: client.anonymousId() });
  const push = createAppPush({ siteKey: o.siteKey, endpoint: o.endpoint, platform, identity, track: (n, p) => client.track(n, p), ...(device ? { device } : {}), ...(sdkVersion ? { sdkVersion } : {}) });
  const follow = () => { if (token) void push.register(token); };
  const inApp = wantInApp && typeof document !== 'undefined' ? createWebInApp({
    siteKey: o.siteKey, endpoint: o.endpoint, platform, anonymousId: client.anonymousId, identity: () => ({ ...profile }),
    onAction: (action, value, m) => {
      if (action === 'event') { client.track(value, { hermetica_message_id: m.id }); return false; }
      if (!onDeepLink) return undefined; // http(s) links open in the WebView
      onDeepLink(value);
      return false;
    },
  }) : null;
  // A WebView gets no pagehide when the app goes to the background, but it does get visibilitychange.
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void client.flush(); });
  if (inApp) void inApp.trigger({ type: 'app_open' });

  return {
    ...client,
    track(name, props = {}, opts) { client.track(name, props, opts); void inApp?.trigger({ type: 'event', name, properties: props }); },
    identify(externalId, traits = {}) {
      const t = traits as { email?: unknown; phone?: unknown };
      if (externalId) profile.externalId = externalId;
      if (typeof t.email === 'string') profile.email = t.email;
      if (typeof t.phone === 'string') profile.phoneNumber = t.phone;
      client.identify(externalId, traits);
      follow();
    },
    reset() { for (const k of Object.keys(profile) as (keyof ProfileIds)[]) delete profile[k]; client.reset(); follow(); },
    screen(name, props = {}) { client.page({ screen: name, ...props }); void inApp?.trigger({ type: 'screen_view', name }); },
    setProfile(p) { Object.assign(profile, p); follow(); },
    async setPushToken(t) { token = t; return push.register(t); },
    async unregisterPushToken() { const t = token; token = null; return t ? push.unregister(t) : true; },
    handlePushOpened(payload) { const link = push.opened(payload); if (link) onDeepLink?.(link); return link; },
    handlePushReceived: (payload) => push.received(payload),
  };
}
