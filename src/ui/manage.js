// Step 2d.7 — Manage: data (backup / restore / imports / verification, from 2d.1), workout templates,
// exercises and personal settings. Every change is an action (actions.manage → core/manage.js).
// Nothing is deleted: templates and exercises are archived; history keeps its own snapshots.
import { h, bdi } from './dom.js';
import { formatNumber } from './format.js';
import { messageBox, confirmBox, promptBox } from './io.js';
import { messageFor } from './flow-model.js';
import { dataSection } from './screens.js';
import { syncCard } from './sync.js';
import { exercisePicker } from './workout-model.js';
import { CREATABLE_TYPES, loadBasisOptions } from '../core/manage.js';

const TYPE_LABELS = { weight_reps: 'משקל × חזרות', bodyweight_reps: 'חזרות (משקל גוף)', bodyweight_plus_load: 'משקל גוף + תוספת', duration: 'זמן', distance_duration: 'מרחק + זמן', load_distance: 'משקל + מרחק', note: 'הערה חופשית', unresolved: 'לא מזוהה' };
const BASIS_LABELS = { total: 'משקל כולל', per_hand: 'לכל יד', per_side: 'לכל צד', implement: 'לכלי', added: 'תוספת' };
const MESSAGES = { NAME_EXISTS: 'כבר קיים תרגיל בשם הזה.', UNRESOLVED_EXERCISE: 'אי אפשר להשתמש בתרגיל לא מזוהה.', UNRESOLVED_EXERCISE_PROTECTED: 'התרגיל קשור לנתונים מיובאים שמורים ואינו ניתן לשינוי.' };
const report = async (r) => { if (!r.ok && r.outcome !== 'unsaved') await messageBox(MESSAGES[r.code] ?? messageFor(r)); return r; };

// ---- overview -------------------------------------------------------------------------------------
function overview(ctx) {
  const s = ctx.store;
  const active = s.templates.filter((t) => !t.archived);
  return h('div', { 'data-view': 'manage' },
    h('nav', { class: 'subnav' },
      h('a', { class: 'button', href: '#/manage/templates', 'data-id': 'templates' }, `תבניות (${active.length})`),
      h('a', { class: 'button', href: '#/manage/exercises', 'data-id': 'exercises' }, `תרגילים (${s.exercises.filter((e) => !e.archived && e.measurement.type !== 'unresolved').length})`),
      h('a', { class: 'button', href: '#/manage/settings', 'data-id': 'settings' }, 'הגדרות')),
    dataSection(ctx));
}

// ---- templates ------------------------------------------------------------------------------------
function templatesView(ctx) {
  const ui = ctx.manageUi;
  const list = ctx.store.templates.filter((t) => ui.showArchived || !t.archived);
  return h('div', { 'data-view': 'manage-templates' },
    h('a', { href: '#/manage', class: 'button' }, '→ לניהול'),
    h('h2', {}, 'תבניות אימון'),
    h('ul', { class: 'list' }, ...list.map((t) => h('li', {}, h('a', { class: 'history-row', href: `#/manage/templates/${encodeURIComponent(t.id)}`, 'data-template': t.id },
      h('span', { class: 'history-date' }, t.archived ? 'בארכיון' : `${t.items.length} תרגילים`),
      h('span', { class: 'history-title' }, bdi(t.name)),
      h('span', { class: 'history-meta' }, t.items.length ? '' : 'אימון משתנה'))))),
    h('div', { class: 'row' },
      h('a', { class: 'button pri', href: '#/manage/templates/new', 'data-id': 'new-template' }, '+ תבנית חדשה'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!ui.showArchived, onchange: (e) => { ui.showArchived = e.target.checked; ctx.rerender(); } }), 'הצג ארכיון')));
}

