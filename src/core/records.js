// Manual Personal Records CRUD (user-managed personal records stored in store.manualRecords).
// Domain functions over a draft store, used through app.commit (actions.js).
// Never creates fake workout sessions, never alters workout history, and never overwrites other records.
import { LOAD_UNITS, ALLOWED_LOAD_BASIS, TIME_BASIS, LOAD_FOR_MIN_REPS_MIN, ACTUAL_1RM_REPS, MANUAL_RECORD_METRICS } from '../schema/constants.js';
import { createManualRecord, createExercise, emptyBodyweight } from '../schema/factories.js';
import { compatibleTypes } from '../schema/validate.js';
import { DomainError } from './active-session.js';

const ALL_LOAD_BASIS = [...ALLOWED_LOAD_BASIS.weight_reps, ...ALLOWED_LOAD_BASIS.bodyweight_plus_load];

export const RING_DIP_ID = 'ex_ring_dip';

const requireCtx = (ctx, needId = false) => {
  if (!ctx || typeof ctx.now !== 'string' || (needId && typeof ctx.newId !== 'function')) {
    throw new TypeError('ctx { now, newId } required');
  }
};

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const trimOrNull = (s) => (typeof s === 'string' && s.trim() !== '' ? s.trim() : null);

function isValidLocalDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const CANONICAL_EXERCISE_SYNONYMS = Object.freeze({
  'pull-up': 'ex_weighted_pull_up',
  'pull up': 'ex_weighted_pull_up',
  pullup: 'ex_weighted_pull_up',
  'weighted pull-up': 'ex_weighted_pull_up',
  'weighted pull up': 'ex_weighted_pull_up',
  dip: 'ex_weighted_dips',
  dips: 'ex_weighted_dips',
  'weighted dip': 'ex_weighted_dips',
  'weighted dips': 'ex_weighted_dips',
  'ring dip': RING_DIP_ID,
  'ring dips': RING_DIP_ID,
});

/**
 * Ensures a dedicated Ring Dip exercise exists in store.exercises.
 * Ring Dip is an unstable gymnastic ring movement semantically distinct from parallel-bar Weighted Dips.
 */
export function ensureRingDipExercise(store, ctx) {
  const active = (store.exercises ?? []).filter((e) => !e.archived && e.mergedInto === null && e.measurement?.type !== 'unresolved');
  let ex = active.find((e) => e.id === RING_DIP_ID || e.name.trim().toLowerCase() === 'ring dip' || (Array.isArray(e.aliases) && e.aliases.some((a) => a.toLowerCase() === 'ring dip')));
  if (ex) return ex;

  const id = (store.exercises ?? []).some((e) => e.id === RING_DIP_ID) ? (ctx?.newId ? ctx.newId('ex') : `ex_ring_dip_${Date.now()}`) : RING_DIP_ID;
  ex = createExercise({
    id,
    name: 'Ring Dip',
    aliases: ['Ring Dips', 'טבעות'],
    group: 'חזה',
    equipment: 'טבעות',
    measurement: {
      type: 'bodyweight_plus_load',
      loadBasis: 'added',
      loadUnit: store.settings?.loadUnit ?? 'kg',
      volumeFactor: null,
      repsBasis: null,
    },
    isCustom: true,
    now: ctx?.now ?? new Date().toISOString(),
  });
  store.exercises.push(ex);
  return ex;
}

/**
 * Resolves an exercise ID or name/synonym to an existing non-archived, non-merged, non-unresolved exercise.
 * Distinct movements (e.g. Ring Dip vs Weighted Dips) are never merged.
 */
export function resolveRecordExercise(store, idOrName, ctx = null) {
  if (typeof idOrName !== 'string' || idOrName.trim() === '') return null;
  const raw = idOrName.trim();
  const active = (store.exercises ?? []).filter((e) => !e.archived && e.mergedInto === null && e.measurement?.type !== 'unresolved');
  const byId = active.find((e) => e.id === raw);
  if (byId) return byId;
  const low = raw.toLowerCase();
  const byName = active.find(
    (e) => e.name.trim().toLowerCase() === low || (Array.isArray(e.aliases) && e.aliases.some((a) => String(a).trim().toLowerCase() === low)),
  );
  if (byName) return byName;
  const synId = CANONICAL_EXERCISE_SYNONYMS[low];
  if (synId === RING_DIP_ID) {
    const existing = active.find((e) => e.id === RING_DIP_ID || e.name.trim().toLowerCase() === 'ring dip');
    if (existing) return existing;
    if (ctx) return ensureRingDipExercise(store, ctx);
    return null;
  }
  if (synId) return active.find((e) => e.id === synId) ?? null;
  return null;
}

