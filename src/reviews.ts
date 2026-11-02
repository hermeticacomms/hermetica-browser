/// <reference lib="dom" />
/** On-site review widgets: star summary, review list, carousel. Reads published reviews with the site key; renders with textContent only (no HTML injection). */

export interface ReviewItem {
  id: string; reviewType: string; rating: number | null; title: string | null; body: string | null; authorName: string | null; verified: boolean; featured: boolean;
  images: string[]; publicReply: string | null; createdAt: string;
}
export interface ReviewSummary { productId: string; count: number; average: number; histogram: Record<string, number> }
export interface ReviewWidgetOptions {
  endpoint: string; siteKey: string; productId: string; el: HTMLElement;
  /** stars: average and count; list: newest reviews; carousel: featured first, one at a time. */
  mode?: 'stars' | 'list' | 'carousel'; limit?: number; intervalMs?: number;
}

async function get<T>(o: Pick<ReviewWidgetOptions, 'endpoint' | 'siteKey'>, path: string): Promise<T> {
  const res = await fetch(`${o.endpoint.replace(/\/$/, '')}${path}`, { headers: { authorization: `Bearer ${o.siteKey}` } });
  if (!res.ok) throw new Error(`reviews HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchReviews = (o: Pick<ReviewWidgetOptions, 'endpoint' | 'siteKey' | 'productId'>, q: { limit?: number; sort?: string; cursor?: string } = {}) =>
  get<{ items: ReviewItem[]; nextCursor: string | null }>(o, `/ingest/v1/reviews?${new URLSearchParams({ productId: o.productId, limit: String(q.limit ?? 10), sort: q.sort ?? '-created', ...(q.cursor ? { cursor: q.cursor } : {}) })}`);
export const fetchReviewSummary = async (o: Pick<ReviewWidgetOptions, 'endpoint' | 'siteKey' | 'productId'>): Promise<ReviewSummary> =>
  (await get<{ items: ReviewSummary[] }>(o, `/ingest/v1/review-values-reports?${new URLSearchParams({ productId: o.productId })}`)).items[0] ?? { productId: o.productId, count: 0, average: 0, histogram: {} };

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = `hm-rv-${cls}`;
  if (text !== undefined) e.textContent = text;
  return e;
};
/** Five stars as text with an accessible label ("4.5 out of 5"). */
export function starsEl(rating: number): HTMLElement {
  const full = Math.round(rating);
  const s = h('span', 'stars', '★'.repeat(full) + '☆'.repeat(5 - full));
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', `${rating.toFixed(1)} out of 5`);
  return s;
}
const safeImg = (u: string) => /^https:\/\//i.test(u);

function reviewEl(r: ReviewItem): HTMLElement {
  const card = h('article', 'review');
  if (r.rating !== null) card.append(starsEl(r.rating));
  if (r.title) card.append(h('strong', 'title', r.title));
  if (r.body) card.append(h('p', 'body', r.body));
  const meta = h('div', 'meta', `${r.authorName ?? 'Anonymous'}${r.verified ? ' · Verified buyer' : ''} · ${r.createdAt.slice(0, 10)}`);
  card.append(meta);
  const imgs = r.images.filter(safeImg);
  if (imgs.length) {
    const row = h('div', 'images');
    for (const u of imgs) { const i = h('img', 'image'); i.src = u; i.alt = ''; i.loading = 'lazy'; row.append(i); }
    card.append(row);
  }
  if (r.publicReply) card.append(h('blockquote', 'reply', r.publicReply));
  return card;
}

/** Renders into `el` and returns a stop function (clears the carousel timer). */
export async function mountReviews(o: ReviewWidgetOptions): Promise<() => void> {
  const mode = o.mode ?? 'stars';
  o.el.replaceChildren();
  if (mode === 'stars') {
    const s = await fetchReviewSummary(o);
    const box = h('div', 'summary');
    box.append(starsEl(s.average), h('span', 'count', ` ${s.average.toFixed(1)} (${s.count})`));
    o.el.append(box);
    return () => {};
  }
  const page = await fetchReviews(o, { limit: o.limit ?? (mode === 'carousel' ? 10 : 5), sort: mode === 'carousel' ? 'featured' : '-created' });
  const items = page.items.filter((r) => r.reviewType !== 'question');
  if (mode === 'list' || items.length < 2) { o.el.append(...items.map(reviewEl)); return () => {}; }
  const region = h('section', 'carousel');
  region.setAttribute('aria-roledescription', 'carousel');
  region.setAttribute('aria-live', 'polite');
  let i = 0;
  const show = () => region.replaceChildren(reviewEl(items[i]!));
  const prev = h('button', 'prev', '‹'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous review');
  const next = h('button', 'next', '›'); next.type = 'button'; next.setAttribute('aria-label', 'Next review');
  prev.addEventListener('click', () => { i = (i - 1 + items.length) % items.length; show(); });
  next.addEventListener('click', () => { i = (i + 1) % items.length; show(); });
  show();
  o.el.append(region, prev, next);
  // No auto-advance for people who asked for reduced motion.
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timer = still ? null : setInterval(() => next.click(), o.intervalMs ?? 6000);
  return () => { if (timer) clearInterval(timer); };
}
