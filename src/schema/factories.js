// Factories for Schema v2 entities. Every field is set explicitly (null when unknown, never undefined).
// Factories build data only; they never read or write storage.

import { newId } from './ids.js';
import { canonicalSha256 } from './canonical.js';
import { SCHEMA_VERSION, ALLOWED_SET_FIELDS, TIME_BASIS, MANUAL_RECORD_METRICS, GOAL_METRICS } from './constants.js';

export const nowIso = () => new Date().toISOString();

// ---- Store ------------------------------------------------------------------

export function createEmptyStore({ now = nowIso(), appVersion = '0.0.0' } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      createdAt: now,
      updatedAt: now,
      appVersion,
      dataRevision: 1,
      seedsApplied: {},
      seedTombstones: {},
      importLog: [],
      onboarding: {
        personalSeed: 'pending',
        checks: { countsMatch: false, spotChecked: false, recordsReviewed: false, unresolvedReviewed: false, realWorkoutLogged: false },
        userVerifiedAt: null,
      },
    },
    settings: {
      loadUnit: 'kg',
      bodyweight: { value: null, unit: null, confirmed: false, updatedAt: null },
      lastBackupAt: null,
      lastBackupRevision: null,
      lastPartialBackupAt: null,
      lastPartialBackupRevision: null,
    },
    exercises: [],
    templates: [],
    sessions: [],
    activeSession: null,
    manualRecords: [],
    goals: [],
    quarantine: [],
  };
}

// ---- Measurement ---------------------------------------------------------------

export function createMeasurement({ type, loadBasis = null, loadUnit = null, volumeFactor = null, repsBasis = null }) {
  return { type, loadBasis, loadUnit, volumeFactor, repsBasis };
}

/** Copies the exercise's measurement at logging time. Later exercise changes do not affect the copy. */
export function snapshotMeasurement(exercise) {
  const m = exercise.measurement;
  return { type: m.type, loadBasis: m.loadBasis, loadUnit: m.loadUnit, volumeFactor: m.volumeFactor, repsBasis: m.repsBasis };
}

// ---- Catalog --------------------------------------------------------------------

export function createExercise({
  id = newId('ex'),
  name,
  measurement,
  group = null,
  equipment = null,
  aliases = [],
  variantGroup = null,
  isCustom = true,
  seed = null,
  prefill = null,
  now = nowIso(),
}) {
  return {
    id, name, aliases: [...aliases], group, equipment,
    measurement: createMeasurement(measurement),
    variantGroup, isCustom, seed, prefill,
    archived: false, mergedInto: null, createdAt: now, updatedAt: now,
  };
}

export function createTemplateItem({ id = newId('tpi'), exerciseId, order, plannedSets, targetReps = null, targetNote = null }) {
  return { id, exerciseId, order, plannedSets, targetReps, targetNote };
}

export function createTemplate({ id = newId('tpl'), name, items = [], seed = null, now = nowIso() }) {
  return { id, name, archived: false, seed, createdAt: now, updatedAt: now, items };
}

// ---- Bodyweight (D10, INV-BW) ----------------------------------------------------

export const emptyBodyweight = () => ({ value: null, unit: null, source: null });

/** Untouched default: settings_default only when the setting is confirmed; otherwise unknown. */
export function bodyweightFromSettings(settings) {
  const bw = settings?.bodyweight;
  if (bw && bw.confirmed === true && bw.value !== null && bw.unit !== null) {
    return { value: bw.value, unit: bw.unit, source: 'settings_default' };
  }
  return emptyBodyweight();
}

/** A typed value requires an explicit choice; there is no default. */
export function bodyweightEntered(value, unit, choice) {
  if (choice !== 'measured' && choice !== 'user_estimate') {
    throw new TypeError('An entered bodyweight requires an explicit choice: "measured" or "user_estimate"');
  }
  return { value, unit, source: choice };
}

/** "Measured today" on the displayed default. */
export function bodyweightConfirmMeasured(snapshot) {
  if (!snapshot || snapshot.source !== 'settings_default' || snapshot.value === null) {
    throw new TypeError('Only a settings_default snapshot with a value can be confirmed as measured');
  }
  return { value: snapshot.value, unit: snapshot.unit, source: 'measured' };
}

