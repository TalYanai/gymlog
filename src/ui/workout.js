// Step 2d.2 — the Workout tab: template selection (one tap starts the workout, no start screen).
// Step 2d.3 — active workout logging: editable set values (input buffer: synchronous draft per
// keystroke + debounced per-set commit), ✓ (values + completion in ONE commit), add / remove sets
// and exercises, notes, finishing (core finishSummary / commitSession) and recovery of typed values
// at launch. Every change is an action (actions.js → core); this file only draws the snapshot.
// While the user types, store changes PATCH the open view (values of unfocused inputs, ✓ state) so
// the focused field and the phone keyboard stay where they are; the view is rebuilt only when its
// structure changes (sets or exercises added / removed).
import { h, bdi } from './dom.js';
import { formatDate, localToday } from './format.js';
import { confirmBox, messageBox, choiceBox } from './io.js';
import { messageFor } from './flow-model.js';
import { parseFieldInput } from './input-parse.js';
import {
  templateList, activeWorkoutModel, hasUnsavedWork, exercisePicker, preferredGroup, committedText, finishModel, finishText, recoveryRows, DURATION_BASIS_LABELS,
  setFields, sourceValues,
} from './workout-model.js';

const DOMAIN_MESSAGES = {
  ACTIVE_SESSION_EXISTS: 'כבר יש אימון פעיל.',
  NO_ACTIVE_SESSION: 'אין אימון פעיל.',
  NOT_FOUND: 'האימון השתנה בינתיים. נסה שוב.',
  UNRESOLVED_EXERCISE: 'אי אפשר להוסיף תרגיל לא מזוהה.',
  EDIT_CONFLICT: 'האימון בעריכה התנגש בשינוי מחלון אחר.',
  CANCEL_WOULD_LOSE_PRESERVED: 'אי אפשר לבטל: יש תרגילים שמורים שטרם הועברו להסגר.',
  NEEDS_CONFIRMATION: 'האימון השתנה מאז הסיכום. נסה לסיים שוב.',
  PRESERVED_PERFORMANCE: 'תרגיל שמור מהגרסה הקודמת אינו ניתן לשינוי כאן.',
  INPUT_INVALID: 'ערך לא תקין.',
  SOURCE_SET_PROTECTED: 'סט מיובא אינו נמחק, כדי שהמקור לא יאבד. אפשר לתקן את הערכים, להעביר אותו לתרגיל אחר או לבטל את ✓.',
  PRESERVED_ID_INVALID: 'התרגיל הזה כבר טופל.',
};
const failText = (r) => DOMAIN_MESSAGES[r.code] ?? messageFor(r);

/** Shows a refused or failed write; "unsaved" is shown by banner E, not here. */
async function report(r) {
  if (!r.ok && r.outcome !== 'unsaved') await messageBox(failText(r)); // unsaved: banner E explains and offers retry
  return r;
}

// ---- selection --------------------------------------------------------------------------------------
function selectionView(ctx) {
  const ui = ctx.workoutUi;
  const start = async (templateId) => {
    if (ui.starting) return; // one tap = one workout
    ui.starting = true;
    ctx.rerender();
    try {
      await report(await ctx.actions.startWorkout({ templateId, date: localToday() }));
    } finally {
      ui.starting = false;
      ctx.rerender();
    }
  };
  const templates = templateList(ctx.store);
  return h('div', { 'data-view': 'workout-select' },
    recoveryPanel(ctx),
    h('p', { class: 'hint' }, 'בחר אימון — הוא נפתח מיד.'),
    h('ul', { class: 'templates' }, ...templates.map((t) => h('li', {},
      h('button', { type: 'button', class: 'template', disabled: ui.starting, 'data-template': t.id, onclick: () => start(t.id) },
        h('span', { class: 'template-name' }, bdi(t.name)),
        h('span', { class: 'template-meta' },
          t.variable ? 'אימון משתנה · מוסיפים תרגילים תוך כדי' : `${t.exerciseCount} תרגילים`,
          t.lastDate ? ` · אחרון ${formatDate(t.lastDate)}` : ''),
        t.exercises.length ? h('span', { class: 'template-list' }, bdi(t.exercises.join(' · '))) : null)))),
    h('button', { type: 'button', class: 'template template-empty', disabled: ui.starting, 'data-template': '', onclick: () => start(null) }, 'אימון ריק'));
}

// ---- recovery of typed values (launch) ------------------------------------------------------------------
const rowKey = (it) => `${it.key}|${it.field}`;

