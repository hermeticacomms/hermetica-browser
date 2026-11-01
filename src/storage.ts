/// <reference lib="dom" />
export interface Store { get(k: string): string | null; set(k: string, v: string): void; del(k: string): void }

export function createStore(kind: 'local' | 'cookie' | 'memory'): Store {
  const mem = new Map<string, string>();
  const memory: Store = { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v), del: (k) => void mem.delete(k) };
  try {
    if (kind === 'local') {
      const ls = localStorage;
      return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), del: (k) => ls.removeItem(k) };
    }
    if (kind === 'cookie') {
      return {
        get: (k) => document.cookie.split('; ').find((c) => c.startsWith(`${k}=`))?.slice(k.length + 1) ?? null,
        set: (k, v) => { document.cookie = `${k}=${v}; max-age=31536000; path=/; SameSite=Lax`; },
        del: (k) => { document.cookie = `${k}=; max-age=0; path=/`; },
      };
    }
  } catch { /* storage blocked: fall back to memory */ }
  return memory;
}