// ---- Sessions ---------------------------------------------------------------------

export function createSession({
  id = newId('ses'),
  origin = 'app',
  provenance = null,
  date,
  startedAt = null,
  endedAt = null,
  templateId = null,
  templateNameSnapshot = null,
  bodyweight = emptyBodyweight(),
  note = null,
  now = nowIso(),
}) {
  return {
    id, origin, provenance, date, startedAt, endedAt, templateId, templateNameSnapshot,
    bodyweight, note, warnings: [], recovery: null, createdAt: now, updatedAt: now, performances: [],
  };
}

export function createPerformance({ id = newId('prf'), exercise, order }) {
  return {
    id, exerciseId: exercise.id, order, nameSnapshot: exercise.name,
    measurement: snapshotMeasurement(exercise), note: null, sets: [],
  };
}

/** All metric fields null; distance_duration sets also carry durationBasis: null. */
export function createSet({ id = newId('set'), measurement, order }) {
  const s = { id, order, completed: false, load: null, reps: null, durationSec: null, distanceM: null };
  if (measurement.type === 'distance_duration') s.durationBasis = null;
  if (!ALLOWED_SET_FIELDS[measurement.type]) throw new RangeError(`Unknown measurement type ${measurement.type}`);
  return s;
}

// ---- Records and goals -------------------------------------------------------------

const RECORD_FIELDS = ['load', 'loadUnit', 'loadBasis', 'reps', 'repsText', 'durationSec', 'distanceM'];

/** D23: a time_for_distance record requires an explicit timeBasis argument ("elapsed", "moving" or null). */
export function createManualRecord(args) {
  const { id = newId('rec'), exerciseId, metric, bodyweight = emptyBodyweight(), relatedSetRef = null, date = null, note = null, source = 'manual', now = nowIso() } = args;
  if (!MANUAL_RECORD_METRICS.includes(metric)) throw new RangeError(`Unknown metric ${metric}`);
  let timeBasis = null;
  if (metric === 'time_for_distance') {
    if (!Object.prototype.hasOwnProperty.call(args, 'timeBasis')) {
      throw new TypeError('time_for_distance requires an explicit timeBasis ("elapsed", "moving" or null for unknown)');
    }
    if (args.timeBasis !== null && !TIME_BASIS.includes(args.timeBasis)) throw new RangeError('Invalid timeBasis');
    timeBasis = args.timeBasis;
  }
  const rec = { id, exerciseId, metric };
  for (const f of RECORD_FIELDS) rec[f] = args[f] ?? null;
  Object.assign(rec, { timeBasis, bodyweight, relatedSetRef, date, note, source, createdAt: now, updatedAt: now });
  return rec;
}

export function createGoal({ id = newId('goal'), exerciseId, metric, target, deadline = null, source = 'manual', now = nowIso() }) {
  if (!GOAL_METRICS.includes(metric)) throw new RangeError(`Unknown goal metric ${metric}`);
  return { id, exerciseId, metric, target: { ...target }, deadline, archived: false, source, createdAt: now, updatedAt: now };
}

// ---- Quarantine ----------------------------------------------------------------------

/** Q-REMOVED entry for an explicitly removed preserved performance. `raw` is a full copy of the performance. */
export async function createRemovedPerformanceQuarantine({ id = newId('q'), performance, session, verifiedAgainstOriginal, now = nowIso() }) {
  if (typeof verifiedAgainstOriginal !== 'boolean') throw new TypeError('verifiedAgainstOriginal must be set explicitly');
  const raw = structuredClone(performance);
  return {
    id,
    importId: session.provenance?.importId ?? null,
    reason: 'performance_removed_by_user',
    raw,
    rawCanonicalSha256: await canonicalSha256(raw),
    context: {
      sessionId: session.id,
      performanceId: performance.id,
      removedAt: now,
      sessionOrigin: session.origin,
      sessionProvenance: session.provenance === null ? null : structuredClone(session.provenance),
      verifiedAgainstOriginal,
    },
  };
}