/** The editor keeps a draft in UI memory until "שמור" (one commit through core saveTemplate). */
function templateEditor(ctx, templateId) {
  const ui = ctx.manageUi;
  const isNew = templateId === 'new';
  const t = isNew ? null : ctx.store.templates.find((x) => x.id === templateId);
  if (!isNew && !t) return h('div', {}, h('p', {}, 'התבנית לא נמצאה.'), h('a', { href: '#/manage/templates', class: 'button' }, '→ לתבניות'));
  if (!ui.draft || ui.draft.key !== templateId) {
    ui.draft = { key: templateId, name: t?.name ?? '', items: (t ? [...t.items].sort((a, b) => a.order - b.order) : []).map((i) => ({ id: i.id, exerciseId: i.exerciseId, plannedSets: i.plannedSets, min: i.targetReps?.min ?? '', max: i.targetReps?.max ?? '', note: i.targetNote ?? '' })) };
  }
  const d = ui.draft;
  const exById = new Map(ctx.store.exercises.map((e) => [e.id, e]));
  const move = (i, delta) => { const j = i + delta; if (j < 0 || j >= d.items.length) return; [d.items[i], d.items[j]] = [d.items[j], d.items[i]]; ctx.rerender(); };
  const field = (obj, key, attrs) => { const el = h('input', { class: 'in', value: String(obj[key] ?? ''), dir: 'ltr', ...attrs }); el.addEventListener('input', () => { obj[key] = el.value; }); return el; };
  const addItem = () => {
    const dlg = h('dialog', { class: 'sheet picker' });
    const list = h('div', { class: 'picker-list' });
    const search = h('input', { type: 'search', placeholder: 'חיפוש תרגיל', dir: 'auto' });
    const fill = () => list.replaceChildren(...exercisePicker(ctx.store, search.value).map((g) => h('div', { class: 'picker-group' }, h('h4', {}, g.group),
      ...g.exercises.map((e) => h('button', { type: 'button', class: 'picker-item', 'data-exercise': e.id, onclick: () => {
        const ex = exById.get(e.id);
        d.items.push({ id: null, exerciseId: e.id, plannedSets: ex.measurement.type === 'note' ? 0 : 3, min: '', max: '', note: '' });
        dlg.close();
        ctx.rerender();
      } }, bdi(e.name))))));
    search.addEventListener('input', fill);
    fill();
    dlg.append(h('div', { class: 'row' }, search, h('button', { type: 'button', onclick: () => dlg.close() }, 'סגור')), list);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  };
  const save = async () => {
    const items = [];
    for (const [i, it] of d.items.entries()) {
      const min = String(it.min).trim();
      const max = String(it.max).trim() || min;
      const sets = String(it.plannedSets).trim();
      if (!/^\d+$/.test(sets)) return messageBox(`מספר סטים לא תקין בשורה ${i + 1}.`);
      if ((min && !/^\d+$/.test(min)) || (max && !/^\d+$/.test(max))) return messageBox(`יעד חזרות לא תקין בשורה ${i + 1}.`);
      items.push({ id: it.id, exerciseId: it.exerciseId, plannedSets: Number(sets), targetReps: min ? { min: Number(min), max: Number(max) } : null, targetNote: it.note || null });
    }
    const r = await report(await ctx.actions.manage.saveTemplate({ templateId: isNew ? null : templateId, name: d.name, items }));
    if (r.ok) { ui.draft = null; ctx.go('manage/templates'); }
    return r;
  };
  return h('div', { 'data-view': 'manage-template', 'data-template': templateId },
    h('a', { href: '#/manage/templates', class: 'button', onclick: () => { ui.draft = null; } }, '→ לתבניות'),
    h('h2', {}, isNew ? 'תבנית חדשה' : 'עריכת תבנית'),
    h('label', {}, 'שם', field(d, 'name', { dir: 'auto', 'data-field': 'template-name' })),
    h('p', { class: 'hint' }, 'הסדר כאן הוא סדר התרגילים באימון. תבנית בלי תרגילים היא אימון משתנה (מוסיפים תוך כדי). שינוי תבנית לא משנה אימונים שמורים.'),
    h('ol', { class: 'tpl-items' }, ...d.items.map((it, i) => {
      const ex = exById.get(it.exerciseId);
      const note = ex?.measurement.type === 'note';
      return h('li', { class: 'card', 'data-item': String(i) },
        h('div', { class: 'perf-head' }, h('b', {}, `${i + 1}. `, bdi(ex?.name ?? it.exerciseId)),
          h('span', {}, h('button', { type: 'button', class: 'small', 'aria-label': 'למעלה', onclick: () => move(i, -1) }, '↑'), h('button', { type: 'button', class: 'small', 'aria-label': 'למטה', onclick: () => move(i, 1) }, '↓'),
            h('button', { type: 'button', class: 'small', 'aria-label': 'הסר', onclick: () => { d.items.splice(i, 1); ctx.rerender(); } }, '×'))),
        note ? h('p', { class: 'hint' }, 'הערה חופשית — בלי סטים') : h('div', { class: 'tpl-fields' },
          h('label', {}, 'סטים', field(it, 'plannedSets', { inputmode: 'numeric', 'data-field': 'sets' })),
          h('label', {}, 'חזרות מ-', field(it, 'min', { inputmode: 'numeric', 'data-field': 'min' })),
          h('label', {}, 'עד', field(it, 'max', { inputmode: 'numeric', 'data-field': 'max' }))),
        h('label', {}, 'הערת יעד (רשות)', field(it, 'note', { dir: 'auto', 'data-field': 'note' })),
        !note && !it.min && !it.note ? h('p', { class: 'hint' }, 'בלי יעד חזרות: היעד משתנה מאימון לאימון.') : null);
    })),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: addItem, 'data-id': 'add-item' }, '+ תרגיל'),
      h('button', { type: 'button', class: 'pri', onclick: save, 'data-id': 'save-template' }, 'שמור תבנית')),
    t ? h('button', { type: 'button', class: t.archived ? '' : 'danger', 'data-id': 'archive-template', onclick: async () => {
      if (!t.archived && !(await confirmBox('להעביר את התבנית לארכיון? היא לא תופיע בבחירת אימון. אימונים שמורים לא ישתנו.', { confirmLabel: 'לארכיון' }))) return;
      const r = await report(await ctx.actions.manage.setTemplateArchived({ templateId: t.id, archived: !t.archived }));
      if (r.ok) { ui.draft = null; ctx.go('manage/templates'); }
    } }, t.archived ? 'החזר מהארכיון' : 'העבר לארכיון') : null);
}