/** Checked once per page load, before anything is typed in this window. */
function checkRecovery(ctx) {
  const ui = ctx.workoutUi;
  if (ui.recoveryChecked) return;
  ui.recoveryChecked = true;
  const plan = ctx.buffer.planRecovery(ctx.store);
  if (!plan.ok) {
    ui.recovery = { error: plan.code };
    return;
  }
  if (plan.unreadable) {
    ui.recovery = { unreadable: plan.unreadable };
    return;
  }
  const already = plan.items.filter((it) => it.status === 'already');
  if (already.length) ctx.buffer.dismissRecovered(already); // identical to what is saved: nothing to decide
  const rows = recoveryRows(ctx.store, plan.items);
  ui.recovery = rows.length ? { rows, choices: {} } : null;
}

function recoveryPanel(ctx) {
  const ui = ctx.workoutUi;
  const rec = ui.recovery;
  if (!rec) return null;
  if (rec.error) return h('section', { class: 'card', 'data-panel': 'recovery' }, h('p', { class: 'note note-warn' }, 'לא ניתן היה לקרוא ערכים שהוקלדו ולא נשמרו.'), h('button', { type: 'button', onclick: () => { ui.recovery = null; ui.recoveryChecked = false; ctx.rerender(); } }, 'נסה שוב'));
  if (rec.unreadable) {
    return h('section', { class: 'card', 'data-panel': 'recovery' },
      h('h2', {}, 'ערכים שהוקלדו לא ניתנים לקריאה'),
      h('p', { class: 'hint' }, 'הקובץ הזמני של הערכים שהוקלדו פגום. תוכנו מוצג כאן; עד שיימחק, הקלדה חדשה אינה מוגנת.'),
      h('pre', { class: 'raw' }, rec.unreadable.raw),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!(await confirmBox('למחוק את התוכן הפגום? אפשר להעתיק אותו קודם.', { confirmLabel: 'מחק', danger: true }))) return;
        const r = ctx.app.clearInputDraft(rec.unreadable.raw);
        if (!r.ok) return report(r);
        ui.recovery = null;
        return ctx.rerender();
      } }, 'מחק את התוכן הפגום'));
  }
  const { rows, choices } = rec;
  const conflicts = rows.filter((r) => r.status === 'conflict');
  const ready = conflicts.every((r) => choices[rowKey(r)]);
  const statusText = {
    apply: 'יוחזר', conflict: 'הערך השמור השתנה אחרי ההקלדה — בחר', invalid: 'לא תקין — לא יוחזר', blocked: 'ממתין: האימון בעריכה מתנגש', orphan: 'הסט כבר לא קיים — לא יוחזר',
  };
  const choose = (k, v) => { choices[k] = v; ctx.rerender(); };
  const resolve = async () => {
    const apply = rows.filter((r) => r.status === 'apply' || (r.status === 'conflict' && choices[rowKey(r)] === 'typed'));
    const drop = rows.filter((r) => r.status === 'invalid' || r.status === 'orphan' || (r.status === 'conflict' && choices[rowKey(r)] === 'saved'));
    if (apply.length) {
      const results = await ctx.buffer.applyRecovered(apply);
      const bad = results.find((x) => !x.ok);
      if (bad) return report(bad); // the draft keeps everything that was not applied
    }
    if (drop.length) ctx.buffer.dismissRecovered(drop);
    const blocked = rows.filter((r) => r.status === 'blocked');
    ui.recovery = blocked.length ? { rows: blocked, choices: {} } : null;
    return ctx.rerender();
  };
  return h('section', { class: 'card', 'data-panel': 'recovery' },
    h('h2', {}, 'ערכים שהוקלדו ולא נשמרו'),
    h('p', { class: 'hint' }, 'נמצאו ערכים מההקלדה האחרונה. ערך שמור חדש יותר לא יידרס בלי בחירה שלך.'),
    h('ul', { class: 'recovery' }, ...rows.map((r) => h('li', { 'data-recovery': r.status },
      h('div', {}, r.exercise ? bdi(r.exercise) : 'סט שלא קיים', r.setOrder ? ` · סט ${r.setOrder}` : '', ` · ${r.fieldLabel}: `, h('b', { dir: 'ltr' }, r.text || '(ריק)'),
        r.savedText !== null ? h('span', { class: 'hint' }, ` (שמור: ${r.savedText || 'ריק'})`) : null),
      h('div', { class: 'hint' }, statusText[r.status]),
      r.status === 'conflict' ? h('div', { class: 'row' },
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: rowKey(r), checked: choices[rowKey(r)] === 'typed', onchange: () => choose(rowKey(r), 'typed') }), 'השתמש בערך שהוקלד'),
        h('label', { class: 'radio' }, h('input', { type: 'radio', name: rowKey(r), checked: choices[rowKey(r)] === 'saved', onchange: () => choose(rowKey(r), 'saved') }), 'השאר את השמור')) : null))),
    rows.every((r) => r.status === 'blocked') ? null : h('button', { type: 'button', class: 'pri', disabled: !ready, 'data-id': 'resolve-recovery', onclick: resolve }, 'החזר והמשך'));
}

