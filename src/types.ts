export interface Consent { analytics: boolean; marketing: boolean }

export interface ClientOptions {
  siteKey: string;
  endpoint: string;
  /** require-consent: nothing is stored or sent until analytics consent. opt-out: on until denied. none: always on. */
  consentMode?: 'require-consent' | 'opt-out' | 'none';
  /**
   * require-consent only. Default false: events tracked before the visitor decides are dropped. true: keep up to 50 of them in
   * memory (never in storage) and send them if analytics is granted, drop them if denied. Only turn on if your consent basis allows it.
   */
  bufferUntilConsent?: boolean;
  /** Last look at every event before it is queued: return it (changed or not) to send, or null to drop it. */
  beforeSend?: (event: QueuedEvent) => QueuedEvent | null;
  /** Drop the query string and fragment from page URLs and referrers (they can carry tokens or emails). UTMs are still read on landing. */
  stripQuery?: boolean;
  /** Keep only these query parameters in page URLs and referrers (implies stripQuery for every other one). */
  allowParams?: string[];
  debug?: boolean;
  autoPageViews?: boolean;
  /** Opt-in: record clicks on links/buttons, rage clicks and page leave. Respects consent; never reads typed input. */
  autocapture?: boolean;
  /** Opt-in: record play, pause and end of <video> and YouTube/Vimeo embeds. Respects consent. */
  trackVideo?: boolean;
  /** Load published popup/flyout/embed forms for this site key and show those whose targeting matches. */
  forms?: boolean;
  /** Read the cart from the store platform for cart targeting rules, so the site need not call `forms.setCart` (`shopify`: the storefront's `/cart.js`). */
  cart?: 'shopify';
  /** Where the anonymous id and consent live. With `local` (default), events not yet sent (consented ones only) also survive a reload and go out on the next page. */
  storage?: 'local' | 'cookie' | 'memory';
  /**
   * Fetch this site's settings from the Sites screen (GET /ingest/v1/config) and apply them to every option not passed here.
   * Calls made in the meantime wait (up to 3 s, then the defaults apply). The generated snippet turns this on.
   */
  remoteConfig?: boolean;
  /** Automatic page views only on these paths: `/shop` (the page and below), `/blog/*` (prefix). Empty = every page. */
  pageViewRoutes?: string[];
  /** Which identifiers `identify` may send; a disallowed one is left out. Default: all. */
  identify?: { email?: boolean; phone?: boolean; externalId?: boolean };
  batch?: { maxSize?: number; flushMs?: number };
  maxQueue?: number;
}

/** GET /ingest/v1/config (contracts SdkRemoteConfig). */
export interface RemoteSettings {
  consentMode: 'require-consent' | 'opt-out' | 'none';
  bufferUntilConsent: boolean; autoPageViews: boolean; pageViewRoutes: string[]; stripQuery: boolean; allowParams: string[];
  identify: { email: boolean; phone: boolean; externalId: boolean };
  batchSize: number; flushMs: number; maxQueue: number; autocapture: boolean; trackVideo: boolean;
}

export interface QueuedEvent {
  name: string;
  properties: Record<string, unknown>;
  dedupeKey: string;
  occurredAt: string;
  value?: number;
  currency?: string;
  anonymousId?: string;
  context: Record<string, unknown>;
}

export interface Client {
  /** `signature`: required when the site turns on signed identify; your server computes it (HMAC-SHA256 hex of externalId, else email, with the site's identity secret). */
  identify(externalId: string | null, traits?: Record<string, unknown>, opts?: { signature?: string }): void;
  track(name: string, props?: Record<string, unknown>, opts?: { value?: number; currency?: string; dedupeKey?: string }): void;
  page(props?: Record<string, unknown>): void;
  /** Call when a form becomes visible: feeds form analytics (views vs submissions). */
  formView(formId: string, versionId?: string): void;
  consent: { update(c: Partial<Consent>): void; get(): Consent };
  /** Subscribe an email/phone; `consentText` is the exact wording the visitor agreed to. Resolves true when accepted, null when refused (4xx, also emitted as `error`), false if the network kept failing. */
  subscribe(o: { email?: string; phone?: string; channels?: ('email' | 'sms')[]; listId?: string; consentText: string; consentVersion?: string }): Promise<boolean | null>;
  /** Notify me when a product (catalog external id) is back in stock. */
  backInStock(o: { email?: string; phone?: string; externalId: string; kind?: 'back_in_stock' | 'price_drop'; variantId?: string; channel?: 'email' | 'sms' | 'push' }): Promise<boolean | null>;
  /** The visitor id, or null while analytics consent is missing (forms send it to link history to the profile). */
  anonymousId(): string | null;
  /** On-site form runtime; started automatically with `forms: true`. */
  /** `setCart` reports the shopping cart for cart targeting rules (value in the store currency). Starting also shows content-only site messages. */
  forms: { start(): Promise<void>; setCart(cart: { value: number; items: number }): void };
  reset(): void;
  flush(): Promise<void>;
  /** `error` fires on every failed send; a 4xx (wrong site key, origin not allowed) carries `status` and is not retried. */
  on(event: 'flush' | 'error' | 'consent', cb: (data: unknown) => void): void;
  /** `lastError()`: the most recent error (send failure, 4xx with `status`/`code`, or a throwing beforeSend), or null. */
  /** `test(events?)`: checks the queued events (or the given ones, or a sample) against the server's schema and consent rules; nothing is stored. */
  debug: { events(): QueuedEvent[]; lastError(): (Error & { status?: number; code?: string }) | null; enable(): void; disable(): void; test(events?: unknown[]): Promise<unknown> };
}