// ---- exercises ------------------------------------------------------------------------------------
function exercisesView(ctx) {
  const ui = ctx.manageUi;
  const groups = new Map();
  for (const e of ctx.store.exercises) {
    if (e.measurement.type === 'unresolved' || e.mergedInto) continue;
    if (e.archived && !ui.showArchivedEx) continue;
    const g = e.group ?? 'אחר';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const unresolved = ctx.store.exercises.filter((e) => e.measurement.type === 'unresolved');
  return h('div', { 'data-view': 'manage-exercises' },
    h('a', { href: '#/manage', class: 'button' }, '→ לניהול'),
    h('h2', {}, 'תרגילים'),
    ui.exerciseForm ? exerciseForm(ctx) : h('button', { type: 'button', class: 'pri', 'data-id': 'new-exercise', onclick: () => { ui.exerciseForm = { type: 'weight_reps' }; ctx.rerender(); } }, '+ תרגיל חדש'),
    ...[...groups].map(([g, list]) => h('section', {}, h('h3', { class: 'month' }, g), h('ul', { class: 'list' }, ...list.map((e) => h('li', { class: 'ex-row', 'data-exercise': e.id },
      h('div', {}, h('b', {}, bdi(e.name)), e.archived ? h('span', { class: 'badge' }, 'בארכיון') : null,
        h('div', { class: 'hint' }, TYPE_LABELS[e.measurement.type], e.measurement.loadBasis && e.measurement.loadBasis !== 'total' ? ` · ${BASIS_LABELS[e.measurement.loadBasis]}` : '', e.measurement.repsBasis === 'per_side' ? ' · חזרות לכל צד' : '')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'small', onclick: async () => {
          const name = await promptBox('שם התרגיל', e.name);
          if (name && name !== e.name) await report(await ctx.actions.manage.renameExercise({ exerciseId: e.id, name }));
        } }, 'שנה שם'),
        h('button', { type: 'button', class: 'small', onclick: async () => { await report(await ctx.actions.manage.setExerciseArchived({ exerciseId: e.id, archived: !e.archived })); } }, e.archived ? 'החזר' : 'לארכיון'))))))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!ui.showArchivedEx, onchange: (ev) => { ui.showArchivedEx = ev.target.checked; ctx.rerender(); } }), 'הצג ארכיון'),
    unresolved.length ? h('section', { class: 'card' }, h('h3', {}, `תרגילים לא מזוהים מייבוא (${unresolved.length})`),
      h('p', { class: 'hint' }, 'נשמרו כפי שהגיעו, עם הערכים המקוריים. הם מוגנים מפני שינוי; שיוך לתרגיל קיים דורש החלטה נפרדת (ראה הדוח).'),
      h('ul', {}, ...unresolved.map((e) => h('li', {}, bdi(e.name))))) : null);
}

