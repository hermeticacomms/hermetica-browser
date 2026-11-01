/**
 * Opt-in video tracking (`trackVideo: true`): `video_play`, `video_pause` and `video_ended` for <video> elements and for YouTube
 * (needs `enablejsapi=1` on the embed) and Vimeo iframes. Goes through the client's consent gate. Add `data-hm-page-id` on <html>
 * to tie plays to a landing page in the page report. Elements inside `[data-hm-no-capture]` are ignored.
 */
type Track = (name: string, props: Record<string, unknown>) => void;

const EMBED = /^https:\/\/(?:www\.youtube(?:-nocookie)?\.com\/embed|player\.vimeo\.com\/video)\/([\w-]+)/;
const YT_STATE = ['video_ended', 'video_play', 'video_pause'];
const EVENTS = ['play', 'pause', 'ended'];

export function startVideoTracking(track: Track, doc: Document = document): () => void {
  const emit = (name: string, extra: Record<string, unknown>) => track(name, { path: location.pathname, pageId: doc.documentElement.dataset.hmPageId, ...extra });
  const onMedia = (e: Event) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || v.closest('[data-hm-no-capture]') || (e.type === 'pause' && v.ended)) return; // the browser fires pause just before ended
    emit('video_' + e.type, { provider: 'html5', src: (v.currentSrc || v.src).slice(0, 300), seconds: Math.round(v.currentTime), duration: Math.round(v.duration) || undefined });
  };
  const frames = new Map<Window, { yt: boolean; id: string }>();
  const scan = () => doc.querySelectorAll('iframe').forEach((f) => {
    const win = f.contentWindow, m = EMBED.exec(f.src);
    if (!win || !m || frames.has(win) || f.closest('[data-hm-no-capture]')) return;
    const yt = f.src.includes('youtu');
    if (yt && !/[?&]enablejsapi=1/.test(f.src)) return;
    frames.set(win, { yt, id: m[1]! });
    const post = (msg: object) => win.postMessage(JSON.stringify(msg), new URL(f.src).origin);
    if (yt) post({ event: 'listening', id: m[1], channel: 'widget' });
    else EVENTS.forEach((value) => post({ method: 'addEventListener', value }));
  });
  const onMessage = (e: MessageEvent) => {
    const f = e.source && frames.get(e.source as Window);
    if (!f || !/youtube|vimeo/.test(e.origin)) return;
    let d: { event?: string; info?: number; data?: { seconds?: number } };
    try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    const name = f.yt ? (d.event === 'onStateChange' ? YT_STATE[d.info!] : undefined) : EVENTS.includes(d.event!) ? 'video_' + d.event : undefined;
    if (name) emit(name, { provider: f.yt ? 'youtube' : 'vimeo', videoId: f.id, seconds: Math.round(d.data?.seconds ?? 0) || undefined });
  };
  EVENTS.forEach((t) => doc.addEventListener(t, onMedia, true)); // media events do not bubble
  addEventListener('message', onMessage);
  scan();
  const mo = new MutationObserver(scan);
  mo.observe(doc.documentElement, { childList: true, subtree: true });
  return () => { EVENTS.forEach((t) => doc.removeEventListener(t, onMedia, true)); removeEventListener('message', onMessage); mo.disconnect(); };
}