// ---- active workout ---------------------------------------------------------------------------------
function targetText(t) {
  if (!t) return null;
  const parts = [];
  if (t.plannedSets > 0) parts.push(`${t.plannedSets} סטים`);
  if (t.reps) parts.push(`${t.reps} חזרות`);
  if (t.note) parts.push(t.note);
  if (t.variable && t.plannedSets > 0) parts.push('יעד משתנה');
  return parts.length ? parts.join(' · ') : null;
}

const inputKey = (identity, field) => `${identity.sessionId}|${identity.performanceId}|${identity.setId}|${field}`;
/** What an input shows: the pending typed text if any, else the committed value. */
const shownText = (ctx, identity, field, value) => ctx.buffer.pendingText(identity, field) ?? committedText(field, value);
const isInvalid = (field, text) => !parseFieldInput(field, text).ok;

function focusNext(from) {
  const all = [...document.querySelectorAll('[data-view="workout-active"] [data-input]')];
  const i = all.indexOf(from);
  if (i >= 0 && i + 1 < all.length) all[i + 1].focus();
  else from.blur();
}

function setRow(ctx, p, x, identity, editable) {
  const typed = (el, field, value) => {
    ctx.buffer.type(identity, field, el.value, value);
    el.setAttribute('aria-invalid', String(isInvalid(field, el.value)));
  };
  const inputs = p.fields.map((f) => {
    const text = shownText(ctx, identity, f.field, x.values[f.field]);
    const el = h('input', {
      type: 'text', inputmode: f.inputmode, enterkeyhint: 'next', autocomplete: 'off', dir: 'ltr', class: `in in-${f.field}`,
      'aria-label': `${f.label} · סט ${x.order}`, value: text, disabled: !editable,
      'aria-invalid': String(isInvalid(f.field, text)), 'data-input': inputKey(identity, f.field), 'data-field': f.field,
    });
    el.addEventListener('input', () => typed(el, f.field, x.values[f.field]));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); focusNext(el); } });
    return el;
  });
  const basis = p.type === 'distance_duration'
    ? h('select', { class: 'in in-basis', disabled: !editable, 'aria-label': `בסיס זמן · סט ${x.order}`, 'data-input': inputKey(identity, 'durationBasis'), 'data-field': 'durationBasis' },
      ...Object.entries(DURATION_BASIS_LABELS).map(([v, label]) => h('option', { value: v, selected: (shownText(ctx, identity, 'durationBasis', x.values.durationBasis) || '') === v }, label)))
    : null;
  if (basis) {
    basis.addEventListener('change', async () => {
      ctx.buffer.type(identity, 'durationBasis', basis.value, x.values.durationBasis);
      await report(await ctx.buffer.flush(identity));
    });
  }
  const tick = h('button', {
    type: 'button', class: 'tick', disabled: !editable, 'aria-pressed': String(x.completed), 'aria-label': `סמן סט ${x.order}`, 'data-tick': x.id,
    onclick: async () => {
      // A set is never completed with a value that does not parse: the user fixes it first.
      for (const f of [...p.fields, ...(basis ? [{ field: 'durationBasis' }] : [])]) {
        const t = ctx.buffer.pendingText(identity, f.field);
        if (t !== undefined && isInvalid(f.field, t)) {
          await messageBox(`ערך לא תקין: "${t}"`);
          document.querySelector(`[data-input="${CSS.escape(inputKey(identity, f.field))}"]`)?.focus();
          return;
        }
      }
      const done = document.querySelector(`[data-tick="${CSS.escape(x.id)}"]`)?.getAttribute('aria-pressed') === 'true';
      await report(await ctx.buffer.complete(identity, !done));
    },
  }, '✓');
  const del = h('button', {
    type: 'button', class: 'del', disabled: !editable, 'aria-label': `מחק סט ${x.order}`, 'data-del': x.id,
    onclick: async () => {
      const hasValues = Object.values(x.values).some((v) => v !== null) || p.fields.some((f) => (ctx.buffer.pendingText(identity, f.field) ?? '') !== '');
      if (hasValues && !(await confirmBox(`למחוק את סט ${x.order} עם הערכים שלו?`, { confirmLabel: 'מחק', danger: true }))) return;
      const r = await report(await ctx.actions.removeSet({ sessionId: identity.sessionId, performanceId: p.id, setId: x.id }));
      if (r.ok) ctx.buffer.discardSet(identity); // the user removed the set: its typed values go with it
    },
  }, '×');
  return h('li', { class: x.completed ? 'set done' : 'set', 'data-set': x.id },
    h('span', { class: 'set-n' }, `${x.order}`), h('div', { class: 'set-fields' }, ...inputs, basis), tick,
    x.source ? h('span', { class: 'del', 'aria-hidden': 'true' }, '') : del,
    x.source ? h('p', { class: 'set-source hint', 'data-source': x.id }, ...x.source.split(' · ').flatMap((part, i) => [i ? ' · ' : null, bdi(part)])) : null);
}

