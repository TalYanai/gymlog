// Active session (Step 2b.6): starting, editing, logging and saving a workout.
//
// Pure functions over a store DRAFT (the clone a Store.commit callback receives). Each one either
// mutates and returns the draft, or throws a DomainError with an approved error code; nothing is
// written then. They never touch storage; the Store validates every result and enforces the
// commit-time transition rules (src/core/transitions.js). `ctx` = { now: ISO string, newId(prefix) }.
//
// Approved rules implemented here (Phase 2b design §2.5 and corrections P1, PP, EC, QM, QV, RC):
// - One active session at a time (ACTIVE_SESSION_EXISTS). A template starts the workout directly.
// - D9: a new exercise copies its last completed performance, else one empty set. A template item
//   gets plannedSets sets, pre-filled set by set from that last performance, else empty.
// - D10: the session bodyweight starts from settings only when confirmed; a typed value needs an
//   explicit choice (measured / user_estimate); "measured" also updates settings.bodyweight.
// - P1: a NEW performance can never reference an unresolved exercise (UNRESOLVED_EXERCISE).
// - Edit: preserved (unresolved) performances are read-only; removal only via moveToQuarantine.
// - Edit conflict (target missing / changed): only export, moveToQuarantine, cancel (TR-CANCEL)
//   and saveAsNew (TR-SAVENEW) are possible; every other change → EDIT_CONFLICT.
// - finishSummary shows what saving would keep and drop; commitSession refuses to drop anything
//   without { confirmDrop: true } (NEEDS_CONFIRMATION). "The UI asks; the core doesn't decide."
// - No progression suggestions (G2): prefill copies previous values only.

import { ALLOWED_SET_FIELDS, TIME_BASIS } from '../schema/constants.js';
import { createSession, createPerformance, createSet, bodyweightFromSettings, bodyweightEntered, bodyweightConfirmMeasured, createRemovedPerformanceQuarantine } from '../schema/factories.js';
import { isLocalDate } from '../schema/validate.js';
import { editConflict } from './transitions.js';

export class DomainError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'DomainError';
    this.domainCode = code;
    this.details = details;
  }
}
const err = (code, details) => new DomainError(code, details);
const METRICS = ['load', 'reps', 'durationSec', 'distanceM'];

function requireCtx(ctx) {
  if (!ctx || typeof ctx.now !== 'string' || typeof ctx.newId !== 'function') throw new TypeError('ctx { now, newId } required');
}
const exerciseById = (store, id) => store.exercises.find((e) => e.id === id) ?? null;
const isUnresolvedPerf = (store, p) => p.measurement.type === 'unresolved' || exerciseById(store, p.exerciseId)?.measurement.type === 'unresolved';

function requireActive(store) {
  if (!store.activeSession) throw err('NOT_FOUND', { what: 'activeSession' });
  return store.activeSession;
}
/** Every ordinary change to the active workout: refused during an edit conflict. */
function requireEditable(store) {
  const a = requireActive(store);
  const c = editConflict(store);
  if (c) throw err('EDIT_CONFLICT', { conflictKind: c });
  return a;
}
function findPerf(a, performanceId) {
  const p = a.session.performances.find((x) => x.id === performanceId);
  if (!p) throw err('NOT_FOUND', { performanceId });
  return p;
}
function requireNotPreserved(a, performanceId) {
  if (a.preservedPerformanceIds.includes(performanceId)) throw err('PRESERVED_PERFORMANCE_MODIFIED', { performanceId });
}
/** A set that carries imported source data (v1 / CSV). */
const hasSource = (x) => Object.hasOwn(x, 'sourceRaw') || Object.hasOwn(x, 'sourceRef');
const renumber = (list) => list.forEach((x, i) => { x.order = i + 1; });
const touch = (a, ctx) => { a.session.updatedAt = ctx.now; };

