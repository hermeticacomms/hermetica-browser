/// <reference lib="dom" />
export interface Teaser { text: string; side?: string; show?: 'instead' | 'after_close' | 'before_trigger' }

/** Sticky bar, teaser tab and step "No thanks" styles; appended to the form sheet. Same z-index as the popup. */
export const LAYOUT_CSS = '.tab{position:fixed;z-index:2147483000;margin:0;box-shadow:0 2px 12px #0004}.skip{background:none;border:0;color:inherit;text-decoration:underline}' +
  '.bar{position:fixed;left:0;right:0;z-index:2147483000}.bar.top{top:0}.bar.bottom{bottom:0}.bar .box{max-width:none;border-radius:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 48px 10px 16px}' +
  '.bar .msg{margin:0}.bar form,.bar fieldset{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:1}.bar label{margin:0}.bar button{margin:0}' +
  '@media(max-width:600px){.bar .box,.bar form,.bar fieldset{flex-direction:column;align-items:stretch}}';

const SPOTS: Record<string, string> = {
  left: 'left:0;top:50%', right: 'right:0;top:50%', bottom: 'bottom:0;left:50%',
  top_left: 'top:16px;left:16px', top_right: 'top:16px;right:16px', bottom_left: 'bottom:16px;left:16px', bottom_right: 'bottom:16px;right:16px',
};
/** Inline position of the teaser tab (unknown sides fall back to the right edge). */
export const teaserSpot = (side: string | undefined) => SPOTS[side ?? 'right'] ?? SPOTS.right!;

/** Teaser applies to popups and flyouts only. */
export const teaserOf = (kind: string, t: Teaser | undefined): Teaser | undefined => (kind === 'popup' || kind === 'flyout' ? t : undefined);

/** Keeps the page's own content reachable while a sticky bar is up: pads the body by the bar's height; the returned function undoes it. */
export function padForBar(bar: HTMLElement, top: boolean): () => void {
  const s = document.body.style;
  const key = top ? 'paddingTop' : 'paddingBottom';
  const prev = s[key];
  const base = parseFloat(getComputedStyle(document.body)[key]) || 0;
  s[key] = `${base + bar.offsetHeight}px`;
  return () => { s[key] = prev; };
}
