// Step 2d.2 — Workout tab: pure read models over the snapshot store. No business rules here: starting,
// adding and cancelling are the core functions of src/core/active-session.js, called via actions.js.
// Step 2d.3 — logging: the editable fields of each measurement type, committed values as input text,
// the finish summary and the typed-value recovery list (both computed by core, only labelled here).
import { activeSessionStatus, finishSummary } from '../core/active-session.js';
import { ALLOWED_SET_FIELDS } from '../schema/constants.js';
import { formatNumber, unitLabel, formatSeconds } from './format.js';

const byOrder = (a, b) => a.order - b.order;

/** The user's last workout date per template (saved sessions only). */
function lastDates(store) {
  const last = new Map();
  for (const s of store.sessions) {
    if (!s.templateId || typeof s.date !== 'string') continue;
    if (!last.has(s.templateId) || s.date > last.get(s.templateId)) last.set(s.templateId, s.date);
  }
  return last;
}

/**
 * The template list of the selection screen: every non-archived template in its stored order (the
 * user's own order), with the exercise names in the template's intentional order.
 * A template with no items (HYROX Friday) is a variable workout: exercises are added during it.
 */
export function templateList(store) {
  const exName = new Map(store.exercises.map((e) => [e.id, e.name]));
  const last = lastDates(store);
  return store.templates
    .filter((t) => !t.archived)
    .map((t) => {
      const items = [...t.items].sort(byOrder);
      return {
        id: t.id,
        name: t.name,
        variable: items.length === 0,
        exerciseCount: items.length,
        exercises: items.map((i) => exName.get(i.exerciseId) ?? i.exerciseId),
        lastDate: last.get(t.id) ?? null,
      };
    });
}

/** "8–10", "8", or null. */
export function repsText(target) {
  if (!target) return null;
  return target.min === target.max ? `${target.min}` : `${target.min}–${target.max}`;
}

/**
 * Template targets for each performance, matched by exercise in order (a template may list the same
 * exercise twice; each item is used once). Performances added during the workout get no target.
 */
function targetsFor(store, session) {
  const t = session.templateId ? store.templates.find((x) => x.id === session.templateId) : null;
  const pool = t ? [...t.items].sort(byOrder) : [];
  const out = new Map();
  for (const p of [...session.performances].sort(byOrder)) {
    const i = pool.findIndex((it) => it.exerciseId === p.exerciseId);
    if (i < 0) continue;
    const [it] = pool.splice(i, 1);
    // No reps target and no note: the target varies from workout to workout (e.g. Lat Pulldown).
    out.set(p.id, { plannedSets: it.plannedSets, reps: repsText(it.targetReps), note: it.targetNote, variable: it.targetReps === null && it.targetNote === null });
  }
  return out;
}

/** One set as display text, by measurement type. Empty values show as "—". */
export function setText(set, measurement) {
  const u = unitLabel(measurement.loadUnit);
  const load = typeof set.load === 'number' ? `${formatNumber(set.load)} ${u}`.trim() : null;
  const reps = typeof set.reps === 'number' ? `${set.reps}` : null;
  const dur = typeof set.durationSec === 'number' ? formatSeconds(set.durationSec) : null;
  const dist = typeof set.distanceM === 'number' ? `${formatNumber(set.distanceM / 1000)} ק״מ` : null;
  const parts = {
    weight_reps: [load ?? '—', '×', reps ?? '—'],
    bodyweight_reps: ['×', reps ?? '—'],
    bodyweight_plus_load: [load ? `+${load}` : '+—', '×', reps ?? '—'],
    duration: [dur ?? '—'],
    distance_duration: [dist ?? '—', '·', dur ?? '—'],
    load_distance: [load ?? '—', '·', dist ?? '—', ...(dur ? ['·', dur] : [])],
  }[measurement.type];
  return parts ? parts.join(' ') : '';
}

/**
 * The active workout for the Workout tab, or null.
 * @returns {null|{mode, status, title, date, templateId, variable, performances:[{id, order, name, type,
 *   preserved, target, note, sets:[{id, order, text, completed}]}]}}
 */
export function activeWorkoutModel(store) {
  const a = store.activeSession;
  if (!a) return null;
  const s = a.session;
  const exById = new Map(store.exercises.map((e) => [e.id, e]));
  const targets = targetsFor(store, s);
  const t = s.templateId ? store.templates.find((x) => x.id === s.templateId) : null;
  const st = activeSessionStatus(store);
  return {
    mode: a.mode,
    status: st.state,
    conflictKind: st.conflictKind,
    origin: s.origin,
    note: s.note,
    preservedCount: a.preservedPerformanceIds.length,
    title: s.templateNameSnapshot ?? 'אימון חופשי',
    date: s.date,
    templateId: s.templateId,
    variable: !t || t.items.length === 0,
    performances: [...s.performances].sort(byOrder).map((p) => ({
      id: p.id,
      order: p.order,
      name: exById.get(p.exerciseId)?.name ?? p.exerciseId,
      type: p.measurement.type,
      preserved: a.preservedPerformanceIds.includes(p.id),
      target: targets.get(p.id) ?? null,
      note: p.note,
      measurement: p.measurement,
      fields: setFields(p.measurement),
      sets: [...p.sets].sort(byOrder).map((x) => ({
        id: x.id, order: x.order, text: setText(x, p.measurement), completed: x.completed, source: sourceText(x),
        values: Object.fromEntries([...ALLOWED_SET_FIELDS[p.measurement.type] ?? [], ...(p.measurement.type === 'distance_duration' ? ['durationBasis'] : [])].map((f) => [f, x[f] ?? null])),
      })),
    })),
  };
}

