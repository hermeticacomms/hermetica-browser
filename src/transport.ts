/// <reference lib="dom" />
export const MAX_RETRIES = 5;
const BASE_MS = 500;

export interface Transport {
  /** true: the server took it. null: refused for good (4xx, reported through onError, not retried). false: gave up after retries. */
  send(path: string, body: unknown): Promise<boolean | null>;
  beacon(path: string, body: unknown): boolean;
  /** One GET with the key as ?k= (no preflight); the JSON body, or null on any failure. */
  get(path: string): Promise<unknown>;
  /** One POST; the JSON body whatever the status (debug tools read the error too). */
  post(path: string, body: unknown): Promise<unknown>;
}

export function createTransport(endpoint: string, siteKey: string, onError: (e: unknown) => void): Transport {
  const url = (p: string) => `${endpoint.replace(/\/$/, '')}${p}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async send(path, body) {
      // One key per batch, reused by every retry of it.
      for (let attempt = 0, key = crypto.randomUUID(); attempt < MAX_RETRIES; attempt++) {
        try {
          const res = await fetch(url(path), {
            method: 'POST', keepalive: true, body: JSON.stringify(body),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${siteKey}`, 'idempotency-key': key },
          });
          if (res.status < 400) return true;
          if (res.status < 500 && res.status !== 429) { // 4xx will not improve on retry: report it (wrong key, origin not allowed) and drop the batch
            const errBody = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
            onError(Object.assign(new Error(errBody?.error?.message ?? `HTTP ${res.status}`), { status: res.status, code: errBody?.error?.code }));
            return null;
          }
        } catch (e) { onError(e); }
        await sleep(BASE_MS * 2 ** attempt + Math.random() * BASE_MS);
      }
      return false;
    },
    get: (path) => fetch(`${url(path)}?k=${encodeURIComponent(siteKey)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    post: (path, body) => fetch(url(path), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${siteKey}` } }).then((r) => r.json()),
    // sendBeacon cannot set headers (so no Idempotency-Key either), so the key travels as ?k= and the body is text/plain (no CORS preflight).
    beacon: (path, body) => navigator.sendBeacon?.(`${url(path)}?k=${encodeURIComponent(siteKey)}`, new Blob([JSON.stringify(body)], { type: 'text/plain' })) ?? false,
  };
}
