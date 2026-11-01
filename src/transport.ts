/// <reference lib="dom" />
export const MAX_RETRIES = 5;
const BASE_MS = 500;

export interface Transport {
  /** Resolves true when the server took the batch (or will never take it: 4xx). */
  send(path: string, body: unknown): Promise<boolean>;
  beacon(path: string, body: unknown): boolean;
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
          if (res.status < 500 && res.status !== 429) return true; // 4xx will not improve on retry
        } catch (e) { onError(e); }
        await sleep(BASE_MS * 2 ** attempt + Math.random() * BASE_MS);
      }
      return false;
    },
    // sendBeacon cannot set headers (so no Idempotency-Key either), so the key travels as ?k= and the body is text/plain (no CORS preflight).
    beacon: (path, body) => navigator.sendBeacon?.(`${url(path)}?k=${encodeURIComponent(siteKey)}`, new Blob([JSON.stringify(body)], { type: 'text/plain' })) ?? false,
  };
}