function performanceCard(ctx, p, sessionId, editableSession) {
  const editable = editableSession && !p.preserved;
  const sourced = p.sets.some((x) => x.source);
  const model = ctx.workoutModel;
  const correcting = editable && model?.mode === 'edit'; // corrections belong to editing a saved workout
  const sameType = (model?.performances ?? []).filter((q) => q.id !== p.id && !q.preserved && q.type === p.type);
  const head = h('div', { class: 'perf-head' },
    h('h3', {}, h('span', { class: 'perf-order' }, `${p.order}.`), ' ', bdi(p.name)),
    correcting && p.type !== 'note' ? h('button', { type: 'button', class: 'link small', 'data-change-perf': p.id, onclick: () => changeExerciseFlow(ctx, p, sessionId) }, 'החלף תרגיל') : null,
    correcting && p.type !== 'note' && sameType.length && p.sets.length ? h('button', { type: 'button', class: 'link small', 'data-move-set': p.id, onclick: () => moveSetFlow(ctx, p, sameType, sessionId) }, 'העבר סט') : null,
    editableSession && p.preserved ? h('button', { type: 'button', class: 'link small', 'data-resolve': p.id, onclick: () => resolveFlow(ctx, p, sessionId) }, 'שייך לתרגיל') : null,
    editable && !sourced ? h('button', { type: 'button', class: 'link small', 'data-remove-perf': p.id, onclick: async () => {
      if (!(await confirmBox(`להסיר את ${p.name} מהאימון?`, { confirmLabel: 'הסר', danger: true }))) return;
      const r = await report(await ctx.actions.removeExercise({ sessionId, performanceId: p.id }));
      if (r.ok) ctx.buffer.discardPerformance(sessionId, p.id);
    } }, 'הסר') : null);
  const body = [];
  if (p.type === 'note') {
    const ta = h('textarea', { class: 'perf-note-in', rows: 3, disabled: !editable, placeholder: 'מה עשית באימון', 'data-note': p.id, dir: 'auto' });
    ta.value = p.note ?? '';
    ta.addEventListener('change', async () => { await report(await ctx.actions.setNote({ sessionId, performanceId: p.id, note: ta.value })); });
    body.push(ta);
  } else if (p.preserved) {
    body.push(h('p', { class: 'note note-warn' }, editableSession ? 'תרגיל לא מזוהה מהייבוא — נשמר כפי שהוא. "שייך לתרגיל" מעביר את ערכיו לתרגיל קיים; המקור נשמר.' : 'תרגיל לא מזוהה מהייבוא — נשמר כפי שהוא.'),
      h('ol', { class: 'sets' }, ...p.sets.map((x) => h('li', { class: 'set' }, h('span', { class: 'set-n' }, `${x.order}`), h('span', { class: 'set-v', dir: 'auto' }, x.source ?? x.text)))));
  } else {
    body.push(
      h('div', { class: 'set-labels', 'aria-hidden': 'true' }, h('span', {}, 'סט'), h('div', { class: 'set-fields' }, ...p.fields.map((f) => h('span', {}, f.label)), p.type === 'distance_duration' ? h('span', {}, 'בסיס') : null), h('span', {}, ''), h('span', {}, '')),
      h('ol', { class: 'sets' }, ...p.sets.map((x) => setRow(ctx, p, x, { sessionId, performanceId: p.id, setId: x.id }, editable))),
      editable ? h('button', { type: 'button', class: 'add-set', 'data-add-set': p.id, onclick: async () => { await report(await ctx.actions.addSet({ sessionId, performanceId: p.id })); } }, '+ סט') : null);
  }
  return h('section', { class: 'card perf', 'data-performance': p.id },
    head, targetText(p.target) ? h('p', { class: 'hint' }, targetText(p.target)) : null, ...body);
}