function exerciseForm(ctx) {
  const f = ctx.manageUi.exerciseForm;
  const set = (patch) => { Object.assign(f, patch); ctx.rerender(); };
  const groups = [...new Set(ctx.store.exercises.map((e) => e.group).filter(Boolean))];
  const text = (key, label, attrs = {}) => { const el = h('input', { class: 'in', value: f[key] ?? '', dir: 'auto', ...attrs }); el.addEventListener('input', () => { f[key] = el.value; }); return h('label', {}, label, el); };
  const bases = loadBasisOptions(f.type);
  return h('section', { class: 'card', 'data-form': 'exercise' },
    h('h3', {}, 'תרגיל חדש'),
    text('name', 'שם', { 'data-field': 'name' }),
    h('label', {}, 'קבוצה', h('select', { class: 'in', onchange: (e) => { f.group = e.target.value; } }, h('option', { value: '' }, '—'), ...groups.map((g) => h('option', { value: g, selected: f.group === g }, g)))),
    text('equipment', 'ציוד (רשות)'),
    h('label', {}, 'סוג מדידה', h('select', { class: 'in', 'data-field': 'type', onchange: (e) => set({ type: e.target.value, loadBasis: null }) }, ...CREATABLE_TYPES.map((t) => h('option', { value: t, selected: f.type === t }, TYPE_LABELS[t])))),
    bases.length > 1 ? h('label', {}, 'המשקל נרשם', h('select', { class: 'in', onchange: (e) => { f.loadBasis = e.target.value; } }, ...bases.map((b) => h('option', { value: b, selected: (f.loadBasis ?? bases[0]) === b }, BASIS_LABELS[b])))) : null,
    ['weight_reps', 'bodyweight_reps', 'bodyweight_plus_load'].includes(f.type) ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!f.repsPerSide, onchange: (e) => { f.repsPerSide = e.target.checked; } }), 'חזרות לכל צד') : null,
    h('p', { class: 'hint' }, 'סוג המדידה קובע אילו שדות נרשמים בכל סט, ואינו ניתן לשינוי אחר כך.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'pri', 'data-id': 'save-exercise', onclick: async () => {
        const r = await report(await ctx.actions.manage.createCustomExercise({ name: f.name, group: f.group, equipment: f.equipment, type: f.type, loadBasis: f.loadBasis ?? null, repsPerSide: !!f.repsPerSide }));
        if (r.ok) { ctx.manageUi.exerciseForm = null; ctx.rerender(); }
      } }, 'שמור'),
      h('button', { type: 'button', onclick: () => { ctx.manageUi.exerciseForm = null; ctx.rerender(); } }, 'ביטול')));
}

// ---- settings -------------------------------------------------------------------------------------
function settingsView(ctx) {
  const st = ctx.store.settings;
  const bw = h('input', { class: 'in', inputmode: 'decimal', dir: 'ltr', value: st.bodyweight?.value === null || st.bodyweight?.value === undefined ? '' : formatNumber(st.bodyweight.value), 'data-field': 'bodyweight' });
  return h('div', { 'data-view': 'manage-settings' },
    h('a', { href: '#/manage', class: 'button' }, '→ לניהול'),
    h('h2', {}, 'הגדרות'),
    syncCard(ctx),
    h('section', { class: 'card' },
      h('h3', {}, 'משקל גוף'),
      h('p', { class: 'hint' }, 'משמש כברירת מחדל לאימונים חדשים (למשל לחישוב משקל כולל במתח עם תוספת). אימונים שמורים לא משתנים.'),
      h('label', {}, `משקל (${st.bodyweight?.unit === 'lb' ? 'lb' : 'ק״ג'})`, bw),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'pri', 'data-id': 'save-bodyweight', onclick: async () => {
          const t = bw.value.trim();
          if (t === '') return report(await ctx.actions.manage.setBodyweight({ value: null }));
          if (!/^\d+(?:[.,]\d+)?$/.test(t)) return messageBox('משקל לא תקין.');
          return report(await ctx.actions.manage.setBodyweight({ value: Number(t.replace(',', '.')), unit: st.bodyweight?.unit ?? 'kg' }));
        } }, 'שמור'))),
    h('section', { class: 'card' },
      h('h3', {}, 'יחידת משקל לתרגילים חדשים'),
      h('select', { class: 'in', 'data-field': 'load-unit', onchange: async (e) => { await report(await ctx.actions.manage.setLoadUnit({ unit: e.target.value })); } },
        h('option', { value: 'kg', selected: st.loadUnit === 'kg' }, 'ק״ג'), h('option', { value: 'lb', selected: st.loadUnit === 'lb' }, 'lb'))));
}

/** The Manage tab content: #/manage, #/manage/templates[/id|new], #/manage/exercises, #/manage/settings. */
export function manageView(ctx, parts) {
  if (parts[0] === 'templates') return parts[1] ? templateEditor(ctx, parts[1]) : templatesView(ctx);
  if (parts[0] === 'exercises') return exercisesView(ctx);
  if (parts[0] === 'settings') return settingsView(ctx);
  return overview(ctx);
}