export function normalizeAndValidateRecordFields(store, input, existing = null, ctx = null) {
  const exRef = input.exerciseId !== undefined ? input.exerciseId : existing?.exerciseId;
  const ex = resolveRecordExercise(store, exRef, ctx);
  if (!ex) throw new DomainError('NOT_FOUND', { field: 'exerciseId' });

  let metric = input.metric !== undefined ? input.metric : existing?.metric;
  if (!MANUAL_RECORD_METRICS.includes(metric)) throw new DomainError('RESULT_INVALID', { field: 'metric' });

  const rawLoad = input.load !== undefined ? input.load : existing?.load ?? null;
  const numLoad = rawLoad === null || rawLoad === '' ? null : Number(rawLoad);
  const rawReps = input.reps !== undefined ? input.reps : existing?.reps ?? null;
  const numReps = rawReps === null || rawReps === '' ? null : Number(rawReps);

  // Distinguish bodyweight-only repetition records from weighted repetition records:
  // If caller requested 'max_reps' with a positive load (> 0), normalize to weighted repetition metric
  // ('actual_1rm' for 1 rep, 'load_for_min_reps' for >= 2 reps) so weighted vs bodyweight records stay separate.
  if (metric === 'max_reps' && numLoad !== null && isFin(numLoad) && numLoad > 0) {
    if (numReps === ACTUAL_1RM_REPS) metric = 'actual_1rm';
    else if (isInt(numReps) && numReps >= LOAD_FOR_MIN_REPS_MIN) metric = 'load_for_min_reps';
    else throw new DomainError('RESULT_INVALID', { field: 'reps' });
  }

  if (!compatibleTypes(metric).includes(ex.measurement.type)) {
    throw new DomainError('RESULT_INVALID', { field: 'metric', exerciseType: ex.measurement.type });
  }

  let load = null;
  let loadUnit = null;
  let loadBasis = null;
  let reps = null;
  let repsText = null;
  let durationSec = null;
  let distanceM = null;
  let timeBasis = null;

  const isLoadMetric = metric === 'max_load' || metric === 'actual_1rm' || metric === 'load_for_min_reps';
  if (isLoadMetric) {
    if (!isFin(numLoad) || numLoad <= 0) throw new DomainError('RESULT_INVALID', { field: 'load' });
    load = Math.round(numLoad * 100) / 100;
    loadUnit = input.loadUnit ?? existing?.loadUnit ?? ex.measurement.loadUnit ?? 'kg';
    if (!LOAD_UNITS.includes(loadUnit)) throw new DomainError('RESULT_INVALID', { field: 'loadUnit' });
    loadBasis = input.loadBasis ?? existing?.loadBasis ?? ex.measurement.loadBasis ?? 'total';
    if (!ALL_LOAD_BASIS.includes(loadBasis)) throw new DomainError('RESULT_INVALID', { field: 'loadBasis' });
  }

  if (metric === 'max_load') {
    const rawRepsText = trimOrNull(input.repsText !== undefined ? input.repsText : existing?.repsText ?? null);
    if (numReps !== null) {
      if (!isInt(numReps) || numReps < 1) throw new DomainError('RESULT_INVALID', { field: 'reps' });
      reps = numReps;
      repsText = null;
    } else if (rawRepsText !== null) {
      reps = null;
      repsText = rawRepsText;
    }
  } else if (metric === 'actual_1rm') {
    reps = ACTUAL_1RM_REPS;
  } else if (metric === 'load_for_min_reps') {
    if (!isInt(numReps) || numReps < LOAD_FOR_MIN_REPS_MIN) {
      throw new DomainError('RESULT_INVALID', { field: 'reps' });
    }
    reps = numReps;
  } else if (metric === 'max_reps') {
    // Bodyweight-only / unweighted repetition record: no weight required (load, loadUnit, loadBasis remain null)
    if (!isInt(numReps) || numReps < 1) throw new DomainError('RESULT_INVALID', { field: 'reps' });
    reps = numReps;
  } else if (metric === 'best_duration') {
    const rawDur = input.durationSec !== undefined ? input.durationSec : existing?.durationSec ?? null;
    const numDur = rawDur === null || rawDur === '' ? null : Math.round(Number(rawDur));
    if (!isInt(numDur) || numDur <= 0) throw new DomainError('RESULT_INVALID', { field: 'durationSec' });
    durationSec = numDur;
  } else if (metric === 'max_distance') {
    const rawDist = input.distanceM !== undefined ? input.distanceM : existing?.distanceM ?? null;
    const numDist = rawDist === null || rawDist === '' ? null : Number(rawDist);
    if (!isFin(numDist) || numDist <= 0) throw new DomainError('RESULT_INVALID', { field: 'distanceM' });
    distanceM = Math.round(numDist * 100) / 100;
  } else if (metric === 'time_for_distance') {
    const rawDist = input.distanceM !== undefined ? input.distanceM : existing?.distanceM ?? null;
    const numDist = rawDist === null || rawDist === '' ? null : Number(rawDist);
    if (!isFin(numDist) || numDist <= 0) throw new DomainError('RESULT_INVALID', { field: 'distanceM' });
    distanceM = Math.round(numDist * 100) / 100;

    const rawDur = input.durationSec !== undefined ? input.durationSec : existing?.durationSec ?? null;
    const numDur = rawDur === null || rawDur === '' ? null : Math.round(Number(rawDur));
    if (!isInt(numDur) || numDur <= 0) throw new DomainError('RESULT_INVALID', { field: 'durationSec' });
    durationSec = numDur;

    const rawTb = input.timeBasis !== undefined ? input.timeBasis : existing?.timeBasis ?? 'moving';
    timeBasis = rawTb === null || rawTb === '' ? null : rawTb;
    if (timeBasis !== null && !TIME_BASIS.includes(timeBasis)) throw new DomainError('RESULT_INVALID', { field: 'timeBasis' });
  }

  const rawDate = input.date !== undefined ? input.date : existing?.date ?? null;
  let date = null;
  if (rawDate !== null && String(rawDate).trim() !== '') {
    const dStr = String(rawDate).trim();
    if (!isValidLocalDate(dStr)) throw new DomainError('RESULT_INVALID', { field: 'date' });
    date = dStr;
  }

  const note = trimOrNull(input.note !== undefined ? input.note : existing?.note ?? null);

  return {
    exerciseId: ex.id,
    metric,
    load,
    loadUnit,
    loadBasis,
    reps,
    repsText,
    durationSec,
    distanceM,
    timeBasis,
    date,
    note,
  };
}