function pickerDialog(ctx, model, onPick = null) {
  const d = h('dialog', { class: 'sheet picker', 'data-dialog': 'picker' });
  const list = h('div', { class: 'picker-list' });
  const search = h('input', { type: 'search', placeholder: 'חיפוש תרגיל', 'aria-label': 'חיפוש תרגיל', autocomplete: 'off', dir: 'auto' });
  let busy = false;
  const add = async (exerciseId) => {
    if (busy) return;
    busy = true;
    if (onPick) {
      d.close();
      busy = false;
      return onPick(exerciseId);
    }
    const r = await report(await ctx.actions.addExercise({ sessionId: ctx.store.activeSession.session.id, exerciseId }));
    busy = false;
    if (r.ok) d.close();
  };
  const fill = () => {
    const groups = exercisePicker(ctx.store, search.value, { preferGroup: preferredGroup(model) });
    list.replaceChildren(...(groups.length ? groups.map((g) => h('div', { class: 'picker-group' },
      h('h4', {}, g.group),
      ...g.exercises.map((e) => h('button', { type: 'button', class: 'picker-item', 'data-exercise': e.id, onclick: () => add(e.id) }, bdi(e.name))))) : [h('p', { class: 'hint' }, 'לא נמצא תרגיל.')]));
  };
  search.addEventListener('input', fill); // redraws only the list: the search field keeps focus
  fill();
  d.append(h('div', { class: 'row' }, search, h('button', { type: 'button', onclick: () => d.close() }, 'סגור')), list);
  d.addEventListener('close', () => d.remove());
  return d;
}

// ---- launch: corrections ---------------------------------------------------------------------------------
function openPicker(ctx, onPick) {
  const d = pickerDialog(ctx, ctx.workoutModel, onPick);
  document.body.append(d);
  d.showModal();
}
const exName = (ctx, id) => ctx.store.exercises.find((e) => e.id === id)?.name ?? id;

/** Replace the exercise of a performance; values the new type cannot hold are cleared only after confirming. */
function changeExerciseFlow(ctx, p, sessionId) {
  openPicker(ctx, async (exerciseId) => {
    await ctx.buffer.flushAll();
    if (!(await confirmBox(`להחליף את ${p.name} ב-${exName(ctx, exerciseId)}? הסטים נשארים; המקור המיובא נשמר.`, { confirmLabel: 'החלף' }))) return;
    let r = await ctx.actions.changeExercise({ sessionId, performanceId: p.id, exerciseId });
    if (!r.ok && r.code === 'NEEDS_CONFIRMATION') {
      if (!(await confirmBox('בתרגיל החדש אין חלק מהשדות, וערכיהם יימחקו מהסטים (המקור המיובא נשמר). להמשיך?', { confirmLabel: 'המשך', danger: true }))) return;
      r = await ctx.actions.changeExercise({ sessionId, performanceId: p.id, exerciseId, confirmClear: true });
    }
    await report(r);
  });
}

/** Move one set (with its source) to another exercise of the same type in this workout. */
function moveSetFlow(ctx, p, targets, sessionId) {
  let setId = p.sets[0].id;
  let to = targets[0].id;
  const d = h('dialog', { class: 'sheet', 'data-dialog': 'move-set' },
    h('h2', {}, `העבר סט מ-${p.name}`),
    h('label', { class: 'field' }, 'סט', h('select', { class: 'in', 'data-move-from': p.id, onchange: (ev) => { setId = ev.target.value; } }, ...p.sets.map((x) => h('option', { value: x.id }, `${x.order}: ${x.text}`)))),
    h('label', { class: 'field' }, 'אל', h('select', { class: 'in', 'data-move-to': p.id, onchange: (ev) => { to = ev.target.value; } }, ...targets.map((q) => h('option', { value: q.id }, `${q.order}. ${q.name}`)))),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'pri', 'data-move-confirm': p.id, onclick: async () => {
        d.close();
        await ctx.buffer.flushAll();
        await report(await ctx.actions.moveSet({ sessionId, performanceId: p.id, setId, toPerformanceId: to }));
      } }, 'העבר'),
      h('button', { type: 'button', onclick: () => d.close() }, 'ביטול')));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

