// GymLog v2 UI entry point (Step 2d.0): bootstrap, status bar, navigation shell, lifecycle hooks.
// Step 2d.1: startup, migration, import, recovery and error screens (2a S0–S9, R, E) chosen from the
// gate (screenFor). The tabs themselves are filled by Steps 2d.2–2d.7.
import { bootstrap } from '../app/bootstrap.js';
import { APP_VERSION, SEED_URL, INPUT_DEBOUNCE_MS } from './config.js';
import { createActions } from './actions.js';
import { createInputBuffer } from './input-buffer.js';
import { statusModel, renderStatus } from './status.js';
import { createRouter, TABS } from './router.js';
import { h } from './dom.js';
import { detectEnvironment, screenFor } from './flow-model.js';
import { readEnvironmentInputs } from './io.js';
import { renderScreen, previewBanner, appBanners } from './screens.js';
import { workoutView, workoutSignature, patchWorkoutView } from './workout.js';
import { historyView } from './history.js';
import { progressView } from './progress.js';
import { manageView } from './manage.js';
import { setupPwa } from './pwa.js';
import { createSyncRuntime } from './sync.js';

const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

async function start() {
  const seedDoc = await (await fetch(SEED_URL, { cache: 'no-store' })).json();
  const { app, syncPort } = await bootstrap({ now, newId, seedDoc, appVersion: APP_VERSION });
  const actions = createActions(app);
  let syncRuntime = null;
  let inputState = { saving: 0, protection: { state: 'ok', code: null }, pendingFields: 0 };
  const statusEl = document.getElementById('status');
  const drawStatus = () => renderStatus(statusEl, statusModel({ app: app.getState(), input: inputState }), onStatusAction);
  const buffer = createInputBuffer({ app, commitSet: actions.commitSetValues, debounceMs: INPUT_DEBOUNCE_MS, onState: (s) => { inputState = s; drawStatus(); } });

  async function onStatusAction(id) {
    if (id === 'retrySave') await actions.retrySave();
    else if (id === 'reload') await actions.reload();
    else if (id === 'flushNow') await buffer.flushAll();
    else if (id === 'exportCurrent') await exportCurrentState(app);
    else if (id === 'why') showUsage(app);
    drawStatus();
  }

  const view = document.getElementById('view');
  const nav = document.getElementById('nav');
  const env = detectEnvironment(readEnvironmentInputs());
  let route = { tab: 'workout', parts: [] };
  let flow = null; // the screen flow in progress (import, restore, report, …); UI memory only
  const session = {}; // per-window UI facts (screen R: raw export done)
  const workoutUi = { starting: false }; // Workout tab (2d.2): a start in flight
  const historyUi = { limit: 60 }; // History tab (2d.5): rows shown
  const progressUi = {
    goalForm: null,
    manualRecordForm: null,
    activeTab: 'charts',
    prFilterExerciseId: null,
    compareMode: 'week',
    compareWeekA: null,
    compareWeekB: null,
    compareMonthA: null,
    compareMonthB: null,
  }; // Progress tab: PRs, Period Comparisons, Goals & Charts
  const manageUi = { draft: null, exerciseForm: null }; // Manage tab (2d.7): template draft / forms
  let lastSig = null; // structure of the drawn view (2d.3: an unchanged active workout is patched)
  const draw = () => {
    drawStatus();
    const state = app.getState();
    const snap = state.gate === 'open' || state.busy ? app.snapshot() : null;
    const store = snap?.ok ? snap.store : null;
    const ctx = { sync: syncRuntime, app, env, state, store, flow, session, now, actions, buffer, workoutUi, historyUi, progressUi, manageUi, go: (path) => router.go(path), setFlow: (f) => { flow = f; draw(); }, rerender: () => draw() };
    const id = screenFor({ state, store, flow });
    document.body.dataset.screen = id;
    if (id !== 'app') {
      lastSig = null;
      nav.hidden = true; // logging is not offered outside the open app (2a R)
      view.replaceChildren(...[previewBanner(env), renderScreen(id, ctx)].filter(Boolean));
      return;
    }
    nav.hidden = false;
    const banners = appBanners(ctx);
    // 2d.3: while a workout is open, a store change with the same structure only patches values, so
    // the field being typed in keeps its focus and the phone keyboard stays open.
    const sig = route.tab === 'workout' ? JSON.stringify([banners.map((b) => b.dataset.banner), workoutSignature(ctx)]) : null;
    const open = view.querySelector('[data-view="workout-active"]');
    if (sig !== null && sig === lastSig && open && !sig.endsWith(',null]')) {
      patchWorkoutView(open, ctx);
      return;
    }
    lastSig = sig;
    const focusKey = document.activeElement?.dataset?.input ?? null;
    const sel = focusKey && typeof document.activeElement.selectionStart === 'number' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    nav.replaceChildren(...TABS.map((t) => h('a', { href: `#/${t.id}`, class: t.id === route.tab ? 'on' : '', 'aria-current': t.id === route.tab ? 'page' : undefined }, t.label)));
    const body = [previewBanner(env), ...banners, h('h1', {}, TABS.find((t) => t.id === route.tab).label)];
    if (route.tab === 'manage') body.push(manageView(ctx, route.parts));
    else if (route.tab === 'workout') body.push(workoutView(ctx));
    else if (route.tab === 'history') body.push(historyView(ctx, route.parts));
    else if (route.tab === 'progress') body.push(progressView(ctx, route.parts));
    view.replaceChildren(...body.filter(Boolean));
    if (focusKey) {
      const el = view.querySelector(`[data-input="${CSS.escape(focusKey)}"]`);
      if (el) {
        el.focus();
        if (sel && typeof el.setSelectionRange === 'function') el.setSelectionRange(...sel);
      }
    }
  };
  const router = createRouter((r) => {
    buffer.flushAll(); // a route change commits pending typed values (the draft already holds them)
    route = r;
    draw();
  });
  app.onChange(draw); // also fired on every gate change
  window.addEventListener('storage', (e) => app.handleStorageEvent({ key: e.key, newValue: e.newValue }));
  // Best effort only: these events may not fire (iOS), and an async commit may not finish. The
  // synchronous input draft is what protects typed values.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') buffer.flushAll(); });
  window.addEventListener('pagehide', () => { buffer.flushAll(); });
  window.addEventListener('beforeunload', (e) => {
    if (app.getState().store.unsaved || buffer.state().pendingFields > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  router.start();
  syncRuntime = createSyncRuntime({ app, syncPort, onChange: () => draw() });
  syncRuntime.start();
  // 2e: installable app (production host only); an update waits for pending input and saved data.
  setupPwa({ env, flush: () => buffer.flushAll(), canUpdate: () => !app.getState().store.unsaved && buffer.state().pendingFields === 0 }).catch(() => {});
}

/** Banner E: exports the in-memory state (backup format, unsavedState) via share sheet, download or clipboard. */
async function exportCurrentState(app) {
  const b = await app.createBackup({ partial: true });
  if (!b.ok) {
    alertBox(`הייצוא נכשל (${b.code}).`);
    return;
  }
  const file = new File([b.json], b.fileName, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch {
    // share cancelled or failed → fall back to download
  }
  try {
    const url = URL.createObjectURL(file);
    const a = h('a', { href: url, download: b.fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch {
    // 2a R5 fallback: the same JSON as text on the clipboard
    try {
      await navigator.clipboard.writeText(b.json);
      alertBox('הקובץ לא נשמר, אבל תוכנו הועתק ללוח. הדבק אותו בקובץ ושמור אותו.');
    } catch {
      alertBox('לא ניתן היה לייצא או להעתיק. אל תסגור את האפליקציה ונסה שוב.');
    }
  }
}

function showUsage(app) {
  const u = app.storageUsage();
  if (!u.ok) {
    alertBox(`לא ניתן לקרוא את נפח האחסון (${u.code}).`);
    return;
  }
  alertBox(['נפח לפי מפתח (תווים):', ...u.keys.map((k) => `${k.key}: ${k.chars.toLocaleString('he-IL')}`), `סה״כ: ${u.totalChars.toLocaleString('he-IL')}`].join('\n'));
}

function alertBox(text) {
  const d = h('dialog', { class: 'sheet' }, h('pre', {}, text), h('button', { type: 'button', onclick: () => d.close() }, 'סגור'));
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
}

start().catch((err) => {
  document.getElementById('view').replaceChildren(h('h1', {}, 'שגיאה בטעינה'), h('pre', {}, String(err?.stack ?? err)));
});