export function addManualRecord(store, args = {}, ctx) {
  requireCtx(ctx, true);
  const v = normalizeAndValidateRecordFields(store, args, null, ctx);
  const rec = createManualRecord({
    id: ctx.newId('rec'),
    exerciseId: v.exerciseId,
    metric: v.metric,
    load: v.load,
    loadUnit: v.loadUnit,
    loadBasis: v.loadBasis,
    reps: v.reps,
    repsText: v.repsText,
    durationSec: v.durationSec,
    distanceM: v.distanceM,
    timeBasis: v.timeBasis,
    bodyweight: emptyBodyweight(),
    relatedSetRef: null,
    date: v.date,
    note: v.note,
    source: 'manual',
    now: ctx.now,
  });
  store.manualRecords.push(rec);
  return store;
}

export function updateManualRecord(store, { recordId, ...rest } = {}, ctx) {
  requireCtx(ctx, false);
  const idx = (store.manualRecords ?? []).findIndex((r) => r.id === recordId);
  if (idx === -1) throw new DomainError('NOT_FOUND', { recordId });
  const existing = store.manualRecords[idx];
  const v = normalizeAndValidateRecordFields(store, rest, existing, ctx);
  store.manualRecords[idx] = {
    ...existing,
    exerciseId: v.exerciseId,
    metric: v.metric,
    load: v.load,
    loadUnit: v.loadUnit,
    loadBasis: v.loadBasis,
    reps: v.reps,
    repsText: v.repsText,
    durationSec: v.durationSec,
    distanceM: v.distanceM,
    timeBasis: v.timeBasis,
    relatedSetRef: v.metric === 'time_for_distance' ? existing.relatedSetRef : null,
    date: v.date,
    note: v.note,
    updatedAt: ctx.now,
  };
  return store;
}

export function deleteManualRecord(store, { recordId } = {}, ctx) {
  requireCtx(ctx, false);
  const idx = (store.manualRecords ?? []).findIndex((r) => r.id === recordId);
  if (idx === -1) throw new DomainError('NOT_FOUND', { recordId });
  store.manualRecords.splice(idx, 1);
  return store;
}
