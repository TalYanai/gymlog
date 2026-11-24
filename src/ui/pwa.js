// Step 2e — installable app: manifest, iOS home-screen tags, service worker and updates.
// Production host only (2a S0): a preview build must never be installed, because its data would
// stay separate from the app. Nothing here reads or writes app data.
import { h } from './dom.js';

const PRECACHE_URL = './precache.json';

/** Head tags for installation (added at runtime so preview builds have none). */
export function installTags() {
  return [
    ['link', { rel: 'manifest', href: './manifest.webmanifest' }],
    ['link', { rel: 'apple-touch-icon', href: './icons/apple-touch-icon.png' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-title', content: 'GymLog' }],
    ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }],
  ];
}

/**
 * Sets up the installable app. canUpdate(): true when nothing typed is pending and nothing is
 * unsaved; flush(): commits pending typed values. Returns a description of what was done.
 */
export async function setupPwa({ env, flush, canUpdate, win = window }) {
  if (env.preview || env.localDev) return { installed: false, reason: env.localDev ? 'local' : 'preview' };
  const doc = win.document;
  for (const [tag, attrs] of installTags()) if (!doc.head.querySelector(`${tag}[${attrs.rel ? `rel="${attrs.rel}"` : `name="${attrs.name}"`}]`)) doc.head.append(h(tag, attrs));
  // Ask the browser to keep this site's storage (best effort; the browser decides).
  try { await win.navigator.storage?.persist?.(); } catch { /* not supported */ }
  const sw = win.navigator.serviceWorker;
  if (!sw) return { installed: false, reason: 'no-service-worker' };
  let version;
  try {
    const res = await win.fetch(PRECACHE_URL, { cache: 'no-store' });
    version = (await res.json()).version;
  } catch {
    return { installed: false, reason: 'offline' }; // the service worker already installed keeps serving
  }
  const reg = await sw.register(`./sw.js?v=${encodeURIComponent(version)}`, { scope: './' });
  const offer = (worker) => showUpdate(doc, async () => {
    await flush();
    if (!canUpdate()) {
      showUpdate(doc, null, 'יש נתונים שעדיין לא נשמרו. העדכון יחכה עד שהשמירה תצליח.');
      return;
    }
    let reloaded = false;
    sw.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; win.location.reload(); } });
    worker.postMessage('SKIP_WAITING');
  });
  // An update is offered only when a worker is waiting AND an older one controls the page;
  // the very first install activates by itself (there is nothing to replace).
  const watch = (worker) => worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && sw.controller) offer(worker); });
  if (reg.waiting && sw.controller) offer(reg.waiting);
  watch(reg.installing);
  reg.addEventListener('updatefound', () => watch(reg.installing));
  return { installed: true, version };
}

function showUpdate(doc, onApply, text = 'גרסה חדשה של האפליקציה מוכנה.') {
  doc.getElementById('update-bar')?.remove();
  const bar = h('div', { id: 'update-bar', class: 'update-bar', role: 'status' },
    h('span', {}, text),
    onApply ? h('button', { type: 'button', class: 'pri', onclick: () => onApply() }, 'עדכן עכשיו') : null,
    h('button', { type: 'button', onclick: () => bar.remove() }, 'אחר כך'));
  doc.body.append(bar);
}
