/// <reference lib="dom" />
// Native push for hybrid apps whose UI runs in a WebView (Capacitor, Cordova): a separate entry so the core bundle does not grow.
// The app's push plugin supplies the APNs/FCM token and the tapped notification; this registers the token with the profile and
// tracks opens. Opens are ordinary events, so they follow the core client's consent like any other.
export interface AppIdentity { externalId?: string | undefined; email?: string | undefined; phoneNumber?: string | undefined; anonymousId?: string | null | undefined }
export interface AppDevice { deviceModel?: string; osName?: string; osVersion?: string; appName?: string; appVersion?: string; appBuild?: string; appId?: string }
export interface AppPushOptions {
  siteKey: string;
  endpoint: string;
  platform: 'ios' | 'android';
  /** Who the device belongs to: the core client's `anonymousId()` plus any ids you know. */
  identity: () => AppIdentity;
  /** The core client's `track`. */
  track: (name: string, props: Record<string, unknown>) => void;
  device?: AppDevice;
  sdkVersion?: string;
  /** First backoff step; mainly for tests. */
  retryMs?: number;
}
export interface AppPushToken {
  token: string;
  vendor: 'apns' | 'fcm';
  environment?: 'debug' | 'release';
  enablementStatus?: 'AUTHORIZED' | 'DENIED' | 'NOT_DETERMINED' | 'PROVISIONAL' | 'UNAUTHORIZED';
  background?: 'AVAILABLE' | 'DENIED' | 'RESTRICTED';
}

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const opt = (k: string, v: string | null | undefined): Record<string, string> => (v ? { [k]: v } : {});

/** The custom data of a notification, wherever the plugin put it (`data`, `userInfo`, `notification.data`, ...). Inner layers win. */
export function pushData(payload: unknown): Bag {
  if (!isBag(payload)) return {};
  const layers: unknown[] = [payload];
  for (const n of [payload['data'], payload['userInfo'], payload['notification'], payload['additionalData']]) {
    if (!isBag(n)) continue;
    layers.push(n, n['data'], n['additionalData']);
  }
  return Object.assign({}, ...layers.filter(isBag));
}

export function appPushTokenBody(o: AppPushOptions, t: AppPushToken, type: 'push-token' | 'push-token-unregister') {
  const id = o.identity();
  const d = o.device ?? {};
  return {
    data: {
      type,
      attributes: {
        token: t.token, platform: o.platform, vendor: t.vendor, enablement_status: t.enablementStatus ?? 'AUTHORIZED', background: t.background ?? 'AVAILABLE',
        device_metadata: {
          device_id: id.anonymousId ?? '', sdk_version: o.sdkVersion ?? 'app-0.1', device_model: d.deviceModel ?? '', os_name: d.osName ?? o.platform, os_version: d.osVersion ?? '',
          app_name: d.appName ?? '', app_version: d.appVersion ?? '', app_build: d.appBuild ?? '', app_id: d.appId ?? '', environment: t.environment ?? 'release',
        },
        profile: { data: { type: 'profile', attributes: { ...opt('email', id.email), ...opt('phone_number', id.phoneNumber), ...opt('external_id', id.externalId), ...opt('anonymous_id', id.anonymousId) } } },
      },
    },
  };
}

export function createAppPush(o: AppPushOptions) {
  const url = (p: string) => `${o.endpoint.replace(/\/$/, '')}${p}?company_id=${encodeURIComponent(o.siteKey)}`;
  const base = o.retryMs ?? 500;
  /** Retries network errors, 429 and 5xx with one Idempotency-Key. True on 2xx; false on 4xx or when every attempt failed. */
  async function send(path: string, body: unknown): Promise<boolean> {
    const key = crypto.randomUUID();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url(path), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${o.siteKey}`, 'idempotency-key': key } });
        if (res.status < 500 && res.status !== 429) return res.ok;
      } catch { /* offline: retry */ }
      if (attempt < 4) await new Promise((r) => setTimeout(r, base * 2 ** attempt + Math.random() * base));
    }
    return false;
  }
  const messageId = (payload: unknown) => (typeof payload === 'string' ? payload || null : str(pushData(payload)['hermetica_message_id']));
  return {
    /** Registers the token with the current profile. Call again after identify/reset so it follows the profile. */
    register: (t: AppPushToken) => send('/client/push-tokens', appPushTokenBody(o, t, 'push-token')),
    /** The token stops receiving pushes (logout). */
    unregister: (t: AppPushToken) => send('/client/push-token-unregister', appPushTokenBody(o, t, 'push-token-unregister')),
    /** A notification was tapped: tracks `$opened_push` for Hermetica messages and returns the deep link, or null. */
    opened(payload: unknown): string | null {
      const d = pushData(payload);
      const id = str(d['hermetica_message_id']);
      if (id) o.track('$opened_push', { hermetica_message_id: id });
      return str(d['deep_link']) ?? str(d['url']) ?? str(d['hermetica_url']);
    },
    /** A notification arrived while the app runs: tracks `$received_push` (delivered). True when it was a Hermetica message. */
    received(payload: unknown): boolean {
      const id = messageId(payload);
      if (id) o.track('$received_push', { hermetica_message_id: id });
      return !!id;
    },
  };
}
export type AppPush = ReturnType<typeof createAppPush>;
