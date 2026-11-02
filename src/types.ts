export interface Consent { analytics: boolean; marketing: boolean }

export interface ClientOptions {
  siteKey: string;
  endpoint: string;
  /** require-consent: nothing is stored or sent until analytics consent. opt-out: on until denied. none: always on. */
  consentMode?: 'require-consent' | 'opt-out' | 'none';
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
  storage?: 'local' | 'cookie' | 'memory';
  batch?: { maxSize?: number; flushMs?: number };
  maxQueue?: number;
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
  identify(externalId: string | null, traits?: Record<string, unknown>): void;
  track(name: string, props?: Record<string, unknown>, opts?: { value?: number; currency?: string; dedupeKey?: string }): void;
  page(props?: Record<string, unknown>): void;
  /** Call when a form becomes visible: feeds form analytics (views vs submissions). */
  formView(formId: string, versionId?: string): void;
  consent: { update(c: Partial<Consent>): void; get(): Consent };
  /** Subscribe an email/phone; `consentText` is the exact wording the visitor agreed to. Resolves false only if the network kept failing. */
  subscribe(o: { email?: string; phone?: string; channels?: ('email' | 'sms')[]; listId?: string; consentText: string; consentVersion?: string }): Promise<boolean>;
  /** Notify me when a product (catalog external id) is back in stock. */
  backInStock(o: { email?: string; phone?: string; externalId: string; kind?: 'back_in_stock' | 'price_drop'; variantId?: string; channel?: 'email' | 'sms' | 'push' }): Promise<boolean>;
  /** The visitor id, or null while analytics consent is missing (forms send it to link history to the profile). */
  anonymousId(): string | null;
  /** On-site form runtime; started automatically with `forms: true`. */
  /** `setCart` reports the shopping cart for cart targeting rules (value in the store currency). Starting also shows content-only site messages. */
  forms: { start(): Promise<void>; setCart(cart: { value: number; items: number }): void };
  reset(): void;
  flush(): Promise<void>;
  on(event: 'flush' | 'error' | 'consent', cb: (data: unknown) => void): void;
  debug: { events(): QueuedEvent[]; enable(): void; disable(): void };
}