/** Assign an unresolved imported performance to an exercise: the user reviews every set's values. */
function resolveFlow(ctx, p, sessionId) {
  openPicker(ctx, (exerciseId) => {
    const ex = ctx.store.exercises.find((e) => e.id === exerciseId);
    const original = ctx.store.sessions.find((x) => x.id === ctx.store.activeSession.editsSessionId)?.performances.find((x) => x.id === p.id);
    if (!ex || !original) return;
    const fields = setFields(ex.measurement);
    const rows = original.sets.map((src, i) => {
      const fromSrc = sourceValues(src, ex.measurement.type);
      const inputs = fields.map((f) => h('input', { type: 'text', class: `in in-${f.field}`, inputmode: f.inputmode, dir: 'ltr', 'aria-label': `${f.label} · סט ${i + 1}`, 'data-resolve-field': `${i}:${f.field}`, value: fromSrc[f.field] === undefined ? '' : committedText(f.field, fromSrc[f.field]) }));
      const done = h('input', { type: 'checkbox', checked: Object.keys(fromSrc).length > 0, 'data-resolve-done': i });
      return { inputs, done, el: h('li', { class: 'set' }, h('span', { class: 'set-n' }, `${i + 1}`),
        h('div', {}, h('p', { class: 'hint', dir: 'auto' }, p.sets[i]?.source ?? ''), h('div', { class: 'set-fields' }, ...fields.map((f, j) => h('label', {}, h('span', { class: 'hint' }, f.label), inputs[j]))),
          h('label', { class: 'check' }, done, 'בוצע'))) };
    });
    const d = h('dialog', { class: 'sheet', 'data-dialog': 'resolve' },
      h('h2', {}, `שיוך ${p.name} ← ${ex.name}`),
      h('p', { class: 'hint' }, 'הערכים מולאו רק ממה שכתוב במקור. בדוק כל סט — במיוחד את משמעות המשקל — לפני השמירה. הרשומה המקורית נשמרת בהסגר ללא שינוי.'),
      h('ol', { class: 'sets' }, ...rows.map((r) => r.el)),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'pri', 'data-resolve-confirm': p.id, onclick: async () => {
          const sets = [];
          for (const [i, r] of rows.entries()) {
            const values = {};
            for (const [j, f] of fields.entries()) {
              const t = r.inputs[j].value.trim();
              if (t === '') { values[f.field] = null; continue; }
              const v = parseFieldInput(f.field, t);
              if (!v.ok) { await messageBox(`ערך לא תקין בסט ${i + 1}: "${t}"`); return; }
              values[f.field] = v.value;
            }
            sets.push({ values, completed: r.done.checked });
          }
          d.close();
          await ctx.buffer.flushAll();
          await report(await ctx.actions.resolvePerformance({ sessionId, performanceId: p.id, exerciseId, sets }));
        } }, 'שייך'),
        h('button', { type: 'button', onclick: () => d.close() }, 'ביטול')));
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  });
}

