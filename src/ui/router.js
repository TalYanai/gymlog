// Hash router (Step 2d.0). Routes: #/workout (default), #/progress, #/history, #/manage, plus nested
// paths added by later substeps. parseRoute is pure (tested).
export const TABS = Object.freeze([
  { id: 'workout', label: 'אימון' },
  { id: 'progress', label: 'התקדמות' },
  { id: 'history', label: 'היסטוריה' },
  { id: 'manage', label: 'ניהול' },
]);

/** "#/history/ses_1" → { tab: 'history', parts: ['ses_1'] }; anything unknown → workout. */
export function parseRoute(hash) {
  const parts = String(hash ?? '').replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const tab = TABS.some((t) => t.id === parts[0]) ? parts[0] : 'workout';
  return { tab, parts: tab === parts[0] ? parts.slice(1) : [] };
}

export function createRouter(onRoute, win = window) {
  const fire = () => onRoute(parseRoute(win.location.hash));
  win.addEventListener('hashchange', fire);
  return { start: fire, go: (path) => { win.location.hash = `#/${path}`; } };
}