/** Snapshot compatibility for prefill: values are copied only between identical measurement snapshots. */
const sameMeasurement = (m1, m2) => ['type', 'loadBasis', 'loadUnit', 'repsBasis'].every((k) => m1[k] === m2[k]);

/** The most recent saved performance of an exercise with at least one completed set (D9). */
export function lastCompletedPerformance(store, exerciseId) {
  const ordered = [...store.sessions].sort((a, b) => {
    if (a.date !== b.date) {
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date < b.date ? 1 : -1;
    }
    const ta = a.endedAt ?? a.updatedAt;
    const tb = b.endedAt ?? b.updatedAt;
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
  for (const s of ordered) {
    const perfs = s.performances.filter((p) => p.exerciseId === exerciseId && p.sets.some((x) => x.completed));
    if (perfs.length) return perfs[perfs.length - 1];
  }
  return null;
}

/** Prefilled sets: count = `count` (or the source's completed sets), values from the source by position. */
function prefilledSets(store, exercise, measurement, ctx, count) {
  const last = lastCompletedPerformance(store, exercise.id);
  const source = last && sameMeasurement(last.measurement, measurement) ? last.sets.filter((x) => x.completed) : [];
  const n = count ?? (source.length || 1);
  const allowed = ALLOWED_SET_FIELDS[measurement.type];
  return Array.from({ length: n }, (_, i) => {
    const set = createSet({ id: ctx.newId('set'), measurement, order: i + 1 });
    const from = source[i];
    if (from) {
      for (const f of METRICS) if (allowed.includes(f)) set[f] = from[f];
    } else if (!source.length && exercise.prefill && allowed.includes('load')) {
      // No history yet: the last known weight from the personal-data file (as V3 did), never a computed value.
      set.load = exercise.prefill.load;
    }
    return set;
  });
}

function newPerformance(store, exerciseId, order, ctx, plannedSets) {
  const ex = exerciseById(store, exerciseId);
  if (!ex) throw err('NOT_FOUND', { exerciseId });
  if (ex.measurement.type === 'unresolved') throw err('UNRESOLVED_EXERCISE', { exerciseId });
  const perf = createPerformance({ id: ctx.newId('prf'), exercise: ex, order });
  if (ex.measurement.type !== 'note') perf.sets = prefilledSets(store, ex, perf.measurement, ctx, plannedSets);
  return perf;
}

// ---- starting -------------------------------------------------------------------------------------

/**
 * Starts a new workout: empty, from a template (plannedSets per item, prefilled), or from a saved
 * session (structure and values copied, nothing completed).
 * @param {{date:string, templateId?:string, fromSessionId?:string}} args  date is the local YYYY-MM-DD
 * Performances of a source session that reference an unresolved exercise are not copied (P1); the
 * UI can list them beforehand with uncopyablePerformances().
 */
export function startNew(store, { date, templateId = null, fromSessionId = null } = {}, ctx) {
  requireCtx(ctx);
  if (store.activeSession) throw err('ACTIVE_SESSION_EXISTS');
  if (!isLocalDate(date)) throw err('RESULT_INVALID', { field: 'date' });
  if (templateId && fromSessionId) throw new TypeError('use templateId or fromSessionId, not both');
  const session = createSession({ id: ctx.newId('ses'), date, startedAt: ctx.now, bodyweight: bodyweightFromSettings(store.settings), now: ctx.now });
  if (templateId) {
    const t = store.templates.find((x) => x.id === templateId);
    if (!t) throw err('NOT_FOUND', { templateId });
    session.templateId = t.id;
    session.templateNameSnapshot = t.name;
    [...t.items].sort((a, b) => a.order - b.order).forEach((it) => {
      session.performances.push(newPerformance(store, it.exerciseId, session.performances.length + 1, ctx, it.plannedSets));
    });
  } else if (fromSessionId) {
    const src = store.sessions.find((x) => x.id === fromSessionId);
    if (!src) throw err('NOT_FOUND', { fromSessionId });
    session.templateId = src.templateId;
    session.templateNameSnapshot = src.templateNameSnapshot;
    for (const p of [...src.performances].sort((a, b) => a.order - b.order)) {
      const ex = exerciseById(store, p.exerciseId);
      if (!ex || isUnresolvedPerf(store, p)) continue;
      const perf = createPerformance({ id: ctx.newId('prf'), exercise: ex, order: session.performances.length + 1 });
      perf.note = ex.measurement.type === 'note' ? p.note : null;
      if (ex.measurement.type !== 'note') {
        const allowed = ALLOWED_SET_FIELDS[perf.measurement.type];
        const copy = sameMeasurement(p.measurement, perf.measurement);
        perf.sets = p.sets.map((x, i) => {
          const set = createSet({ id: ctx.newId('set'), measurement: perf.measurement, order: i + 1 });
          if (copy) for (const f of METRICS) if (allowed.includes(f)) set[f] = x[f];
          return set;
        });
      }
      session.performances.push(perf);
    }
  }
  store.activeSession = { mode: 'new', editsSessionId: null, baseUpdatedAt: null, session, preservedPerformanceIds: [] };
  return store;
}

/** Opens a saved session for editing (D14: imported sessions too). Preserved = its unresolved performances. */
export function startEdit(store, { sessionId } = {}, ctx) {
  requireCtx(ctx);
  if (store.activeSession) throw err('ACTIVE_SESSION_EXISTS');
  const s = store.sessions.find((x) => x.id === sessionId);
  if (!s) throw err('NOT_FOUND', { sessionId });
  store.activeSession = {
    mode: 'edit',
    editsSessionId: s.id,
    baseUpdatedAt: s.updatedAt,
    session: structuredClone(s),
    preservedPerformanceIds: s.performances.filter((p) => isUnresolvedPerf(store, p)).map((p) => p.id),
  };
  return store;
}

// ---- changing the active workout ------------------------------------------------------------------

/** D9 + P1: adds an exercise; copies its last completed performance, else one empty set. */
export function addExercise(store, { exerciseId } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  a.session.performances.push(newPerformance(store, exerciseId, a.session.performances.length + 1, ctx));
  touch(a, ctx);
  return store;
}

/** Removes a non-preserved performance (preserved ones only via moveToQuarantine). */
export function removePerformance(store, { performanceId } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  if (findPerf(a, performanceId).sets.some(hasSource)) throw err('SOURCE_SET_PROTECTED', { performanceId });
  a.session.performances = a.session.performances.filter((p) => p.id !== performanceId).sort((x, y) => x.order - y.order);
  renumber(a.session.performances);
  touch(a, ctx);
  return store;
}

/** Moves a performance to a new 1-based position (order is the only thing that may change on a preserved one). */
export function movePerformance(store, { performanceId, toOrder } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  const list = [...a.session.performances].sort((x, y) => x.order - y.order);
  const i = list.findIndex((p) => p.id === performanceId);
  if (i < 0) throw err('NOT_FOUND', { performanceId });
  if (!Number.isSafeInteger(toOrder) || toOrder < 1 || toOrder > list.length) throw err('RESULT_INVALID', { field: 'toOrder' });
  const [p] = list.splice(i, 1);
  list.splice(toOrder - 1, 0, p);
  renumber(list);
  a.session.performances = list;
  touch(a, ctx);
  return store;
}

/** Adds a set; copies the values of the performance's last set (v3 behavior), not completed. */
export function addSet(store, { performanceId } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  const p = findPerf(a, performanceId);
  if (p.measurement.type === 'note') throw err('RESULT_INVALID', { reason: 'note performances have no sets' });
  const set = createSet({ id: ctx.newId('set'), measurement: p.measurement, order: p.sets.length + 1 });
  const last = [...p.sets].sort((x, y) => x.order - y.order).at(-1);
  if (last) for (const f of METRICS) set[f] = last[f];
  p.sets.push(set);
  touch(a, ctx);
  return store;
}

export function removeSet(store, { performanceId, setId } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  const p = findPerf(a, performanceId);
  const target = p.sets.find((x) => x.id === setId);
  if (!target) throw err('NOT_FOUND', { setId });
  // Launch rule: a set imported with its source row is history — it is corrected, moved or marked not
  // done, never deleted (its source would be lost). Sets entered in GymLog can be deleted.
  if (hasSource(target)) throw err('SOURCE_SET_PROTECTED', { setId });
  p.sets = p.sets.filter((x) => x.id !== setId).sort((x, y) => x.order - y.order);
  renumber(p.sets);
  touch(a, ctx);
  return store;
}

/**
 * Updates metric values of one set. Only fields allowed for the performance's measurement type;
 * each value is null or a valid number (validation rejects anything else on commit).
 * `durationBasis` (distance_duration only) must be passed explicitly — never inferred (D23/D24).
 */
export function updateSet(store, { performanceId, setId, values = {} } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  const p = findPerf(a, performanceId);
  const set = p.sets.find((x) => x.id === setId);
  if (!set) throw err('NOT_FOUND', { setId });
  const allowed = ALLOWED_SET_FIELDS[p.measurement.type];
  for (const [k, v] of Object.entries(values)) {
    if (k === 'durationBasis') {
      if (p.measurement.type !== 'distance_duration' || !(v === null || TIME_BASIS.includes(v))) throw err('RESULT_INVALID', { field: k });
      set.durationBasis = v;
    } else if (METRICS.includes(k) && allowed.includes(k)) set[k] = v;
    else throw err('RESULT_INVALID', { field: k });
  }
  touch(a, ctx);
  return store;
}

export function setSetCompleted(store, { performanceId, setId, completed } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  const set = findPerf(a, performanceId).sets.find((x) => x.id === setId);
  if (!set) throw err('NOT_FOUND', { setId });
  if (typeof completed !== 'boolean') throw err('RESULT_INVALID', { field: 'completed' });
  set.completed = completed;
  touch(a, ctx);
  return store;
}

export function setPerformanceNote(store, { performanceId, note } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  findPerf(a, performanceId).note = note === '' ? null : note;
  touch(a, ctx);
  return store;
}

export function setSessionFields(store, { date, note } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  if (date !== undefined) {
    if (!(isLocalDate(date) || (date === null && a.session.origin !== 'app'))) throw err('RESULT_INVALID', { field: 'date' });
    a.session.date = date;
  }
  if (note !== undefined) a.session.note = note === '' ? null : note;
  touch(a, ctx);
  return store;
}

/**
 * D10 / D14: a typed bodyweight requires an explicit choice. "measured" also updates the setting
 * (value, unit, confirmed: true). No default choice exists.
 */
export function setSessionBodyweight(store, { value, unit, choice } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  let snap;
  try {
    snap = bodyweightEntered(value, unit, choice);
  } catch {
    throw err('NEEDS_CONFIRMATION', { field: 'bodyweight.choice' });
  }
  a.session.bodyweight = snap;
  if (choice === 'measured') store.settings.bodyweight = { value, unit, confirmed: true, updatedAt: ctx.now };
  touch(a, ctx);
  return store;
}

/** D10: "measured today" on the displayed settings default. */
export function confirmBodyweightMeasured(store, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  let snap;
  try {
    snap = bodyweightConfirmMeasured(a.session.bodyweight);
  } catch {
    throw err('RESULT_INVALID', { field: 'bodyweight' });
  }
  a.session.bodyweight = snap;
  store.settings.bodyweight = { value: snap.value, unit: snap.unit, confirmed: true, updatedAt: ctx.now };
  touch(a, ctx);
  return store;
}

// ---- finishing -----------------------------------------------------------------------------------

const hasData = (set) => METRICS.some((f) => set[f] !== null);

/**
 * What saving would keep and drop (pure; the UI shows it and asks).
 * toSave: completed sets with data. tickedNoData: completed sets without values (dropped).
 * dataUnticked: sets with values that aren't completed (dropped). droppedPerformances: performances
 * that would keep nothing. Preserved performances are always kept unchanged. In an edit, sets and
 * performances that already exist in the saved session are always kept (they are history, possibly
 * imported with sourceRaw); only ones added during the edit can be dropped. Explicit removal is
 * removeSet / removePerformance.
 */
export function finishSummary(store) {
  const a = store.activeSession;
  if (!a) return null;
  const original = a.mode === 'edit' ? store.sessions.find((x) => x.id === a.editsSessionId) : null;
  const oldPerf = new Set(original ? original.performances.map((p) => p.id) : []);
  const oldSet = new Set(original ? original.performances.flatMap((p) => p.sets.map((x) => x.id)) : []);
  const out = { mode: a.mode, toSave: [], tickedNoData: [], dataUnticked: [], droppedPerformances: [], preserved: [...a.preservedPerformanceIds] };
  for (const p of [...a.session.performances].sort((x, y) => x.order - y.order)) {
    if (a.preservedPerformanceIds.includes(p.id)) continue;
    if (p.measurement.type === 'note') {
      if ((p.note === null || p.note.trim() === '') && !oldPerf.has(p.id)) out.droppedPerformances.push(p.id);
      continue;
    }
    let kept = 0;
    for (const s of p.sets) {
      if (oldSet.has(s.id) || hasSource(s) || (s.completed && hasData(s))) { // imported sets are history: always kept
        out.toSave.push({ performanceId: p.id, setId: s.id });
        kept++;
      } else if (s.completed) out.tickedNoData.push({ performanceId: p.id, setId: s.id });
      else if (hasData(s)) out.dataUnticked.push({ performanceId: p.id, setId: s.id });
    }
    if (kept === 0 && !oldPerf.has(p.id)) out.droppedPerformances.push(p.id);
  }
  out.dropsSomething = out.toSave.length < countSets(a) || out.droppedPerformances.length > 0;
  return out;
}
const countSets = (a) => a.session.performances.filter((p) => !a.preservedPerformanceIds.includes(p.id) && p.measurement.type !== 'note').reduce((n, p) => n + p.sets.length, 0);

/**
 * Saves the active workout. new → appended; edit → replaces the saved session (only without a
 * conflict). Sets and performances listed as dropped by finishSummary are removed only with
 * { confirmDrop: true }; otherwise NEEDS_CONFIRMATION and nothing changes.
 */
export function commitSession(store, { confirmDrop = false } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  const sum = finishSummary(store);
  if (sum.dropsSomething && confirmDrop !== true) throw err('NEEDS_CONFIRMATION', { summary: sum });
  const s = a.session;
  const keepSet = new Set(sum.toSave.map((x) => x.setId));
  const dropPerf = new Set(sum.droppedPerformances);
  s.performances = s.performances
    .filter((p) => !dropPerf.has(p.id))
    .sort((x, y) => x.order - y.order)
    .map((p) => {
      if (!a.preservedPerformanceIds.includes(p.id) && p.measurement.type !== 'note') {
        p.sets = p.sets.filter((x) => keepSet.has(x.id)).sort((x, y) => x.order - y.order);
        renumber(p.sets);
      }
      return p;
    });
  renumber(s.performances);
  if (s.performances.length === 0 && a.preservedPerformanceIds.length === 0) throw err('RESULT_INVALID', { reason: 'nothing to save' });
  s.updatedAt = ctx.now;
  if (a.mode === 'new') {
    s.endedAt = ctx.now;
    store.sessions.push(s);
  } else {
    const i = store.sessions.findIndex((x) => x.id === a.editsSessionId);
    store.sessions[i] = s;
  }
  store.activeSession = null;
  return store;
}

/** Cancels the active workout. During a conflict, every preserved performance must already have a copy (TR-CANCEL). */
export function cancelActiveSession(store, ctx) {
  requireCtx(ctx);
  const a = requireActive(store);
  if (editConflict(store)) {
    for (const id of a.preservedPerformanceIds) {
      const p = a.session.performances.find((x) => x.id === id);
      if (p) throw err('CANCEL_WOULD_LOSE_PRESERVED', { performanceId: id });
    }
  }
  store.activeSession = null;
  return store;
}

/**
 * Moves a preserved (unresolved) performance of an edit to quarantine (Q-REMOVED), in the same
 * commit. Without a conflict the raw is the saved original (verified); during a conflict it is the
 * active copy before removal (verifiedAgainstOriginal: false — never presented as verified).
 */
export async function moveToQuarantine(store, { performanceId } = {}, ctx) {
  requireCtx(ctx);
  const a = requireActive(store);
  if (a.mode !== 'edit' || !a.preservedPerformanceIds.includes(performanceId)) throw err('PRESERVED_ID_INVALID', { performanceId });
  const active = findPerf(a, performanceId);
  const conflict = editConflict(store);
  const original = conflict ? null : store.sessions.find((s) => s.id === a.editsSessionId);
  const perf = conflict ? active : original.performances.find((p) => p.id === performanceId);
  const session = conflict ? a.session : original;
  store.quarantine.push(await createRemovedPerformanceQuarantine({ id: ctx.newId('q'), performance: perf, session, verifiedAgainstOriginal: !conflict, now: ctx.now }));
  a.session.performances = a.session.performances.filter((p) => p.id !== performanceId).sort((x, y) => x.order - y.order);
  renumber(a.session.performances);
  return store;
}

// ---- Launch: corrections of saved (incl. imported) workouts during an edit -----------------------------
const LOAD_TYPES = ['weight_reps', 'bodyweight_plus_load', 'load_distance'];

function exerciseForCorrection(store, exerciseId) {
  const ex = exerciseById(store, exerciseId);
  if (!ex) throw err('NOT_FOUND', { exerciseId });
  if (ex.archived || ex.mergedInto !== null) throw err('RESULT_INVALID', { reason: 'archived exercise' });
  if (ex.measurement.type === 'unresolved') throw err('UNRESOLVED_EXERCISE', { exerciseId });
  return ex;
}

/** The measurement a corrected performance gets: the new exercise's, keeping the recorded load unit. */
function correctedMeasurement(ex, before) {
  const m = { ...ex.measurement };
  if (LOAD_TYPES.includes(m.type) && before && LOAD_TYPES.includes(before.type) && before.loadUnit) m.loadUnit = before.loadUnit;
  return m;
}

/** Values of one set that the new type cannot hold (they would be cleared). */
const clearedFields = (set, type) => ['load', 'reps', 'durationSec', 'distanceM'].filter((f) => set[f] !== null && !ALLOWED_SET_FIELDS[type].includes(f));

/**
 * Replaces the exercise of one performance (a wrong mapping, a mislabelled Garmin exercise). The sets,
 * their ids and their source data stay; values the new type cannot hold are cleared only with
 * { confirmClear: true } (NEEDS_CONFIRMATION otherwise). The source row keeps the original values.
 */
export function changePerformanceExercise(store, { performanceId, exerciseId, confirmClear = false } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  const p = findPerf(a, performanceId);
  if (p.measurement.type === 'note') throw err('RESULT_INVALID', { reason: 'note performances keep their exercise' });
  const ex = exerciseForCorrection(store, exerciseId);
  if (ex.measurement.type === 'note') throw err('RESULT_INVALID', { reason: 'a note exercise has no sets' });
  const lost = p.sets.flatMap((x) => clearedFields(x, ex.measurement.type).map((f) => ({ setId: x.id, field: f })));
  if (lost.length && confirmClear !== true) throw err('NEEDS_CONFIRMATION', { cleared: lost });
  const m = correctedMeasurement(ex, p.measurement);
  for (const x of p.sets) {
    for (const f of clearedFields(x, m.type)) x[f] = null;
    if (m.type === 'distance_duration') { if (!('durationBasis' in x)) x.durationBasis = null; } else delete x.durationBasis;
    if (m.type !== 'distance_duration') delete x.splits;
  }
  p.exerciseId = ex.id;
  p.nameSnapshot = ex.name;
  p.measurement = m;
  touch(a, ctx);
  return store;
}

/**
 * Moves one set (with its source data) to another performance of the same workout with the same
 * measurement type — e.g. one Garmin row that belongs to a different exercise.
 */
export function moveSet(store, { performanceId, setId, toPerformanceId } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  requireNotPreserved(a, performanceId);
  requireNotPreserved(a, toPerformanceId);
  const from = findPerf(a, performanceId);
  const to = findPerf(a, toPerformanceId);
  if (from === to) throw err('RESULT_INVALID', { reason: 'same performance' });
  if (from.measurement.type !== to.measurement.type) throw err('RESULT_INVALID', { reason: 'measurement type differs' });
  const set = from.sets.find((x) => x.id === setId);
  if (!set) throw err('NOT_FOUND', { setId });
  from.sets = from.sets.filter((x) => x.id !== setId);
  renumber(from.sets);
  set.order = to.sets.length + 1;
  to.sets.push(set);
  if (from.sets.length === 0 && !from.sets.some(hasSource)) {
    // an emptied performance holds nothing: it leaves the workout
    a.session.performances = a.session.performances.filter((x) => x.id !== from.id);
    renumber(a.session.performances.sort((x, y) => x.order - y.order));
  }
  touch(a, ctx);
  return store;
}

/**
 * Resolves an unresolved (imported) performance of the workout being edited. In ONE commit: the
 * original goes to quarantine unchanged (Q-REMOVED, verified against the saved workout), and a new
 * performance of the chosen exercise takes its place with the values the user confirmed. Each new set
 * keeps its source row reference and source values, so the Garmin / v1 original stays traceable.
 * values: one entry per original set, in order: { values: {load, reps, durationSec, distanceM, durationBasis?}, completed }.
 */
export async function resolvePerformance(store, { performanceId, exerciseId, sets = [] } = {}, ctx) {
  requireCtx(ctx);
  const a = requireEditable(store);
  if (a.mode !== 'edit' || !a.preservedPerformanceIds.includes(performanceId)) throw err('PRESERVED_ID_INVALID', { performanceId });
  const ex = exerciseForCorrection(store, exerciseId);
  if (ex.measurement.type === 'note') throw err('RESULT_INVALID', { reason: 'a note exercise has no sets' });
  const original = store.sessions.find((x) => x.id === a.editsSessionId).performances.find((x) => x.id === performanceId);
  if (!Array.isArray(sets) || sets.length !== original.sets.length) throw err('RESULT_INVALID', { reason: 'one value entry per original set' });
  const order = findPerf(a, performanceId).order;
  const m = correctedMeasurement(ex, null);
  const perf = { id: ctx.newId('prf'), exerciseId: ex.id, order, nameSnapshot: ex.name, measurement: m, note: original.note, sets: [] };
  const allowed = ALLOWED_SET_FIELDS[m.type];
  original.sets.forEach((src, i) => {
    const given = sets[i] ?? {};
    const set = createSet({ id: ctx.newId('set'), measurement: m, order: i + 1 });
    for (const [k, v] of Object.entries(given.values ?? {})) {
      if (k === 'durationBasis') {
        if (m.type !== 'distance_duration' || !(v === null || TIME_BASIS.includes(v))) throw err('RESULT_INVALID', { field: k });
        set.durationBasis = v;
      } else if (allowed.includes(k)) set[k] = v;
      else if (v !== null && v !== undefined) throw err('RESULT_INVALID', { field: k });
    }
    set.completed = given.completed === true;
    if (Object.hasOwn(src, 'sourceRef')) set.sourceRef = structuredClone(src.sourceRef);
    if (Object.hasOwn(src, 'sourceRaw')) set.sourceRaw = structuredClone(src.sourceRaw);
    set.warnings = [...new Set([...(src.warnings ?? []), 'RESOLVED_FROM_UNRESOLVED'])];
    perf.sets.push(set);
  });
  await moveToQuarantine(store, { performanceId }, ctx); // the original, complete and verified
  a.session.performances.push(perf);
  a.session.performances.sort((x, y) => x.order - y.order || (x.id === perf.id ? -1 : 1));
  renumber(a.session.performances);
  touch(a, ctx);
  return store;
}

/**
 * Resolves an edit conflict by saving the active workout as a NEW session (TR-SAVENEW): new IDs,
 * origin and provenance unchanged, `recovery` filled in. Every unresolved performance must have been
 * moved to quarantine first. Nothing is dropped: sets are kept as they are.
 */
export function saveAsNew(store, ctx) {
  requireCtx(ctx);
  const a = requireActive(store);
  const conflictKind = editConflict(store);
  if (!conflictKind) throw err('EDIT_CONFLICT', { reason: 'save as new only resolves an edit conflict' });
  if (a.session.performances.some((p) => isUnresolvedPerf(store, p))) throw err('UNRESOLVED_NOT_PRESERVED');
  const s = structuredClone(a.session);
  s.id = ctx.newId('ses');
  for (const p of s.performances) {
    p.id = ctx.newId('prf');
    for (const x of p.sets) x.id = ctx.newId('set');
  }
  s.recovery = { recoveredFromSessionId: a.editsSessionId, recoveredAt: ctx.now, conflictKind };
  s.updatedAt = ctx.now;
  store.sessions.push(s);
  store.activeSession = null;
  return store;
}

// ---- saved sessions --------------------------------------------------------------------------------

/**
 * D24: sets the time basis of ONE run set of a saved session (e.g. a migrated v1 run). No bulk action.
 * Refused while that session is open for editing (change it in the edit instead).
 */
export function setDurationBasis(store, { sessionId, performanceId, setId, basis } = {}, ctx) {
  requireCtx(ctx);
  if (!(basis === null || TIME_BASIS.includes(basis))) throw err('RESULT_INVALID', { field: 'basis' });
  if (store.activeSession?.mode === 'edit' && store.activeSession.editsSessionId === sessionId) throw err('ACTIVE_SESSION_EXISTS');
  const s = store.sessions.find((x) => x.id === sessionId);
  const p = s?.performances.find((x) => x.id === performanceId);
  const set = p?.sets.find((x) => x.id === setId);
  if (!set) throw err('NOT_FOUND', { sessionId, performanceId, setId });
  if (p.measurement.type !== 'distance_duration') throw err('RESULT_INVALID', { reason: 'not a distance_duration set' });
  set.durationBasis = basis;
  s.updatedAt = ctx.now;
  return store;
}

/** Derived state of the active workout (never stored). */
export function activeSessionStatus(store) {
  if (!store.activeSession) return { state: 'none', conflictKind: null };
  const c = editConflict(store);
  return c ? { state: 'edit_conflict', conflictKind: c } : { state: 'ok', conflictKind: null };
}

/** Performances of a saved session that startNew({ fromSessionId }) cannot copy (unresolved, P1). */
export function uncopyablePerformances(store, sessionId) {
  const src = store.sessions.find((x) => x.id === sessionId);
  return src ? src.performances.filter((p) => !exerciseById(store, p.exerciseId) || isUnresolvedPerf(store, p)).map((p) => p.id) : [];
}
