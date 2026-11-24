// Step 2d.5 — History: saved workouts newest first (grouped by month, shown in pages for long
// histories) and the details of one workout. Opening a workout for editing (2d.4) and repeating it
// are actions; there is no deletion here (ordinary commits never remove saved sessions).
import { h, bdi } from './dom.js';
import { formatDate, formatSeconds, localToday } from './format.js';
import { confirmBox, messageBox } from './io.js';
import { messageFor } from './flow-model.js';
import { historyList, sessionDetail } from './history-model.js';
import { warningLabel } from './flow-model.js';

const PAGE = 60;
const fail = async (r) => { if (!r.ok && r.outcome !== 'unsaved') await messageBox(r.code === 'ACTIVE_SESSION_EXISTS' ? 'יש אימון פעיל. סיים או בטל אותו קודם.' : messageFor(r)); return r; };

function listView(ctx) {
  const ui = ctx.historyUi;
  const { total, rows } = historyList(ctx.store, { limit: ui.limit });
  if (total === 0) return h('div', { 'data-view': 'history' }, h('p', { class: 'hint', 'data-empty': 'true' }, 'עדיין אין אימונים שמורים. אימון שמסיימים נשמר כאן.'));
  const out = [];
  let month = null;
  let list = null;
  for (const r of rows) {
    if (r.month !== month) {
      month = r.month;
      list = h('ul', { class: 'history' });
      out.push(h('h3', { class: 'month' }, month), list);
    }
    list.append(h('li', {}, h('a', { class: 'history-row', href: `#/history/${encodeURIComponent(r.id)}`, 'data-session': r.id },
      h('span', { class: 'history-date' }, formatDate(r.date)),
      h('span', { class: 'history-title' }, r.title ? bdi(r.title) : bdi(r.exercises.slice(0, 2).join(' · ') || 'אימון')),
      h('span', { class: 'history-meta' }, `${r.exerciseCount} תרגילים · ${r.sets} סטים`,
        r.originLabel ? h('span', { class: 'badge' }, r.originLabel) : null,
        r.recovered ? h('span', { class: 'badge' }, 'עותק משוחזר') : null,
        r.unresolved ? h('span', { class: 'badge badge-warn' }, `${r.unresolved} לא מזוהים`) : null))));
  }
  return h('div', { 'data-view': 'history' },
    h('p', { class: 'hint' }, `${total} אימונים`),
    ...out,
    rows.length < total ? h('button', { type: 'button', 'data-id': 'more', onclick: () => { ui.limit += PAGE; ctx.rerender(); } }, `הצג עוד (${total - rows.length})`) : null);
}

function setLine(p, x) {
  const parts = [h('span', { class: 'set-n' }, `${x.order}`)];
  if (p.unresolved) parts.push(h('span', { class: 'set-v' }, 'ערכים מקוריים נשמרו (ראה פרטי מקור)'));
  else parts.push(h('span', { class: 'set-v', dir: 'ltr' }, x.text, x.pace ? ` · ${formatSeconds(x.pace)}/ק״מ` : ''));
  parts.push(h('span', { class: 'set-c' }, x.completed ? '✓' : ''));
  return h('li', { class: x.completed ? 'set done' : 'set' }, ...parts);
}