// ---- launch: imported source values -------------------------------------------------------------------
/** The original source values of an imported set, as text ("Garmin שורה 19: Bench Press · 9 · 15.5 kg"), or null. */
export function sourceText(x) {
  if (!Object.hasOwn(x, 'sourceRaw') && !Object.hasOwn(x, 'sourceRef')) return null;
  const rows = x.sourceRaw?.rows;
  if (Array.isArray(rows)) {
    const c = rows[0]?.cells ?? {};
    const parts = [c['Exercise Name'], c.Reps && `${c.Reps} חזרות`, c.Weight, c['Distance km'] && `${c['Distance km']} ק״מ`, c['Moving Time'] && `תנועה ${c['Moving Time']}`, c.Time && `זמן ${c.Time}`].filter(Boolean);
    return `Garmin שורה ${rows[0]?.row}: ${parts.join(' · ')}`;
  }
  const raw = x.sourceRaw;
  if (raw && typeof raw === 'object') return `מקור: ${Object.entries(raw).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}`;
  return `מקור: ${JSON.stringify(raw ?? x.sourceRef)}`;
}

/**
 * Values read from the source for resolving an unresolved imported set into `type`, read only where the source
 * states them directly (Garmin reps / weight number / time; v1 w / r). The user reviews them.
 */
export function sourceValues(x, type) {
  const out = {};
  const allowed = ALLOWED_SET_FIELDS[type] ?? [];
  const rows = x.sourceRaw?.rows;
  if (Array.isArray(rows)) {
    const c = rows[0]?.cells ?? {};
    const reps = /^\d+(\.0+)?$/.test(c.Reps ?? '') ? Number(c.Reps) : null;
    const w = /^(\d+(?:\.\d+)?) (kg|lbs?)$/.exec(c.Weight ?? '');
    if (allowed.includes('reps') && reps) out.reps = reps;
    if (allowed.includes('load') && w) out.load = Number(w[1]);
  } else if (x.sourceRaw && typeof x.sourceRaw === 'object') {
    if (allowed.includes('reps') && Number.isInteger(x.sourceRaw.r) && x.sourceRaw.r > 0) out.reps = x.sourceRaw.r;
    if (allowed.includes('load') && typeof x.sourceRaw.w === 'number' && x.sourceRaw.w > 0) out.load = x.sourceRaw.w;
  }
  return out;
}

// ---- 2d.3: fields ------------------------------------------------------------------------------------
const BASIS_LABEL = { per_hand: 'לכל יד', per_side: 'לכל צד', implement: 'לכלי' };

/**
 * The editable fields of a set, in display order, with Hebrew labels. Per-side semantics come from
 * the exercise's measurement (One-Arm DB Row: load per hand, reps per side; Single-Arm Overhead
 * Extension: load per side, reps per side) and are shown on the labels — values are stored as typed.
 * @returns {{field, label, inputmode, enterkeyhint}[]}
 */
export function setFields(m) {
  const u = unitLabel(m.loadUnit) || 'ק״ג';
  const loadBasis = BASIS_LABEL[m.loadBasis] ? ` ${BASIS_LABEL[m.loadBasis]}` : '';
  const repsLabel = m.repsBasis === 'per_side' ? 'חזרות לכל צד' : 'חזרות';
  const load = (label) => ({ field: 'load', label, inputmode: 'decimal' });
  const reps = { field: 'reps', label: repsLabel, inputmode: 'numeric' };
  const dur = { field: 'durationSec', label: 'זמן (דק׳:שנ׳)', inputmode: 'text' };
  const dist = { field: 'distanceM', label: 'מרחק (מ׳)', inputmode: 'decimal' };
  const list = {
    weight_reps: [load(`${u}${loadBasis}`), reps],
    bodyweight_reps: [reps],
    bodyweight_plus_load: [load(`תוספת ${u}`), reps],
    duration: [dur],
    distance_duration: [dist, dur],
    load_distance: [load(`${u}${loadBasis}`), dist, dur],
  }[m.type] ?? [];
  return list;
}

/** A committed value as the text an input shows (and accepts back). null → ''. */
export function committedText(field, value) {
  if (value === null || value === undefined) return '';
  if (field === 'durationSec') return formatSeconds(value);
  if (field === 'reps') return String(value);
  if (field === 'durationBasis') return value;
  return formatNumber(value);
}

export const DURATION_BASIS_LABELS = Object.freeze({ '': 'זמן: לא צוין', elapsed: 'זמן כולל (כולל עצירות)', moving: 'זמן תנועה' });

