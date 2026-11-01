/**
 * Opt-in DOM autocapture (`autocapture: true`). Every event still goes through the client's consent gate, so nothing is
 * recorded or sent without analytics consent. Privacy: never reads input values or typed text, and only captures label
 * text from links and buttons (trimmed); elements inside `[data-hm-no-capture]` are ignored.
 */
type Track = (name: string, props: Record<string, unknown>) => void;

const CAPTURE = 'a,button,[role=button],[data-hm-capture]';
const label = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

export function startAutocapture(track: Track, doc: Document = document): () => void {
  let recent: { el: Element; at: number }[] = [];
  const onClick = (e: Event) => {
    const t = e.target instanceof Element ? e.target.closest(CAPTURE) : null;
    if (!t || t.closest('[data-hm-no-capture]')) return;
    const props = { tag: t.tagName.toLowerCase(), id: t.id || undefined, text: label(t), href: t instanceof HTMLAnchorElement ? t.href : undefined, path: location.pathname };
    track('element_click', props);
    const now = Date.now();
    recent = [...recent.filter((r) => now - r.at < 1000 && r.el === t), { el: t, at: now }];
    if (recent.length === 3) track('rage_click', props); // three clicks on one element within a second
  };
  const onLeave = () => track('page_leave', { path: location.pathname });
  doc.addEventListener('click', onClick, true);
  addEventListener('pagehide', onLeave);
  return () => { doc.removeEventListener('click', onClick, true); removeEventListener('pagehide', onLeave); };
}