function detailView(ctx, sessionId) {
  const d = sessionDetail(ctx.store, sessionId);
  const back = h('a', { href: '#/history', class: 'button', 'data-id': 'back' }, '→ להיסטוריה');
  if (!d) return h('div', { 'data-view': 'history-detail' }, h('p', {}, 'האימון לא נמצא.'), back);
  const edit = async () => {
    const r = await fail(await ctx.actions.startEdit({ sessionId }));
    if (r.ok) ctx.go('workout');
  };
  const repeat = async () => {
    const lost = d.uncopyable ? `\n${d.uncopyable} תרגילים לא מזוהים לא יועתקו.` : '';
    if (!(await confirmBox(`להתחיל אימון חדש היום עם אותם תרגילים וערכים?${lost}`, { confirmLabel: 'התחל' }))) return;
    const r = await fail(await ctx.actions.repeatWorkout({ sessionId, date: localToday() }));
    if (r.ok) ctx.go('workout');
  };
  const remove = async () => {
    const imported = d.originLabel && d.importText;
    const text = imported
      ? 'למחוק אימון מיובא? הוא יימחק מכל המכשירים. קובץ המקור שיובא נשאר בגיבויים ובהיסטוריית הייבוא.'
      : 'למחוק את האימון? הוא יימחק מכל המכשירים ולא ישפיע עוד על שיאים והשוואות.';
    if (!(await confirmBox(text, { confirmLabel: 'מחק', danger: true }))) return;
    const r = await fail(await ctx.actions.deleteWorkout({ sessionId, confirmImported: true }));
    if (r.ok) ctx.go('history');
  };
  return h('div', { 'data-view': 'history-detail', 'data-session': d.id },
    back,
    h('h2', {}, d.title ? bdi(d.title) : 'אימון'),
    h('p', { class: 'hint' }, formatDate(d.date), d.originLabel ? ` · ${d.originLabel}` : '', d.importText ? ` (${d.importText})` : ''),
    d.recovery ? h('p', { class: 'note note-info' }, `עותק שנשמר מעריכה שהתנגשה (${d.recovery.conflictKind === 'target_missing' ? 'האימון המקורי לא נמצא' : 'האימון המקורי השתנה'}).`) : null,
    d.note ? h('p', { class: 'session-note' }, bdi(d.note)) : null,
    d.warnings.length ? h('details', {}, h('summary', {}, `אזהרות (${d.warnings.length})`), h('ul', {}, ...d.warnings.map((w) => h('li', {}, warningLabel(w.code ?? w))))) : null,
    ...d.performances.map((p) => h('section', { class: 'card perf', 'data-performance': p.id },
      h('h3', {}, h('span', { class: 'perf-order' }, `${p.order}.`), ' ', bdi(p.name)),
      p.unresolved ? h('p', { class: 'note note-warn' }, 'תרגיל לא מזוהה — הערכים המקוריים נשמרו כפי שהם.') : null,
      p.labels.length ? h('p', { class: 'hint' }, p.labels.join(' · ')) : null,
      p.type === 'note' ? h('p', { class: 'perf-note' }, p.note ? bdi(p.note) : '—') : h('ol', { class: 'sets' }, ...p.sets.map((x) => setLine(p, x))),
      ...p.sets.filter((x) => x.basis || x.splits.length).map((x) => h('details', {}, h('summary', {}, `סט ${x.order}: ${x.basis === 'elapsed' ? 'זמן כולל' : x.basis === 'moving' ? 'זמן תנועה' : 'בסיס זמן לא צוין'}${x.splits.length ? ` · ${x.splits.length} הקפות` : ''}`),
        h('ul', {}, ...x.splits.map((sp) => h('li', { dir: 'ltr', class: sp.usable ? null : 'hint' }, sp.text, sp.usable ? '' : ' (לא בשימוש)'))))),
      ...(p.sets.some((x) => x.source !== null) ? [h('details', { class: 'source' }, h('summary', {}, 'פרטי מקור'), h('pre', { class: 'raw' }, p.sets.filter((x) => x.source !== null).map((x) => `${x.order}: ${JSON.stringify(x.source)}`).join('\n')))] : []))),
    h('div', { class: 'row' },
      d.activeIsThis ? h('button', { type: 'button', class: 'pri', onclick: () => ctx.go('workout') }, 'המשך לערוך') : h('button', { type: 'button', class: 'pri', 'data-id': 'edit', disabled: !d.editable, onclick: edit }, 'ערוך'),
      h('button', { type: 'button', 'data-id': 'repeat', disabled: !d.editable, onclick: repeat }, 'חזור על האימון'),
      h('button', { type: 'button', class: 'danger', 'data-id': 'delete', disabled: !d.editable, onclick: remove }, 'מחק')),
    d.editable ? null : h('p', { class: 'hint' }, d.activeIsThis ? 'האימון פתוח לעריכה בלשונית אימון.' : 'יש אימון פעיל: סיים או בטל אותו כדי לערוך או לחזור על אימון.'));
}

/** The History tab content: #/history or #/history/<sessionId>. */
export function historyView(ctx, parts) {
  return parts[0] ? detailView(ctx, parts[0]) : listView(ctx);
}
