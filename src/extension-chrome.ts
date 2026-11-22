/** The slice of the extension APIs the SDK uses, so it needs no @types/chrome and tests can pass a fake. */
export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
export interface ChromeLike {
  storage: { local: StorageArea };
  runtime?: {
    id?: string;
    getManifest?: () => { version?: string; name?: string };
    sendMessage?: (message: unknown) => Promise<unknown>;
    onMessage?: { addListener(fn: (message: unknown, sender: { id?: string }) => void): void };
  };
}

export function chromeOf(given?: ChromeLike): ChromeLike {
  const c = given ?? (globalThis as { chrome?: ChromeLike; browser?: ChromeLike }).chrome ?? (globalThis as { browser?: ChromeLike }).browser;
  if (!c?.storage?.local) throw new Error('Hermeticor extension SDK: chrome.storage is missing (add "storage" to the manifest permissions)');
  return c;
}

export const uuid = (): string => crypto.randomUUID();
