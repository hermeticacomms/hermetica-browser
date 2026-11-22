import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMBED_STORAGE, embedManifest } from './embed-manifest.ts';

// Every browser key the SDK writes must be declared, so Cookie Munch (and any consent tool reading the manifest) can list and block it.
const dir = (d: string) => new URL(`../${d}/`, import.meta.url);
// extension*.ts store in the extension's own chrome.storage, never in a website visitor's browser: not part of a site's embed manifest.
const sources = [...readdirSync(dir('src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'embed-manifest.ts' && !f.startsWith('extension')).map((f) => readFileSync(new URL(f, dir('src')), 'utf8')),
  ...readdirSync(dir('sw')).map((f) => readFileSync(new URL(f, dir('sw')), 'utf8'))].join('\n');

describe('embed manifest', () => {
  it('declares every hm_ storage key the SDK sources name (a key built from a prefix needs a pattern row)', () => {
    const keys = new Set([...sources.matchAll(/['"`](hm_[a-z_]*[a-z][_:]?)/g)].map((m) => m[1]!));
    expect(keys.size).toBeGreaterThan(8);
    const declared = (k: string) => EMBED_STORAGE.some((r) => (r.pattern ? r.name === `${k}*` : r.name === k));
    expect([...keys].filter((k) => !declared(k))).toEqual([]);
  });

  it('declares the push service worker database', () => {
    const db = /const DB = '([^']+)'/.exec(sources)?.[1];
    expect(EMBED_STORAGE.some((r) => r.type === 'indexedDB' && r.name === db)).toBe(true);
  });

  it('matches the embed-v1 rules the schema checks', () => {
    const m = embedManifest();
    expect(m.schema).toMatch(/^https:\/\/[a-z0-9.-]+\/schemas\/embed-v1\.json$/);
    expect(m.product).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
    for (const r of EMBED_STORAGE) {
      expect(r.lifetime).toMatch(/^(session|persistent|[1-9][0-9]{0,5}(s|m|h|d|w|y))$/);
      expect(r.purpose.en.length).toBeGreaterThan(0);
      expect(r.pattern ? r.name.endsWith('*') : !r.name.endsWith('*')).toBe(true);
    }
    const byCat = (n: string) => EMBED_STORAGE.filter((r) => r.name === n).map((r) => r.category);
    expect(byCat('hm_consent')).toEqual(['necessary', 'necessary']);
    expect(byCat('hm_ad').every((c) => c === 'marketing')).toBe(true);
    expect(byCat('hm_aid').every((c) => c === 'statistics')).toBe(true);
  });
});