// ---- 2d.3: finishing -----------------------------------------------------------------------------------
/**
 * The finish dialog, from core's finishSummary (the same rule commitSession applies).
 * @returns {null|{mode, saveCount, tickedNoData, dataUnticked, droppedExercises:string[], dropsSomething, nothingToSave}}
 */
export function finishModel(store) {
  const sum = finishSummary(store);
  if (!sum) return null;
  const perfs = store.activeSession.session.performances;
  const exName = new Map(store.exercises.map((e) => [e.id, e.name]));
  const nameOf = (pid) => {
    const p = perfs.find((x) => x.id === pid);
    return p ? exName.get(p.exerciseId) ?? p.exerciseId : pid;
  };
  const kept = perfs.filter((p) => !sum.droppedPerformances.includes(p.id)).length;
  return {
    mode: sum.mode,
    saveCount: sum.toSave.length,
    tickedNoData: sum.tickedNoData.length,
    dataUnticked: sum.dataUnticked.length,
    droppedExercises: sum.droppedPerformances.map(nameOf),
    dropsSomething: sum.dropsSomething,
    nothingToSave: kept === 0 && sum.preserved.length === 0,
  };
}

/** Hebrew text of the finish confirmation. */
export function finishText(f) {
  const lines = [f.mode === 'edit' ? 'לשמור את השינויים באימון?' : 'לסיים ולשמור את האימון?', `יישמרו ${f.saveCount} סטים.`];
  if (f.dataUnticked) lines.push(`⚠️ ${f.dataUnticked} סטים עם ערכים לא סומנו ✓ ולא יישמרו.`);
  if (f.tickedNoData) lines.push(`${f.tickedNoData} סטים סומנו ✓ בלי ערכים ולא יישמרו.`);
  if (f.droppedExercises.length) lines.push(`תרגילים שלא יישמרו: ${f.droppedExercises.join(', ')}`);
  return lines.join('\n');
}

// ---- 2d.3: recovery of typed values ------------------------------------------------------------------
const FIELD_LABELS = { load: 'משקל', reps: 'חזרות', durationSec: 'זמן', distanceM: 'מרחק', durationBasis: 'בסיס זמן' };

/**
 * The launch recovery list (items from core's planDraftRecovery via the input buffer), labelled.
 * 'already' items are equal to what is saved and need no decision.
 */
export function recoveryRows(store, items) {
  const a = store?.activeSession ?? null;
  const exName = new Map((store?.exercises ?? []).map((e) => [e.id, e.name]));
  return items.filter((it) => it.status !== 'already').map((it) => {
    const p = a?.session.id === it.sessionId ? a.session.performances.find((x) => x.id === it.performanceId) : null;
    const set = p?.sets.find((x) => x.id === it.setId);
    return {
      ...it,
      exercise: p ? exName.get(p.exerciseId) ?? p.exerciseId : null,
      setOrder: set?.order ?? null,
      fieldLabel: FIELD_LABELS[it.field] ?? it.field,
      savedText: it.committed === undefined ? null : committedText(it.field, it.committed),
    };
  });
}

/**
 * The exercise picker: exercises grouped by muscle group in their stored order, filtered by name or
 * alias (case-insensitive). Unresolved exercises cannot be added (core refuses them too).
 * A variable template's own group (HYROX) is listed first.
 */
export function exercisePicker(store, query = '', { preferGroup = null } = {}) {
  const q = query.trim().toLowerCase();
  const groups = new Map();
  for (const e of store.exercises) {
    if (e.measurement.type === 'unresolved' || e.archived || e.mergedInto) continue; // 2d.7: archived exercises are not offered
    if (q && !e.name.toLowerCase().includes(q) && !(e.aliases ?? []).some((a) => a.toLowerCase().includes(q))) continue;
    const g = e.group ?? 'אחר';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ id: e.id, name: e.name });
  }
  const list = [...groups].map(([group, exercises]) => ({ group, exercises }));
  if (preferGroup) list.sort((a, b) => (b.group === preferGroup) - (a.group === preferGroup));
  return list;
}

/** HYROX workouts list the HYROX group first in the picker. */
export const preferredGroup = (model) => (model && /hyrox/i.test(model.title) ? 'הירוקס' : null);

/**
 * Does the open workout hold anything that leaving would lose? New workout: any set with a value or a
 * ✓, or a written note. Edit: any difference from the saved workout (date, note, exercises, sets).
 */
export function hasUnsavedWork(store) {
  const a = store.activeSession;
  if (!a) return false;
  const perfs = a.session.performances;
  if (a.mode === 'edit') {
    const o = store.sessions.find((x) => x.id === a.editsSessionId);
    if (!o) return true;
    return JSON.stringify([a.session.date, a.session.note, perfs]) !== JSON.stringify([o.date, o.note, o.performances]);
  }
  if (a.session.note && a.session.note.trim()) return true;
  return perfs.some((p) => (p.measurement.type === 'note' ? !!(p.note && p.note.trim()) : p.sets.some((x) => x.completed || ['load', 'reps', 'durationSec', 'distanceM'].some((f) => x[f] !== null))));
}