function activeView(ctx, model) {
  const sessionId = ctx.store.activeSession.session.id;
  const editableSession = model.status === 'ok';
  const openPicker = () => {
    const d = pickerDialog(ctx, model);
    document.body.append(d);
    d.showModal();
  };
  const cancel = async () => {
    await ctx.buffer.flushAll(); // typed values are saved first; nothing typed is dropped silently
    if (!(await confirmBox('לבטל את האימון? הוא לא יישמר בהיסטוריה, והערכים שהוקלדו בו יימחקו.', { confirmLabel: 'בטל אימון', cancelLabel: 'המשך באימון', danger: true }))) return;
    const r = await report(await ctx.actions.cancelWorkout({ sessionId }));
    if (r.ok) ctx.buffer.discardSession(sessionId);
  };
  const finish = async () => {
    if (ctx.workoutUi.finishing) return;
    ctx.workoutUi.finishing = true;
    try {
      await ctx.buffer.flushAll();
      if (ctx.buffer.pendingFor(sessionId) > 0) {
        await messageBox('יש ערכים שלא נשמרו (ערך לא תקין או שמירה שנכשלה). תקן אותם לפני הסיום.');
        return;
      }
      const f = finishModel(ctx.app.snapshot().store);
      if (!f) return;
      if (f.nothingToSave) {
        await messageBox('אין מה לשמור: אף סט לא סומן ✓ עם ערכים. סמן סטים, או בטל את האימון.');
        return;
      }
      if (!(await confirmBox(finishText(f), { confirmLabel: model.mode === 'edit' ? 'שמור שינויים' : 'סיים ושמור', cancelLabel: 'חזור לאימון' }))) return;
      const r = await report(await ctx.actions.finishWorkout({ sessionId, confirmDrop: f.dropsSomething }));
      if (r.ok) {
        ctx.buffer.discardSession(sessionId); // nothing is pending here (checked above); clears leftovers only
        ctx.workoutUi.lastFinished = { title: model.title, sets: f.saveCount };
      }
    } finally {
      ctx.workoutUi.finishing = false;
      ctx.rerender();
    }
  };
  const editing = model.mode === 'edit';
  // Back to the workout selection (never a trap). Nothing to lose → leaves at once; otherwise save /
  // discard / stay. Discard asks once more. Saving goes through the normal finish flow.
  const leave = async () => {
    await ctx.buffer.flushAll();
    const store = ctx.app.snapshot().store;
    if (!store.activeSession) return;
    const discard = async () => {
      const r = await report(await ctx.actions.cancelWorkout({ sessionId }));
      if (r.ok) ctx.buffer.discardSession(sessionId);
    };
    if (!hasUnsavedWork(store) && ctx.buffer.pendingFor(sessionId) === 0) return discard();
    const choice = await choiceBox(editing ? 'יש שינויים שלא נשמרו באימון. מה לעשות?' : 'באימון יש נתונים שלא נשמרו. מה לעשות?', [
      editableSession ? { id: 'save', label: editing ? 'שמור שינויים וחזור' : 'שמור את האימון וחזור', class: 'pri' } : null,
      { id: 'discard', label: editing ? 'בטל שינויים וחזור' : 'מחק את האימון וחזור', class: 'danger' },
      { id: 'stay', label: 'הישאר באימון' },
    ].filter(Boolean));
    if (choice === 'save') return finish();
    if (choice === 'discard' && await confirmBox(editing ? 'לבטל את השינויים? האימון השמור לא ישתנה.' : 'למחוק את האימון? הוא לא יישמר בהיסטוריה והערכים שהוקלדו יימחקו.', { confirmLabel: 'כן, בטל', cancelLabel: 'הישאר באימון', danger: true })) return discard();
  };
  const cancelEdit = async () => {
    await ctx.buffer.flushAll();
    if (!(await confirmBox('לבטל את העריכה? השינויים שלא נשמרו יימחקו. האימון השמור לא ישתנה.', { confirmLabel: 'בטל עריכה', cancelLabel: 'המשך לערוך', danger: true }))) return;
    const r = await report(await ctx.actions.cancelWorkout({ sessionId }));
    if (r.ok) ctx.buffer.discardSession(sessionId);
  };
  // Session date and note (2d.4): saved on change through core setSessionFields.
  const dateIn = h('input', { type: 'date', class: 'in in-date', value: model.date ?? '', disabled: !editableSession, 'aria-label': 'תאריך האימון', 'data-session-field': 'date' });
  dateIn.addEventListener('change', async () => {
    if (!dateIn.value) { dateIn.value = model.date ?? ''; return; } // a date is required; nothing is cleared
    await report(await ctx.actions.setSessionFields({ sessionId, date: dateIn.value }));
  });
  const noteIn = h('textarea', { class: 'perf-note-in', rows: 2, placeholder: 'הערה לאימון', disabled: !editableSession, 'aria-label': 'הערה לאימון', 'data-session-field': 'note', dir: 'auto' });
  noteIn.value = model.note ?? '';
  noteIn.addEventListener('change', async () => { await report(await ctx.actions.setSessionFields({ sessionId, note: noteIn.value })); });
  return h('div', { 'data-view': 'workout-active', 'data-session': sessionId },
    recoveryPanel(ctx),
    h('header', { class: 'workout-head' },
      h('button', { type: 'button', class: 'back-select', 'data-id': 'back-to-select', onclick: leave }, '→ בחירת אימון'),
      h('h2', {}, bdi(model.title)),
      editing ? h('p', { class: 'note note-info', 'data-editing': 'true' }, `עריכת אימון שמור${model.origin !== 'app' ? ' (מיובא)' : ''}. השינויים יישמרו רק ב"שמור שינויים".`) : null,
      h('div', { class: 'row session-fields' }, dateIn),
      noteIn),
    model.status === 'edit_conflict' ? conflictPanel(ctx, model, sessionId) : null,
    model.performances.length === 0
      ? h('p', { class: 'hint', 'data-empty': 'true' }, model.variable ? 'אימון משתנה: הוסף את התרגילים של היום.' : 'אין תרגילים באימון.')
      : null,
    ...model.performances.map((p) => performanceCard(ctx, p, sessionId, editableSession)),
    h('div', { class: 'row' },
      h('button', { type: 'button', 'data-id': 'add-exercise', disabled: !editableSession, onclick: openPicker }, '+ הוסף תרגיל')),
    h('div', { class: 'row finish-row' },
      h('button', { type: 'button', class: 'pri', 'data-id': 'finish-workout', disabled: !editableSession, onclick: finish }, editing ? 'שמור שינויים' : 'סיים אימון'),
      editing
        ? (editableSession ? h('button', { type: 'button', class: 'danger', 'data-id': 'cancel-edit', onclick: cancelEdit }, 'בטל עריכה') : null)
        : h('button', { type: 'button', class: 'danger', 'data-id': 'cancel-workout', onclick: cancel }, 'בטל אימון')));
}

/**
 * Edit conflict (2d.4): the saved workout changed or disappeared after editing began. Nothing is
 * overwritten: the user keeps the edit as a separate workout, or drops the edit. Unresolved
 * performances go to quarantine in both cases (core). Typed values that could not be saved are counted.
 */
