// Save-state status bar (Step 2d.0) — banner E of the 2a design (R5) plus the saving / pending /
// unprotected-typing indications. statusModel is pure (tested); renderStatus draws it.
// Rule: the bar never says "saved" — it only reports problems and work in progress.
import { h } from './dom.js';

/**
 * @param {object} a
 * @param {object} a.app        app.getState(): { gate, busy, store: { unsaved, stale, saveError } }
 * @param {{saving:number, protection:{state:string, code:string|null}, pendingFields:number}} [a.input]
 * @returns {{level:'ok'|'pending'|'saving'|'warn'|'stale'|'error'|'busy', title:string, detail:string|null, actions:string[]}}
 */
export function statusModel({ app, input = { saving: 0, protection: { state: 'ok', code: null }, pendingFields: 0 } }) {
  const st = app?.store ?? {};
  if (app?.gate === 'busy' || app?.busy) return { level: 'busy', title: 'שומר…', detail: null, actions: [] };
  if (st.unsaved) {
    return {
      level: 'error',
      title: 'השינויים לא נשמרו במכשיר',
      detail: 'הם קיימים כרגע רק בזיכרון. רענון, סגירת האפליקציה או השארתה ברקע זמן רב עלולים לגרום לאובדנם. אל תסגור ואל תרענן עד שהשמירה תצליח.',
      actions: ['exportCurrent', 'retrySave', 'why'],
    };
  }
  if (st.stale) return { level: 'stale', title: 'הנתונים עודכנו בחלון אחר', detail: 'כדי לא לדרוס אותם, טען מחדש לפני שתמשיך.', actions: ['reload'] };
  if (input.protection?.state === 'failed') {
    return {
      level: 'warn',
      title: 'ההקלדה האחרונה אינה מוגנת במכשיר',
      detail: 'לא ניתן היה לשמור טיוטה של הערך. הוא יישמר רק כשהשמירה הרגילה תצליח — אל תסגור את האפליקציה עד אז.',
      actions: input.saving > 0 ? [] : ['flushNow'],
    };
  }
  if (input.saving > 0) return { level: 'saving', title: 'שומר…', detail: null, actions: [] };
  if (input.pendingFields > 0) return { level: 'pending', title: 'ממתין לשמירה', detail: null, actions: [] };
  return { level: 'ok', title: '', detail: null, actions: [] };
}

export const STATUS_ACTION_LABELS = Object.freeze({
  exportCurrent: 'ייצא את המצב הנוכחי',
  retrySave: 'נסה לשמור שוב',
  why: 'למה זה קרה?',
  reload: 'טען מחדש',
  flushNow: 'שמור עכשיו',
});

/** Draws the model into `el`; `on(actionId)` handles a button. */
export function renderStatus(el, model, on) {
  el.replaceChildren();
  el.className = `status status-${model.level}`;
  el.hidden = model.level === 'ok';
  if (model.level === 'ok') return;
  el.append(h('strong', {}, model.title));
  if (model.detail) el.append(h('p', {}, model.detail));
  if (model.actions.length) {
    el.append(h('div', { class: 'status-actions' }, ...model.actions.map((id, i) => h('button', { type: 'button', class: i === 0 ? 'pri' : '', onclick: () => on(id) }, STATUS_ACTION_LABELS[id]))));
  }
}
