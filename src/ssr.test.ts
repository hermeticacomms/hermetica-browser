// Default (node) environment on purpose: no window/document, like a Next.js or Remix server render importing the SDK.
import { expect, it } from 'vitest';

it('imports with no browser globals, so server-rendered apps can import it', async () => {
  expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
  const m = await import('./index.ts');
  expect(typeof m.createClient).toBe('function');
});