function conflictPanel(ctx, model, sessionId) {
  const pendingTyped = ctx.buffer.pendingFor(sessionId);
  const lostNote = pendingTyped ? `\n${pendingTyped} ערכים שהוקלדו ולא נשמרו לא ייכללו.` : '';
  const text = model.conflictKind === 'target_missing'
    ? 'האימון השמור כבר לא קיים (נמחק או הוחלף בחלון אחר). העריכה שלך לא נשמרה.'
    : 'האימון השמור השתנה בחלון אחר אחרי שהתחלת לערוך. העריכה שלך לא נשמרה עליו, כדי לא לדרוס את השינוי החדש.';
  const act = async (fn, question, label) => {
    if (!(await confirmBox(`${question}${lostNote}`, { confirmLabel: label }))) return;
    const r = await report(await fn({ sessionId }));
    // Only once the conflict is really resolved (the edit is gone): a partial or unsaved step keeps everything.
    if (r.ok && r.outcome === 'saved' && !ctx.app.snapshot().store.activeSession) ctx.buffer.discardSession(sessionId);
  };
  return h('section', { class: 'card conflict', 'data-panel': 'conflict' },
    h('h2', {}, '⚠️ לא ניתן לשמור את העריכה'),
    h('p', {}, text),
    model.preservedCount ? h('p', { class: 'hint' }, `${model.preservedCount} תרגילים לא מזוהים יועברו להסגר ולא יאבדו.`) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'pri', 'data-id': 'conflict-save-new', onclick: () => act(ctx.actions.resolveConflictSaveAsNew, 'לשמור את העריכה שלך כאימון נפרד? האימון השמור לא ישתנה.', 'שמור כאימון נפרד') }, 'שמור כאימון נפרד'),
      h('button', { type: 'button', class: 'danger', 'data-id': 'conflict-discard', onclick: () => act(ctx.actions.resolveConflictDiscard, 'לבטל את העריכה שלך? הנתונים השמורים העדכניים יישארו כפי שהם.', 'בטל את העריכה') }, 'בטל את העריכה')));
}

/** The Workout tab content. */
export function workoutView(ctx) {
  if (ctx.store) checkRecovery(ctx);
  const model = activeWorkoutModel(ctx.store);
  ctx.workoutModel = model; // the correction dialogs need the other performances
  if (model) return activeView(ctx, model);
  const done = ctx.workoutUi.lastFinished;
  ctx.workoutUi.lastFinished = null;
  const view = selectionView(ctx);
  if (done) view.prepend(h('p', { class: 'note note-ok', 'data-saved': 'true' }, `✓ ${done.title} נשמר (${done.sets} סטים).`));
  return view;
}

/**
 * The structure of the open workout view: when it is unchanged, a store change only patches values.
 * null → always rebuild.
 */
export function workoutSignature(ctx) {
  const m = activeWorkoutModel(ctx.store);
  if (!m) return null;
  const r = ctx.workoutUi.recovery;
  return JSON.stringify([ctx.store.activeSession.session.id, m.mode, m.status, r ? JSON.stringify(r.rows?.map((x) => [x.key, x.field, x.status]) ?? 'x') + JSON.stringify(r.choices ?? null) : null,
    m.performances.map((p) => [p.id, p.preserved, p.sets.map((x) => x.id)])]);
}

/** Updates values and ✓ states in place; the focused field is never touched. */
export function patchWorkoutView(root, ctx) {
  const m = activeWorkoutModel(ctx.store);
  const sessionId = ctx.store.activeSession.session.id;
  const focused = document.activeElement;
  for (const [f, v] of [['date', m.date ?? ''], ['note', m.note ?? '']]) {
    const el = root.querySelector(`[data-session-field="${f}"]`);
    if (el && el !== focused && el.value !== v) el.value = v;
  }
  for (const p of m.performances) {
    for (const x of p.sets) {
      const identity = { sessionId, performanceId: p.id, setId: x.id };
      const li = root.querySelector(`[data-set="${CSS.escape(x.id)}"]`);
      if (!li) continue;
      li.classList.toggle('done', x.completed);
      li.querySelector('[data-tick]')?.setAttribute('aria-pressed', String(x.completed));
      for (const el of li.querySelectorAll('[data-input]')) {
        if (el === focused) continue;
        const field = el.dataset.field;
        const text = shownText(ctx, identity, field, x.values[field]);
        if (el.tagName === 'SELECT') el.value = text || '';
        else if (el.value !== text) el.value = text;
        el.setAttribute('aria-invalid', String(field !== 'durationBasis' && isInvalid(field, text)));
      }
    }
    if (p.type === 'note') {
      const ta = root.querySelector(`[data-note="${CSS.escape(p.id)}"]`);
      if (ta && ta !== focused && ta.value !== (p.note ?? '')) ta.value = p.note ?? '';
    }
  }
}
