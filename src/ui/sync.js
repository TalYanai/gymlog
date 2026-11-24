// Sync UI: device-local settings (token), status, manual "sync now", conflict review, and the runtime that
// keeps the engine running (after local writes, on reconnect, on return to the app, periodically).
// The token is stored only in this browser (localStorage key below) — never in the store, a backup or the repo.
import { h } from './dom.js';
import { createSyncEngine, createHttpTransport } from '../sync/engine.js';
import { takeConflict } from '../sync/local.js';
import { confirmBox, messageBox } from './io.js';

export const SYNC_CONFIG_KEY = 'gymlog.sync.config';

export function createLocalConfig(storage = globalThis.localStorage) {
  const read = () => { try { return JSON.parse(storage.getItem(SYNC_CONFIG_KEY) ?? 'null') ?? {}; } catch { return {}; } };
  return {
    get: () => read(),
    set: (c) => { try { storage.setItem(SYNC_CONFIG_KEY, JSON.stringify(c)); } catch { /* storage unavailable: sync stays off */ } },
    clear: () => { try { storage.removeItem(SYNC_CONFIG_KEY); } catch { /* ignore */ } },
  };
}

const rid = () => crypto.randomUUID().replaceAll('-', '').slice(0, 20);

/** Starts the engine and its triggers. Returns { engine, config, start(), setToken(t), forget() }. */
export function createSyncRuntime({ app, syncPort, onChange, fetchFn, config = createLocalConfig() }) {
  const engine = createSyncEngine({
    port: syncPort,
    transport: createHttpTransport({ getToken: () => config.get().token ?? '', fetchFn }),
    config, onChange,
    newOpId: () => `op_${rid()}`, newDeviceId: () => `dev_${rid()}`,
  });
  let timer = null;
  const pending = () => app.snapshot().store?.sync?.outbox?.length ?? 0;
  const soon = (ms = 1500) => { clearTimeout(timer); timer = setTimeout(() => { if (config.get().token) engine.sync(); }, ms); };
  function start() {
    engine.refresh();
    // Triggers are always installed; each one checks for a token, so entering the token later needs no restart.
    app.onChange(() => { if (config.get().token && pending() > 0) soon(); });
    window.addEventListener('online', () => soon(200));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(200); });
    setInterval(() => { if (config.get().token && document.visibilityState === 'visible') engine.sync(); }, 30000);
    if (config.get().token) engine.sync();
  }
  return {
    engine, config, start,
    setToken: (t) => { config.set({ ...config.get(), token: t.trim() }); return engine.sync(); },
    forget: () => { const c = config.get(); config.set({ deviceId: c.deviceId }); engine.refresh(); },
  };
}

const REASONS = {
  stale_write: 'שינוי שלך התנגש עם שינוי חדש יותר בשרת',
  remote_changed: 'האימון שונה במכשיר אחר בזמן שערכת אותו',
  join_differs: 'גרסה שונה במכשיר הזה לפני החיבור הראשון',
  deleted_remotely: 'האימון נמחק במכשיר אחר',
  possible_duplicate: 'ייתכן שזו כפילות של אימון קיים (אותו מקור)',
};
const PHASES = { off: 'סנכרון כבוי', idle: 'מסונכרן', syncing: 'מסנכרן…', offline: 'אין חיבור — השינויים נשמרים במכשיר ויסונכרנו אחר כך', reconcile: 'מאחד היסטוריה…', blocked: 'ממתין לסיום פעולה אחרת', error: 'שגיאה' };
const ERRORS = { AUTH: 'הקוד שגוי או לא תקף.' };

export function syncCard(ctx) {
  const rt = ctx.sync;
  if (!rt) return null;
  const st = rt.engine.getStatus();
  const cfg = rt.config.get();
  const s = ctx.store.sync;
  const token = h('input', { type: 'password', class: 'in', dir: 'ltr', autocomplete: 'off', 'data-field': 'sync-token', placeholder: 'קוד סנכרון' });
  const conflicts = s?.conflicts ?? [];
  const keepMine = async (c) => {
    if (c.type === 'session' && !c.deleted) {
      const r = await ctx.actions.restoreSessionVersion({ payload: c.payload });
      if (!r.ok) return messageBox(`לא ניתן לשחזר את הגרסה שלך (${r.code}).`);
    }
    await rt.engine.dismissConflict(c.cid);
    ctx.rerender();
  };
  const dismiss = async (c) => {
    if (!(await confirmBox('להשאיר את הגרסה המשותפת ולסגור את הגרסה השמורה? לא ניתן לשחזר אותה אחר כך.', { confirmLabel: 'סגור', danger: true }))) return;
    await rt.engine.dismissConflict(c.cid);
    ctx.rerender();
  };
  return h('section', { class: 'card', 'data-section': 'sync' },
    h('h3', {}, 'סנכרון בין מכשירים'),
    h('p', { class: 'hint', 'data-id': 'sync-status' }, PHASES[st.phase] ?? st.phase, st.lastError ? ` · ${ERRORS[st.lastError] ?? st.lastError}` : '', st.lastSyncAt ? ` · אחרון: ${new Date(st.lastSyncAt).toLocaleString('he-IL')}` : '', s ? ` · ממתינים: ${s.outbox.length}` : ''),
    cfg.token ? null : h('p', { class: 'hint' }, 'הזן את קוד הסנכרון (אותו קוד בכל המכשירים). הוא נשמר רק בדפדפן הזה.'),
    h('label', {}, cfg.token ? 'החלפת קוד' : 'קוד סנכרון', token),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'pri', 'data-id': 'sync-save', onclick: async () => { if (!token.value.trim()) return; await rt.setToken(token.value); ctx.rerender(); } }, cfg.token ? 'שמור קוד' : 'הפעל סנכרון'),
      cfg.token ? h('button', { type: 'button', 'data-id': 'sync-now', onclick: async () => { await rt.engine.sync(); ctx.rerender(); } }, 'סנכרן עכשיו') : null,
      cfg.token ? h('button', { type: 'button', 'data-id': 'sync-off', onclick: () => { rt.forget(); ctx.rerender(); } }, 'נתק מכשיר') : null),
    conflicts.length ? h('div', { 'data-id': 'sync-conflicts' },
      h('h3', {}, `לבדיקה (${conflicts.length})`),
      h('p', { class: 'hint' }, 'שום דבר לא נמחק: הגרסה המשותפת פעילה, והגרסה של המכשיר הזה נשמרה כאן.'),
      ...conflicts.map((c) => h('div', { class: 'card', 'data-conflict': c.cid },
        h('p', {}, `${c.type === 'session' ? 'אימון' : c.type}${c.payload?.date ? ` · ${c.payload.date}` : ''}`),
        h('p', { class: 'hint' }, REASONS[c.reason] ?? c.reason),
        h('div', { class: 'row' },
          c.type === 'session' && !c.deleted ? h('button', { type: 'button', 'data-id': 'conflict-mine', onclick: () => keepMine(c) }, 'השתמש בגרסה שלי') : null,
          h('button', { type: 'button', 'data-id': 'conflict-dismiss', onclick: () => dismiss(c) }, 'השאר את המשותפת'))))) : null);
}

export { takeConflict };
