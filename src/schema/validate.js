// validateStore — checks every state invariant of the approved Schema v2.
//
// Returns { valid, errors, warnings, activeSessionState, conflictKind }.
//   errors[]:   { code, path, message }   — any error means the store is structurally invalid.
//   warnings[]: { code, path, message }   — non-fatal (e.g. a template item pointing to an archived exercise).
//   activeSessionState: 'none' | 'ok' | 'edit_conflict' (derived, never stored; Phase 2b EC rules).
//
// Field lists come from SCHEMA_FIELDS[store.schemaVersion] (strict, schema-version-aware). An unsupported
// schemaVersion is rejected up front and no field checks are run against it.
//
// Transition rules that need the previously stored version (TR-P1b, TR-P1e, TR-PP6 "new in this commit",
// TR-QV1/QV2, TR-CANCEL, TR-SAVENEW, revision and bookkeeping rules) are NOT checked here; they belong to
// the commit logic (steps 2b.5 / 2b.6).
//
// Never throws on bad data; it reports. Asynchronous only because of SHA-256 (INV-Q1).

import * as C from './constants.js';
import { SCHEMA_FIELDS, SUPPORTED_SCHEMA_VERSIONS } from './fields.js';
import { canonicalize, canonicalSha256 } from './canonical.js';
import { syncSectionProblems } from '../sync/local.js';

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoTimestamp(v) {
  if (typeof v !== 'string' || !ISO_TS.test(v)) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === v.slice(0, 19);
}

export function isLocalDate(v) {
  const m = typeof v === 'string' ? LOCAL_DATE.exec(v) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
const isBool = (v) => typeof v === 'boolean';
const isInt = (v) => Number.isSafeInteger(v);
const hasPrefix = (id, p) => isStr(id) && id.startsWith(`${p}_`) && id.length > p.length + 1;
const ALL_LOAD_BASIS = [...new Set(Object.values(C.ALLOWED_LOAD_BASIS).flat())];

// ---- Metric ↔ exercise-type compatibility, derived from the approved measurement definitions -------
// A metric is compatible with a type when every set field the metric needs is allowed for that type
// (ALLOWED_SET_FIELDS). No separate table of exercise names.
export const METRIC_REQUIRED_SET_FIELDS = Object.freeze({
  max_load: Object.freeze(['load']),
  actual_1rm: Object.freeze(['load', 'reps']),
  load_for_min_reps: Object.freeze(['load', 'reps']),
  max_reps: Object.freeze(['reps']),
  best_duration: Object.freeze(['durationSec']),
  max_distance: Object.freeze(['distanceM']),
  time_for_distance: Object.freeze(['distanceM', 'durationSec']),
});

export function compatibleTypes(metric) {
  const need = METRIC_REQUIRED_SET_FIELDS[metric] ?? [];
  return C.MEASUREMENT_TYPES.filter((t) => need.length > 0 && need.every((fld) => C.ALLOWED_SET_FIELDS[t].includes(fld)));
}

// ---- Split consistency V1–V5 (pure; reused by derived calculations in 2b.8) ---------------------------
/**
 * Returns violations [{ rule, index, message }] for a set's splits. V5 is the absence of a rule:
 * the set total is never compared with a split of a different or unknown time basis.
 */
export function splitViolations(set) {
  const out = [];
  const list = Array.isArray(set?.splits) ? set.splits : [];
  if (!list.every((s) => isObj(s) && typeof s.distanceM === 'number' && typeof s.timeSec === 'number')) return out;
  if (new Set(list.map((s) => s.timeBasis)).size > 1) out.push({ rule: 'V1', index: null, message: 'all splits must share the same timeBasis' });
  for (let i = 1; i < list.length; i++) {
    if (!(list[i].distanceM > list[i - 1].distanceM)) out.push({ rule: 'V2', index: i, message: 'distances must be strictly increasing' });
    if (list[i].timeSec < list[i - 1].timeSec) out.push({ rule: 'V2', index: i, message: 'times must be non-decreasing' });
  }
  if (typeof set.distanceM === 'number') {
    list.forEach((s, i) => { if (s.distanceM > set.distanceM) out.push({ rule: 'V3', index: i, message: 'beyond the set distance' }); });
  }
  if (typeof set.durationSec === 'number' && set.durationBasis !== null && set.durationBasis !== undefined) {
    list.forEach((s, i) => {
      if (s.timeBasis !== null && s.timeBasis === set.durationBasis && s.timeSec > set.durationSec) {
        out.push({ rule: 'V4', index: i, message: 'beyond the set duration on the same time basis' });
      }
    });
  }
  return out;
}

/** Unresolved-ness of a performance: by its snapshot, or by its catalog exercise. */
function perfIsUnresolved(perf, exById) {
  if (perf?.measurement?.type === 'unresolved') return true;
  return exById.get(perf?.exerciseId)?.measurement?.type === 'unresolved';
}

function withoutOrder(perf) {
  const { order, ...rest } = perf;
  return rest;
}

function safeCanonical(v) {
  try {
    return canonicalize(v);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

export async function validateStore(store) {
  const errors = [];
  const warnings = [];
  const pending = [];
  const err = (code, path, message) => errors.push({ code, path, message });
  const warn = (code, path, message) => warnings.push({ code, path, message });
  const done = (activeSessionState = 'none', conflictKind = null) => ({ valid: errors.length === 0, errors, warnings, activeSessionState, conflictKind });

  if (!isObj(store)) {
    err('INV-SHAPE', '$', 'must be an object');
    return done();
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(store.schemaVersion)) {
    err('INV-ROOT', '$.schemaVersion', `unsupported schema version (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`);
    return done();
  }
  const F = SCHEMA_FIELDS[store.schemaVersion];

  // Strict fields: required present, nothing unknown.
  const keys = (obj, path, required, optional = [], code = 'INV-SHAPE') => {
    if (!isObj(obj)) {
      err(code, path, 'must be an object');
      return false;
    }
    for (const k of required) if (!(k in obj)) err(code, `${path}.${k}`, 'required field missing');
    const allowed = new Set([...required, ...optional]);
    for (const k of Object.keys(obj)) if (!allowed.has(k)) err(code, `${path}.${k}`, 'unknown field');
    return true;
  };

  // INV-4 numbers
  const number = (v, path, { nullable = true, integer = false, gt = false, decimals = null } = {}) => {
    if (v === null) {
      if (!nullable) err('INV-4', path, 'value required');
      return;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return err('INV-4', path, 'must be a finite number or null');
    if (gt ? !(v > 0) : !(v >= 0)) return err('INV-4', path, gt ? 'must be > 0' : 'must be ≥ 0');
    if (integer && !Number.isInteger(v)) return err('INV-4', path, 'must be an integer');
    if (decimals !== null && Math.round(v * 10 ** decimals) / 10 ** decimals !== v) err('INV-4', path, `at most ${decimals} decimal place(s)`);
  };
  const ts = (v, path, nullable = false) => {
    if (v === null && nullable) return;
    if (!isIsoTimestamp(v)) err('INV-8', path, 'must be an ISO UTC timestamp');
  };
  const strOrNull = (v, path) => {
    if (v !== null && !isStr(v)) err('INV-SHAPE', path, 'must be a string or null');
  };
  const stringArray = (v, path) => {
    if (!Array.isArray(v) || v.some((x) => !isStr(x))) err('INV-SHAPE', path, 'must be an array of strings');
  };
  // INV-6: within one parent, order values are exactly 1..n (integers, unique, contiguous, 1-based).
  // Array position is NOT required to match (the approved design only requires contiguity).
  const contiguousOrder = (items, path, label) => {
    const objs = items.filter(isObj);
    let allInts = true;
    items.forEach((x, i) => {
      if (isObj(x) && !(isInt(x.order) && x.order >= 1)) {
        allInts = false;
        err('INV-6', `${path}[${i}].order`, 'must be an integer ≥ 1');
      }
    });
    if (!allInts || objs.length === 0) return;
    const orders = objs.map((x) => x.order);
    if (new Set(orders).size !== orders.length || Math.max(...orders) !== orders.length) {
      err('INV-6', path, `${label} order values must be exactly 1..${orders.length} (unique, contiguous, 1-based)`);
    }
  };

  if (!keys(store, '$', F.root, F.rootOptional ?? [])) return done();
  if ('sync' in store) for (const m of syncSectionProblems(store.sync)) err('INV-SYNC', '$.sync', m);
  for (const k of ['exercises', 'templates', 'sessions', 'manualRecords', 'goals', 'quarantine']) {
    if (!Array.isArray(store[k])) err('INV-SHAPE', `$.${k}`, 'must be an array');
  }
  const arr = (k) => (Array.isArray(store[k]) ? store[k] : []);

  // ---- meta --------------------------------------------------------------
  const meta = store.meta;
  const importIds = new Set();
  const importById = new Map(); // importId → entry, for INV-IMP-LINK
  if (keys(meta, '$.meta', F.meta)) {
    ts(meta.createdAt, '$.meta.createdAt');
    ts(meta.updatedAt, '$.meta.updatedAt');
    if (!isNonEmptyStr(meta.appVersion)) err('INV-SHAPE', '$.meta.appVersion', 'must be a non-empty string');
    if (!isInt(meta.dataRevision) || meta.dataRevision < 1) err('INV-REV', '$.meta.dataRevision', 'must be an integer ≥ 1');

    if (!isObj(meta.seedsApplied)) err('INV-SHAPE', '$.meta.seedsApplied', 'must be an object');
    else for (const [id, v] of Object.entries(meta.seedsApplied)) if (!isInt(v) || v < 1) err('INV-SEED', `$.meta.seedsApplied.${id}`, 'version must be an integer ≥ 1');

    if (!isObj(meta.seedTombstones)) err('INV-SHAPE', '$.meta.seedTombstones', 'must be an object');
    else {
      for (const [id, t] of Object.entries(meta.seedTombstones)) {
        const p = `$.meta.seedTombstones.${id}`;
        if (keys(t, p, F.seedTombstone)) {
          ts(t.deletedAt, `${p}.deletedAt`);
          if (!isInt(t.versionAtDeletion) || t.versionAtDeletion < 1) err('INV-SEED', `${p}.versionAtDeletion`, 'must be an integer ≥ 1');
        }
        if (isObj(meta.seedsApplied) && !(id in meta.seedsApplied)) err('INV-SD2', p, 'tombstoned seed ID must also appear in seedsApplied');
      }
    }

    const ob = meta.onboarding;
    if (keys(ob, '$.meta.onboarding', F.onboarding)) {
      if (!['pending', 'done', 'skipped'].includes(ob.personalSeed)) err('INV-SHAPE', '$.meta.onboarding.personalSeed', 'invalid value');
      if (keys(ob.checks, '$.meta.onboarding.checks', F.onboardingChecks)) {
        for (const c of F.onboardingChecks) if (!isBool(ob.checks[c])) err('INV-SHAPE', `$.meta.onboarding.checks.${c}`, 'must be boolean');
      }
      ts(ob.userVerifiedAt, '$.meta.onboarding.userVerifiedAt', true);
    }

    if (!Array.isArray(meta.importLog)) err('INV-SHAPE', '$.meta.importLog', 'must be an array');
    else meta.importLog.forEach((e, i) => validateImportLogEntry(e, `$.meta.importLog[${i}]`));
  }

  function validateImportLogEntry(e, p) {
    const extra = F.importLogByKind[e?.kind] ?? { required: [], optional: [] };
    if (!keys(e, p, [...F.importLogBase, ...extra.required], extra.optional, 'INV-IMP')) return;
    if (!hasPrefix(e.importId, 'imp')) err('INV-1', `${p}.importId`, 'must start with "imp_"');
    else if (importIds.has(e.importId)) err('INV-1', `${p}.importId`, 'duplicate importId');
    else {
      importIds.add(e.importId);
      importById.set(e.importId, e);
    }
    if (!C.IMPORT_KINDS.includes(e.kind)) err('INV-IMP', `${p}.kind`, 'unknown kind');
    if (!C.IMPORT_STATUS.includes(e.status)) err('INV-IMP', `${p}.status`, 'invalid status');
    ts(e.at, `${p}.at`);
    ts(e.reportSeenAt, `${p}.reportSeenAt`, true);
    for (const h of ['sourceSha256', 'packageSha256']) if (e[h] !== null && !HEX64.test(e[h] ?? '')) err('INV-IMP', `${p}.${h}`, 'must be 64 hex characters or null');
    if (keys(e.counts, `${p}.counts`, F.importCounts, [], 'INV-IMP')) {
      for (const c of F.importCounts) number(e.counts[c], `${p}.counts.${c}`, { nullable: false, integer: true });
    }
    stringArray(e.unresolvedExercises, `${p}.unresolvedExercises`);
    stringArray(e.calculationChanges, `${p}.calculationChanges`);
    if (!Array.isArray(e.warnings)) err('INV-IMP', `${p}.warnings`, 'must be an array');
    else e.warnings.forEach((w, i) => {
      if (keys(w, `${p}.warnings[${i}]`, F.importWarning, [], 'INV-IMP')) {
        if (!isNonEmptyStr(w.code)) err('INV-IMP', `${p}.warnings[${i}].code`, 'must be a string');
        strOrNull(w.ref, `${p}.warnings[${i}].ref`);
      }
    });
    if (e.kind === 'v1_migration' && keys(e.reproduction, `${p}.reproduction`, F.importReproduction, [], 'INV-IMP')) {
      if (!HEX64.test(e.reproduction.seedSha256 ?? '')) err('INV-IMP', `${p}.reproduction.seedSha256`, 'must be 64 hex characters');
      if (!isNonEmptyStr(e.reproduction.appVersion)) err('INV-IMP', `${p}.reproduction.appVersion`, 'must be a non-empty string');
      if (!isInt(e.reproduction.rulesVersion) || e.reproduction.rulesVersion < 1) err('INV-IMP', `${p}.reproduction.rulesVersion`, 'must be an integer ≥ 1');
    }
    if (e.kind === 'backup_restore') {
      if (!isNonEmptyStr(e.restoreId)) err('INV-IMP', `${p}.restoreId`, 'must be a non-empty string');
      if (!HEX64.test(e.backupDataSha256 ?? '')) err('INV-IMP', `${p}.backupDataSha256`, 'must be 64 hex characters');
      if (!isBool(e.sourceUnsavedState)) err('INV-IMP', `${p}.sourceUnsavedState`, 'must be boolean');
      if (!isBool(e.prevCopyExists)) err('INV-IMP', `${p}.prevCopyExists`, 'must be boolean');
    }
  }

  // ---- settings -------------------------------------------------------------
  const st = store.settings;
  if (keys(st, '$.settings', F.settings)) {
    if (!C.LOAD_UNITS.includes(st.loadUnit)) err('INV-MEAS', '$.settings.loadUnit', 'must be kg or lb');
    const sb = st.bodyweight;
    if (keys(sb, '$.settings.bodyweight', F.settingsBodyweight)) {
      if ((sb.value === null) !== (sb.unit === null)) err('INV-BW3', '$.settings.bodyweight', 'value and unit must both be set or both be null');
      if (sb.value !== null) number(sb.value, '$.settings.bodyweight.value', { gt: true });
      if (sb.unit !== null && !C.LOAD_UNITS.includes(sb.unit)) err('INV-BW2', '$.settings.bodyweight.unit', 'must be kg or lb');
      if (!isBool(sb.confirmed)) err('INV-SHAPE', '$.settings.bodyweight.confirmed', 'must be boolean');
      if (sb.confirmed === true && sb.value === null) err('INV-BW3', '$.settings.bodyweight.confirmed', 'cannot be confirmed without a value');
      ts(sb.updatedAt, '$.settings.bodyweight.updatedAt', true);
    }
    ts(st.lastBackupAt, '$.settings.lastBackupAt', true);
    if (st.lastBackupRevision !== null && (!isInt(st.lastBackupRevision) || st.lastBackupRevision < 1)) err('INV-REV', '$.settings.lastBackupRevision', 'must be an integer ≥ 1 or null');
    if ((st.lastBackupAt === null) !== (st.lastBackupRevision === null)) err('INV-REV', '$.settings', 'lastBackupAt and lastBackupRevision must both be set or both be null');
    if (isInt(st.lastBackupRevision) && isInt(meta?.dataRevision) && st.lastBackupRevision > meta.dataRevision) err('INV-REV', '$.settings.lastBackupRevision', 'cannot exceed meta.dataRevision');
    // Partial backups (Step 2c, R3-4): recorded separately; never satisfy the complete-backup requirement.
    ts(st.lastPartialBackupAt, '$.settings.lastPartialBackupAt', true);
    if (st.lastPartialBackupRevision !== null && (!isInt(st.lastPartialBackupRevision) || st.lastPartialBackupRevision < 1)) err('INV-REV', '$.settings.lastPartialBackupRevision', 'must be an integer ≥ 1 or null');
    if ((st.lastPartialBackupAt === null) !== (st.lastPartialBackupRevision === null)) err('INV-REV', '$.settings', 'lastPartialBackupAt and lastPartialBackupRevision must both be set or both be null');
    if (isInt(st.lastPartialBackupRevision) && isInt(meta?.dataRevision) && st.lastPartialBackupRevision > meta.dataRevision) err('INV-REV', '$.settings.lastPartialBackupRevision', 'cannot exceed meta.dataRevision');
  }

  // ---- shared validators ------------------------------------------------------

  const idSets = {};
  const uniqueId = (scope, prefix, id, path) => {
    if (!hasPrefix(id, prefix)) return err('INV-1', path, `must start with "${prefix}_"`);
    const set = (idSets[scope] ??= new Set());
    if (set.has(id)) err('INV-1', path, `duplicate ID within ${scope}`);
    set.add(id);
  };

  const originOk = (origin, path) => {
    if (C.ORIGINS.includes(origin)) return true;
    if (C.RESERVED_FUTURE_ORIGINS.includes(origin)) err('INV-12', path, `origin "${origin}" is reserved for a future phase and not valid in schema v2`);
    else err('INV-12', path, 'unknown origin');
    return false;
  };

  function measurement(m, p) {
    if (!keys(m, p, F.measurement, [], 'INV-MEAS')) return null;
    if (!C.MEASUREMENT_TYPES.includes(m.type)) {
      err('INV-MEAS', `${p}.type`, 'unknown measurement type');
      return null;
    }
    const basis = C.ALLOWED_LOAD_BASIS[m.type];
    if (basis) {
      if (!basis.includes(m.loadBasis)) err('INV-MEAS', `${p}.loadBasis`, `must be one of ${basis.join(', ')}`);
    } else if (m.loadBasis !== null) err('INV-MEAS', `${p}.loadBasis`, 'must be null for this type');
    const hasLoad = C.ALLOWED_SET_FIELDS[m.type].includes('load');
    if (hasLoad) {
      if (!C.LOAD_UNITS.includes(m.loadUnit)) err('INV-MEAS', `${p}.loadUnit`, 'must be kg or lb');
    } else if (m.loadUnit !== null) err('INV-MEAS', `${p}.loadUnit`, 'must be null for this type');
    if (m.volumeFactor !== null) {
      if (!C.VOLUME_FACTOR_TYPES.includes(m.type) || m.loadUnit === null) err('INV-13', `${p}.volumeFactor`, 'only allowed for weight_reps with a load unit');
      else if (typeof m.volumeFactor !== 'number' || !Number.isFinite(m.volumeFactor) || !(m.volumeFactor > 0)) err('INV-13', `${p}.volumeFactor`, 'must be a positive number');
    }
    if (m.repsBasis !== null) {
      if (!C.REPS_BASIS_VALUES.includes(m.repsBasis)) err('INV-MEAS', `${p}.repsBasis`, 'must be "per_side" or null');
      else if (!C.TYPES_WITH_REPS.includes(m.type)) err('INV-MEAS', `${p}.repsBasis`, 'only allowed for types with reps');
    }
    return m.type;
  }

  function bodyweight(bw, p, allowedSources) {
    if (!isObj(bw)) return err('INV-BW1', p, 'bodyweight must be an object');
    if (!keys(bw, p, F.bodyweight, [], 'INV-BW1')) return;
    const nulls = [bw.value, bw.unit, bw.source].filter((x) => x === null).length;
    if (nulls === 3) return;
    if (nulls > 0) return err('INV-BW3', p, 'partial bodyweight: all fields must be null, or all set');
    if (typeof bw.value !== 'number' || !Number.isFinite(bw.value) || !(bw.value > 0)) err('INV-BW2', `${p}.value`, 'must be a number > 0');
    if (!C.LOAD_UNITS.includes(bw.unit)) err('INV-BW2', `${p}.unit`, 'must be kg or lb');
    if (!allowedSources.includes(bw.source)) err('INV-BW4', `${p}.source`, `not allowed here (allowed: ${allowedSources.join(', ')})`);
  }

  function provenance(origin, prov, p) {
    if (origin === 'app') {
      if (prov !== null) err('INV-12', p, 'must be null for origin "app"');
      return;
    }
    const shape = F.provenance[origin];
    if (!shape) return; // unknown or reserved origin already reported
    if (!keys(prov, p, shape, [], 'INV-12')) return;
    if (!hasPrefix(prov.importId, 'imp')) err('INV-12', `${p}.importId`, 'must start with "imp_"');
    if (origin === 'v1_migration' || origin === 'v1_late_import') {
      if (!HEX64.test(prov.snapshotSha256 ?? '')) err('INV-12', `${p}.snapshotSha256`, 'must be 64 hex characters');
      if (!HEX64.test(prov.sourceSessionSha256 ?? '')) err('INV-12', `${p}.sourceSessionSha256`, 'must be 64 hex characters');
      if (!isInt(prov.legacyWorkoutIndex) || prov.legacyWorkoutIndex < 0) err('INV-12', `${p}.legacyWorkoutIndex`, 'must be an integer ≥ 0');
      const lid = prov.legacyWorkoutId;
      if (!(lid === null || isStr(lid) || (isInt(lid) && lid >= 0))) err('INV-12', `${p}.legacyWorkoutId`, 'must be a non-negative integer, a string, or null');
    }
    if (origin === 'csv_import') {
      for (const fld of ['sourceApp', 'fileName', 'fingerprint']) if (!isNonEmptyStr(prov[fld])) err('INV-12', `${p}.${fld}`, 'must be a non-empty string');
      for (const fld of ['fileSha256', 'packageSha256']) if (!HEX64.test(prov[fld] ?? '')) err('INV-12', `${p}.${fld}`, 'must be 64 hex characters');
      if (!isInt(prov.rowStart) || prov.rowStart < 1) err('INV-12', `${p}.rowStart`, 'must be an integer ≥ 1');
      if (!isInt(prov.rowEnd) || prov.rowEnd < prov.rowStart) err('INV-12', `${p}.rowEnd`, 'must be an integer ≥ rowStart');
      if (!C.LOAD_UNITS.includes(prov.weightUnitConfirmed)) err('INV-12', `${p}.weightUnitConfirmed`, 'must be kg or lb');
      if (prov.dateSource !== 'user_confirmed') err('INV-12', `${p}.dateSource`, 'must be "user_confirmed"');
      if (prov.durationBasisConfirmed !== null && !C.TIME_BASIS.includes(prov.durationBasisConfirmed)) err('INV-12', `${p}.durationBasisConfirmed`, 'must be elapsed, moving or null');
    }
  }

  function splitsField(set, type, origin, p) {
    if (type !== 'distance_duration') return err('INV-SPLIT', `${p}.splits`, 'only allowed on distance_duration sets');
    if (!C.SPLIT_ORIGINS.includes(origin)) return err('INV-SPLIT', `${p}.splits`, `sets with origin "${origin}" cannot carry splits (only the future activity importer provides them)`);
    const list = set.splits;
    if (!Array.isArray(list) || list.length === 0) return err('INV-SPLIT', `${p}.splits`, 'must be null or a non-empty array');
    list.forEach((s, i) => {
      if (keys(s, `${p}.splits[${i}]`, F.split, [], 'INV-SPLIT')) {
        number(s.distanceM, `${p}.splits[${i}].distanceM`, { nullable: false, gt: true, decimals: C.DISTANCE_DECIMALS });
        number(s.timeSec, `${p}.splits[${i}].timeSec`, { nullable: false, integer: true });
        if (s.timeBasis !== null && !C.TIME_BASIS.includes(s.timeBasis)) err('INV-SPLIT', `${p}.splits[${i}].timeBasis`, 'must be elapsed, moving or null');
      }
    });
    for (const v of splitViolations(set)) err(v.rule, v.index === null ? `${p}.splits` : `${p}.splits[${v.index}]`, v.message);
  }

  function setRecord(set, type, origin, p) {
    const required = [...F.setRequired];
    if (type === 'distance_duration') required.push('durationBasis');
    if (!keys(set, p, required, F.setOptional)) return;
    if (!isBool(set.completed)) err('INV-5', `${p}.completed`, 'must be boolean');
    number(set.load, `${p}.load`);
    number(set.reps, `${p}.reps`, { integer: true });
    number(set.durationSec, `${p}.durationSec`, { integer: true });
    number(set.distanceM, `${p}.distanceM`, { decimals: C.DISTANCE_DECIMALS });
    if (type) {
      const allowed = C.ALLOWED_SET_FIELDS[type];
      for (const fld of C.SET_METRIC_FIELDS) if (!allowed.includes(fld) && set[fld] !== null) err('INV-3', `${p}.${fld}`, `not allowed for type ${type}; must be null`);
    }
    if (type === 'distance_duration') {
      if (set.durationBasis !== null && !C.TIME_BASIS.includes(set.durationBasis)) err('INV-TB', `${p}.durationBasis`, 'must be elapsed, moving or null');
      if (set.durationSec === null && set.durationBasis !== null) err('INV-TB', `${p}.durationBasis`, 'must be null when durationSec is null');
    } else if ('durationBasis' in set && set.durationBasis !== null) err('INV-TB', `${p}.durationBasis`, 'only allowed on distance_duration sets');
    if ('splits' in set && set.splits !== null) splitsField(set, type, origin, p);
    const has = (k) => k in set;
    if (origin === 'app') {
      for (const k of ['sourceRef', 'sourceRaw', 'sourceContext']) if (has(k)) err('INV-12', `${p}.${k}`, 'not allowed on app-origin sets');
    } else if (origin === 'v1_migration' || origin === 'v1_late_import') {
      if (has('sourceRef') && keys(set.sourceRef, `${p}.sourceRef`, F.sourceRefV1, [], 'INV-12')) {
        if (!isInt(set.sourceRef.e) || set.sourceRef.e < 0) err('INV-12', `${p}.sourceRef.e`, 'must be an integer ≥ 0');
        if (!isInt(set.sourceRef.s) || set.sourceRef.s < 0) err('INV-12', `${p}.sourceRef.s`, 'must be an integer ≥ 0');
      }
      if (has('sourceContext')) {
        if (type !== 'unresolved') err('INV-12', `${p}.sourceContext`, 'only allowed on unresolved sets');
        else if (keys(set.sourceContext, `${p}.sourceContext`, F.sourceContextV1, [], 'INV-12')) {
          stringArray(set.sourceContext.v1Fields, `${p}.sourceContext.v1Fields`);
          stringArray(set.sourceContext.v1Labels, `${p}.sourceContext.v1Labels`);
          strOrNull(set.sourceContext.v1CustomType, `${p}.sourceContext.v1CustomType`);
        }
      }
    } else if (origin === 'csv_import') {
      if (has('sourceRef') && keys(set.sourceRef, `${p}.sourceRef`, F.sourceRefCsv, [], 'INV-12')) {
        if (!isInt(set.sourceRef.row) || set.sourceRef.row < 1) err('INV-12', `${p}.sourceRef.row`, 'must be an integer ≥ 1');
        if (!has('sourceRaw')) err('INV-12', `${p}.sourceRaw`, 'CSV-sourced sets must keep the full source row');
      }
      if (has('sourceContext')) err('INV-12', `${p}.sourceContext`, 'not allowed for CSV imports');
    }
    if (has('sourceRaw') && set.sourceRaw === undefined) err('INV-12', `${p}.sourceRaw`, 'must not be undefined');
    if (type === 'unresolved') {
      if (!has('sourceRaw')) err('INV-UNRES', `${p}.sourceRaw`, 'unresolved sets must keep their source values');
      if ((origin === 'v1_migration' || origin === 'v1_late_import') && !has('sourceContext')) err('INV-UNRES', `${p}.sourceContext`, 'unresolved v1 sets must keep their v1 field context');
    }
    if (has('warnings')) stringArray(set.warnings, `${p}.warnings`);
  }

  /** Validates a performance's structure. `refs` toggles reference checks (off for quarantined raw). */
  function performance(perf, p, { origin, exById, refs = true, scope }) {
    if (!keys(perf, p, F.performance)) return null;
    if (scope) uniqueId(scope.perf, 'prf', perf.id, `${p}.id`);
    else if (!hasPrefix(perf.id, 'prf')) err('INV-1', `${p}.id`, 'must start with "prf_"');
    if (!isStr(perf.exerciseId)) err('INV-SHAPE', `${p}.exerciseId`, 'must be a string');
    else if (refs && !exById.has(perf.exerciseId)) err('INV-2', `${p}.exerciseId`, 'references a missing exercise');
    if (!isNonEmptyStr(perf.nameSnapshot)) err('INV-SHAPE', `${p}.nameSnapshot`, 'must be a non-empty string');
    strOrNull(perf.note, `${p}.note`);
    const type = measurement(perf.measurement, `${p}.measurement`);
    if (!Array.isArray(perf.sets)) {
      err('INV-SHAPE', `${p}.sets`, 'must be an array');
      return type;
    }
    if (type === 'note' && perf.sets.length > 0) err('INV-NOTE', `${p}.sets`, 'note performances have no sets');
    contiguousOrder(perf.sets, `${p}.sets`, 'set');
    perf.sets.forEach((s, j) => {
      const sp = `${p}.sets[${j}]`;
      if (isObj(s)) {
        if (scope) uniqueId(scope.set, 'set', s.id, `${sp}.id`);
        else if (!hasPrefix(s.id, 'set')) err('INV-1', `${sp}.id`, 'must start with "set_"');
      }
      setRecord(s, type, origin, sp);
    });
    return type;
  }

  /**
   * INV-IMP-LINK: an imported session belongs to an import-log entry of the same kind; a v1 session's
   * snapshotSha256 is that entry's sourceSha256 (both are the SHA-256 of the same v1 source text).
   * This is a consistency rule: it says nothing about who created a store or a backup file.
   */
  function importLink(origin, prov, p) {
    if (!['v1_migration', 'v1_late_import', 'csv_import'].includes(origin) || !isObj(prov) || !isStr(prov.importId)) return;
    const entry = importById.get(prov.importId);
    if (!entry) return err('INV-IMP-LINK', `${p}.importId`, 'must reference an import-log entry');
    if (entry.kind !== origin) return err('INV-IMP-LINK', `${p}.importId`, `references a "${entry.kind}" entry; origin "${origin}" needs a "${origin}" entry`);
    if (origin !== 'csv_import' && prov.snapshotSha256 !== entry.sourceSha256) err('INV-IMP-LINK', `${p}.snapshotSha256`, 'must equal the sourceSha256 of its import-log entry');
  }

  function session(s, p, { exById, scope }) {
    if (!keys(s, p, F.session)) return;
    originOk(s.origin, `${p}.origin`);
    provenance(s.origin, s.provenance, `${p}.provenance`);
    importLink(s.origin, s.provenance, `${p}.provenance`);
    if (s.date === null) {
      if (s.origin === 'app') err('INV-8', `${p}.date`, 'app sessions must have a date');
    } else if (!isLocalDate(s.date)) err('INV-8', `${p}.date`, 'must be a valid YYYY-MM-DD date or null');
    ts(s.startedAt, `${p}.startedAt`, true);
    ts(s.endedAt, `${p}.endedAt`, true);
    ts(s.createdAt, `${p}.createdAt`);
    ts(s.updatedAt, `${p}.updatedAt`);
    strOrNull(s.templateId, `${p}.templateId`); // may dangle: templates can be deleted; the name snapshot is the historical display
    strOrNull(s.templateNameSnapshot, `${p}.templateNameSnapshot`);
    strOrNull(s.note, `${p}.note`);
    stringArray(s.warnings, `${p}.warnings`);
    bodyweight(s.bodyweight, `${p}.bodyweight`, C.BODYWEIGHT_SOURCES.session);
    if (s.recovery !== null) {
      if (keys(s.recovery, `${p}.recovery`, F.recovery, [], 'INV-RC2')) {
        if (!hasPrefix(s.recovery.recoveredFromSessionId, 'ses')) err('INV-RC2', `${p}.recovery.recoveredFromSessionId`, 'must be a session ID');
        else if (s.recovery.recoveredFromSessionId === s.id) err('INV-RC2', `${p}.recovery.recoveredFromSessionId`, 'cannot equal the session ID');
        if (!isIsoTimestamp(s.recovery.recoveredAt)) err('INV-RC2', `${p}.recovery.recoveredAt`, 'must be an ISO timestamp');
        if (!C.CONFLICT_KINDS.includes(s.recovery.conflictKind)) err('INV-RC2', `${p}.recovery.conflictKind`, 'invalid conflictKind');
        // INV-RC3: the referenced session does not need to exist.
      }
    }
    if (!Array.isArray(s.performances)) return err('INV-SHAPE', `${p}.performances`, 'must be an array');
    contiguousOrder(s.performances, `${p}.performances`, 'performance');
    s.performances.forEach((perf, i) => performance(perf, `${p}.performances[${i}]`, { origin: s.origin, exById, scope }));
  }

  // ---- exercises ------------------------------------------------------------------
  const exById = new Map();
  arr('exercises').forEach((ex) => { if (isObj(ex) && isStr(ex.id)) exById.set(ex.id, ex); });

  function seedRef(entity, p) {
    if (entity.seed === null) return;
    if (keys(entity.seed, `${p}.seed`, F.seed, [], 'INV-SEED')) {
      if (entity.seed.id !== entity.id) err('INV-SEED', `${p}.seed.id`, 'must equal the entity ID');
      if (!isInt(entity.seed.version) || entity.seed.version < 1) err('INV-SEED', `${p}.seed.version`, 'must be an integer ≥ 1');
    }
  }

  arr('exercises').forEach((ex, i) => {
    const p = `$.exercises[${i}]`;
    if (!keys(ex, p, F.exercise)) return;
    uniqueId('exercises', 'ex', ex.id, `${p}.id`);
    if (!isNonEmptyStr(ex.name)) err('INV-SHAPE', `${p}.name`, 'must be a non-empty string');
    stringArray(ex.aliases, `${p}.aliases`);
    if (Array.isArray(ex.aliases) && new Set(ex.aliases).size !== ex.aliases.length) err('INV-SHAPE', `${p}.aliases`, 'aliases must be unique');
    strOrNull(ex.group, `${p}.group`);
    strOrNull(ex.equipment, `${p}.equipment`);
    strOrNull(ex.variantGroup, `${p}.variantGroup`);
    const type = measurement(ex.measurement, `${p}.measurement`);
    if (!isBool(ex.isCustom)) err('INV-SHAPE', `${p}.isCustom`, 'must be boolean');
    if (!isBool(ex.archived)) err('INV-SHAPE', `${p}.archived`, 'must be boolean');
    seedRef(ex, p);
    if (ex.prefill !== null) {
      if (keys(ex.prefill, `${p}.prefill`, F.prefill)) {
        if (type && !C.ALLOWED_SET_FIELDS[type].includes('load')) err('INV-SHAPE', `${p}.prefill`, 'prefill only for types with a load');
        number(ex.prefill.load, `${p}.prefill.load`, { nullable: false });
        if (ex.prefill.source !== 'personal_seed') err('INV-SHAPE', `${p}.prefill.source`, 'must be "personal_seed"');
      }
    }
    if (ex.mergedInto !== null) {
      if (ex.mergedInto === ex.id) err('INV-2', `${p}.mergedInto`, 'cannot merge into itself');
      else if (!exById.has(ex.mergedInto)) err('INV-2', `${p}.mergedInto`, 'references a missing exercise');
      if (ex.archived !== true) err('INV-2', `${p}.archived`, 'a merged exercise must be archived');
    }
    ts(ex.createdAt, `${p}.createdAt`);
    ts(ex.updatedAt, `${p}.updatedAt`);
  });

  // ---- templates --------------------------------------------------------------------
  arr('templates').forEach((t, i) => {
    const p = `$.templates[${i}]`;
    if (!keys(t, p, F.template)) return;
    uniqueId('templates', 'tpl', t.id, `${p}.id`);
    if (!isNonEmptyStr(t.name)) err('INV-SHAPE', `${p}.name`, 'must be a non-empty string');
    if (!isBool(t.archived)) err('INV-SHAPE', `${p}.archived`, 'must be boolean');
    seedRef(t, p);
    ts(t.createdAt, `${p}.createdAt`);
    ts(t.updatedAt, `${p}.updatedAt`);
    if (!Array.isArray(t.items)) return err('INV-SHAPE', `${p}.items`, 'must be an array');
    contiguousOrder(t.items, `${p}.items`, 'template item');
    t.items.forEach((it, j) => {
      const ip = `${p}.items[${j}]`;
      if (!keys(it, ip, F.templateItem)) return;
      uniqueId('templateItems', 'tpi', it.id, `${ip}.id`);
      const ex = exById.get(it.exerciseId);
      if (!ex) err('INV-2', `${ip}.exerciseId`, 'references a missing exercise');
      else {
        if (ex.archived === true) warn('W-ARCHIVED-REF', `${ip}.exerciseId`, 'references an archived exercise');
        if (ex.measurement?.type === 'unresolved') err('INV-P1a', `${ip}.exerciseId`, 'a template item cannot reference an unresolved exercise');
      }
      const type = ex?.measurement?.type;
      if (type === 'note') {
        if (it.plannedSets !== 0) err('INV-7', `${ip}.plannedSets`, 'must be 0 for note exercises');
      } else if (!isInt(it.plannedSets) || it.plannedSets < 1) err('INV-7', `${ip}.plannedSets`, 'must be an integer ≥ 1');
      if (it.targetReps !== null) {
        if (keys(it.targetReps, `${ip}.targetReps`, F.targetReps, [], 'INV-7')) {
          const { min, max } = it.targetReps;
          if (!isInt(min) || min < 1 || !isInt(max) || max < 1 || min > max) err('INV-7', `${ip}.targetReps`, 'min and max must be integers ≥ 1 with min ≤ max');
        }
      }
      strOrNull(it.targetNote, `${ip}.targetNote`);
    });
  });

  // ---- saved sessions ------------------------------------------------------------------
  const savedScope = { perf: 'performances', set: 'sets' };
  const sessionById = new Map();
  arr('sessions').forEach((s, i) => {
    const p = `$.sessions[${i}]`;
    if (isObj(s)) uniqueId('sessions', 'ses', s.id, `${p}.id`);
    session(s, p, { exById, scope: savedScope });
    if (isObj(s) && isStr(s.id)) sessionById.set(s.id, s);
    if (isObj(s) && s.origin === 'app' && Array.isArray(s.performances)) {
      s.performances.forEach((perf, j) => {
        if (perfIsUnresolved(perf, exById)) err('INV-P1c', `${p}.performances[${j}]`, 'app-origin sessions cannot contain unresolved performances');
      });
    }
  });

  // ---- manual records ---------------------------------------------------------------------
  const LOAD_METRICS = ['max_load', 'actual_1rm', 'load_for_min_reps'];

  function findSet(ref) {
    const s = sessionById.get(ref.sessionId);
    const perf = s?.performances?.find?.((x) => x?.id === ref.performanceId);
    const set = perf?.sets?.find?.((x) => x?.id === ref.setId);
    return { s, perf, set };
  }

  arr('manualRecords').forEach((r, i) => {
    const p = `$.manualRecords[${i}]`;
    if (!keys(r, p, F.manualRecord)) return;
    uniqueId('manualRecords', 'rec', r.id, `${p}.id`);
    const ex = exById.get(r.exerciseId);
    if (!ex) err('INV-2', `${p}.exerciseId`, 'references a missing exercise');
    if (!C.MANUAL_RECORD_METRICS.includes(r.metric)) return err('INV-10', `${p}.metric`, 'unknown metric');
    if (ex && !compatibleTypes(r.metric).includes(ex.measurement?.type)) err('INV-10', `${p}.metric`, `metric ${r.metric} does not fit exercise type ${ex.measurement?.type}`);
    number(r.load, `${p}.load`);
    number(r.reps, `${p}.reps`, { integer: true });
    number(r.durationSec, `${p}.durationSec`, { integer: true });
    number(r.distanceM, `${p}.distanceM`, { decimals: C.DISTANCE_DECIMALS });
    const req = (fld, ok, msg) => { if (!ok) err('INV-10', `${p}.${fld}`, msg); };
    const mustNull = (fs) => fs.forEach((fld) => req(fld, r[fld] === null, `must be null for metric ${r.metric}`));
    if (LOAD_METRICS.includes(r.metric)) {
      req('load', typeof r.load === 'number', 'required');
      req('loadUnit', C.LOAD_UNITS.includes(r.loadUnit), 'must be kg or lb');
      req('loadBasis', ALL_LOAD_BASIS.includes(r.loadBasis), 'invalid loadBasis');
      mustNull(['durationSec', 'distanceM']);
    } else {
      mustNull(['load', 'loadUnit', 'loadBasis']);
    }
    if (r.repsText !== null) {
      req('repsText', isNonEmptyStr(r.repsText), 'must be a non-empty string or null');
      req('repsText', r.metric === 'max_load', 'repsText is only allowed on max_load');
      req('reps', r.reps === null, 'must be null when repsText is set');
    }
    if (r.metric === 'max_load') req('reps', r.reps === null || (isInt(r.reps) && r.reps >= 1), 'must be null or an integer ≥ 1');
    if (r.metric === 'actual_1rm') req('reps', r.reps === C.ACTUAL_1RM_REPS, 'actual_1rm requires reps === 1');
    if (r.metric === 'load_for_min_reps') req('reps', isInt(r.reps) && r.reps >= C.LOAD_FOR_MIN_REPS_MIN, 'load_for_min_reps requires an integer reps ≥ 2');
    if (r.metric === 'max_reps') {
      req('reps', isInt(r.reps) && r.reps >= 1, 'required integer ≥ 1');
      mustNull(['durationSec', 'distanceM']);
    }
    if (r.metric === 'best_duration') {
      req('durationSec', typeof r.durationSec === 'number', 'required');
      mustNull(['reps', 'distanceM']);
    }
    if (r.metric === 'max_distance') {
      req('distanceM', typeof r.distanceM === 'number' && r.distanceM > 0, 'required, > 0');
      mustNull(['reps', 'durationSec']);
    }
    if (r.metric === 'time_for_distance') {
      req('distanceM', typeof r.distanceM === 'number' && r.distanceM > 0, 'required, > 0');
      req('durationSec', typeof r.durationSec === 'number', 'required');
      mustNull(['reps']);
      if (r.timeBasis !== null && !C.TIME_BASIS.includes(r.timeBasis)) err('INV-TB', `${p}.timeBasis`, 'must be elapsed, moving or null');
    } else if (r.timeBasis !== null) err('INV-TB', `${p}.timeBasis`, 'only allowed for time_for_distance');
    bodyweight(r.bodyweight, `${p}.bodyweight`, C.BODYWEIGHT_SOURCES.manualRecord);
    if (r.date !== null && !isLocalDate(r.date)) err('INV-8', `${p}.date`, 'must be YYYY-MM-DD or null');
    strOrNull(r.note, `${p}.note`);
    if (!C.RECORD_SOURCES.includes(r.source)) err('INV-10', `${p}.source`, 'invalid source');
    ts(r.createdAt, `${p}.createdAt`);
    ts(r.updatedAt, `${p}.updatedAt`);
    if (r.relatedSetRef !== null) {
      if (r.metric !== 'time_for_distance') err('INV-RSR', `${p}.relatedSetRef`, 'only allowed on time_for_distance records');
      else if (keys(r.relatedSetRef, `${p}.relatedSetRef`, F.relatedSetRef, [], 'INV-RSR')) {
        const { perf, set } = findSet(r.relatedSetRef);
        if (!set) err('INV-RSR', `${p}.relatedSetRef`, 'does not resolve to an existing set (deleted links must be cleared to null)');
        else if (perf.measurement?.type !== 'distance_duration') err('INV-RSR', `${p}.relatedSetRef`, 'must point to a distance_duration set');
        else if (!(typeof set.distanceM === 'number' && typeof r.distanceM === 'number' && set.distanceM >= r.distanceM)) err('INV-RSR', `${p}.relatedSetRef`, 'the linked run must be at least as long as the record distance');
      }
    }
  });

  // ---- goals ------------------------------------------------------------------------------
  arr('goals').forEach((g, i) => {
    const p = `$.goals[${i}]`;
    if (!keys(g, p, F.goal)) return;
    uniqueId('goals', 'goal', g.id, `${p}.id`);
    const ex = exById.get(g.exerciseId);
    if (!ex) err('INV-2', `${p}.exerciseId`, 'references a missing exercise');
    if (!C.GOAL_METRICS.includes(g.metric)) return err('INV-11', `${p}.metric`, 'unknown goal metric');
    if (ex && !compatibleTypes(g.metric).includes(ex.measurement?.type)) err('INV-11', `${p}.metric`, `metric ${g.metric} does not fit exercise type ${ex.measurement?.type}`);
    const t = g.target;
    if (keys(t, `${p}.target`, F.goalTargets[g.metric], [], 'INV-11')) {
      const tp = `${p}.target`;
      if ('load' in t) number(t.load, `${tp}.load`, { nullable: false });
      if ('loadUnit' in t && !C.LOAD_UNITS.includes(t.loadUnit)) err('INV-11', `${tp}.loadUnit`, 'must be kg or lb');
      if ('loadBasis' in t && !ALL_LOAD_BASIS.includes(t.loadBasis)) err('INV-11', `${tp}.loadBasis`, 'invalid loadBasis');
      if ('reps' in t && !(isInt(t.reps) && t.reps >= C.LOAD_FOR_MIN_REPS_MIN)) err('INV-11', `${tp}.reps`, 'must be an integer ≥ 2');
      if ('distanceM' in t) number(t.distanceM, `${tp}.distanceM`, { nullable: false, gt: true, decimals: C.DISTANCE_DECIMALS });
      if ('durationSec' in t) number(t.durationSec, `${tp}.durationSec`, { nullable: false, integer: true, gt: true });
      if ('timeBasis' in t && !C.TIME_BASIS.includes(t.timeBasis)) err('INV-11', `${tp}.timeBasis`, 'required: elapsed or moving');
    }
    if (g.deadline !== null && !isLocalDate(g.deadline)) err('INV-8', `${p}.deadline`, 'must be YYYY-MM-DD or null');
    if (!isBool(g.archived)) err('INV-SHAPE', `${p}.archived`, 'must be boolean');
    if (!C.GOAL_SOURCES.includes(g.source)) err('INV-11', `${p}.source`, 'invalid source');
    ts(g.createdAt, `${p}.createdAt`);
    ts(g.updatedAt, `${p}.updatedAt`);
  });

  // ---- quarantine ----------------------------------------------------------------------------
  const removedPairs = new Set();
  const removedEntries = [];
  arr('quarantine').forEach((q, i) => {
    const p = `$.quarantine[${i}]`;
    if (!isObj(q)) return err('INV-Q', p, 'must be an object');
    const isImport = C.QUARANTINE_REASONS.import.includes(q.reason);
    const isRemoved = C.QUARANTINE_REASONS.removed.includes(q.reason);
    if (!isImport && !isRemoved) return err('INV-Q', `${p}.reason`, 'unknown quarantine reason');
    if (isImport) {
      if (!keys(q, p, F.quarantineImport, [], 'INV-Q-IMPORT')) return;
    } else if (!keys(q, p, F.quarantineRemoved, [], 'INV-Q1')) return;
    uniqueId('quarantine', 'q', q.id, `${p}.id`);
    if (q.raw === undefined) err('INV-Q', `${p}.raw`, 'must be present');
    if (q.importId !== null && !importIds.has(q.importId)) err('INV-Q', `${p}.importId`, 'references a missing importLog entry');
    if (isImport && q.importId === null) err('INV-Q-IMPORT', `${p}.importId`, 'imported quarantine entries require an importId');
    if (isRemoved) {
      const c = q.context;
      if (keys(c, `${p}.context`, F.removedContext, [], 'INV-Q1')) {
        if (!hasPrefix(c.sessionId, 'ses')) err('INV-Q1', `${p}.context.sessionId`, 'must be a session ID');
        if (!isIsoTimestamp(c.removedAt)) err('INV-Q1', `${p}.context.removedAt`, 'must be an ISO timestamp');
        if (originOk(c.sessionOrigin, `${p}.context.sessionOrigin`)) provenance(c.sessionOrigin, c.sessionProvenance, `${p}.context.sessionProvenance`);
        if (!isBool(c.verifiedAgainstOriginal)) err('INV-Q1', `${p}.context.verifiedAgainstOriginal`, 'must be boolean');
        if (!isObj(q.raw) || c.performanceId !== q.raw.id) err('INV-Q1', `${p}.context.performanceId`, 'must equal raw.id');
        const expectedImportId = isObj(c.sessionProvenance) ? (c.sessionProvenance.importId ?? null) : null;
        if (q.importId !== expectedImportId) err('INV-Q1', `${p}.importId`, 'must equal the session provenance importId (or null)');
        const pair = `${c.sessionId}\u0000${c.performanceId}`;
        if (removedPairs.has(pair)) err('INV-Q1', `${p}.context`, 'duplicate removed-performance entry for the same session and performance');
        removedPairs.add(pair);
        if (isObj(q.raw) && !(isInt(q.raw.order) && q.raw.order >= 1)) err('INV-6', `${p}.raw.order`, 'must be an integer ≥ 1');
        performance(q.raw, `${p}.raw`, { origin: c.sessionOrigin, exById, refs: false, scope: null });
        if (!HEX64.test(q.rawCanonicalSha256 ?? '')) err('INV-Q1', `${p}.rawCanonicalSha256`, 'must be 64 hex characters');
        else {
          pending.push(
            canonicalSha256(q.raw).then(
              (h) => { if (h !== q.rawCanonicalSha256) err('INV-Q1', `${p}.rawCanonicalSha256`, 'does not match the canonical hash of raw'); },
              () => err('INV-Q1', `${p}.raw`, 'cannot be canonicalized'),
            ),
          );
        }
        removedEntries.push(q);
      }
    }
  });

  // ---- seed tombstones (INV-SD1) ---------------------------------------------------------------
  if (isObj(meta?.seedTombstones)) {
    for (const id of Object.keys(meta.seedTombstones)) {
      if (exById.has(id)) err('INV-SD1', `$.meta.seedTombstones.${id}`, 'a tombstoned exercise still exists');
      if (arr('templates').some((t) => t?.id === id)) err('INV-SD1', `$.meta.seedTombstones.${id}`, 'a tombstoned template still exists');
    }
  }

  // ---- active session (PP / EC) -------------------------------------------------------------------
  let activeSessionState = 'none';
  let conflictKind = null;
  const a = store.activeSession;
  if (a !== null) {
    const p = '$.activeSession';
    activeSessionState = 'ok';
    if (keys(a, p, F.activeSession, [], 'INV-AS')) {
      const activeScope = { perf: 'activePerformances', set: 'activeSets' };
      if (!C.ACTIVE_SESSION_MODES.includes(a.mode)) err('INV-AS', `${p}.mode`, 'must be "new" or "edit"');
      const list = a.preservedPerformanceIds;
      const listOk = Array.isArray(list) && list.every(isStr);
      if (!listOk) err('INV-AS', `${p}.preservedPerformanceIds`, 'must be an array of strings');
      session(a.session, `${p}.session`, { exById, scope: activeScope });
      const s = isObj(a.session) ? a.session : null;
      if (s && !hasPrefix(s.id, 'ses')) err('INV-1', `${p}.session.id`, 'must start with "ses_"');

      if (a.mode === 'new') {
        if (a.editsSessionId !== null) err('INV-AS', `${p}.editsSessionId`, 'must be null in new mode');
        if (a.baseUpdatedAt !== null) err('INV-AS', `${p}.baseUpdatedAt`, 'must be null in new mode');
        if (listOk && list.length !== 0) err('INV-PP1', `${p}.preservedPerformanceIds`, 'must be empty in new mode');
        if (s && s.origin !== 'app') err('INV-AS', `${p}.session.origin`, 'a new workout must have origin "app"');
        if (s && sessionById.has(s.id)) err('INV-AS', `${p}.session.id`, 'a new workout cannot reuse a saved session ID');
      }

      if (listOk && new Set(list).size !== list.length) err('INV-PP4', `${p}.preservedPerformanceIds`, 'IDs must be unique');

      const listed = new Set(listOk ? list : []);
      if (s && Array.isArray(s.performances)) {
        s.performances.forEach((perf, j) => {
          if (isObj(perf) && perfIsUnresolved(perf, exById) && !listed.has(perf.id)) {
            err('INV-PP5', `${p}.session.performances[${j}]`, 'unresolved performance is not in preservedPerformanceIds');
          }
        });
      }

      if (a.mode === 'edit') {
        if (!hasPrefix(a.editsSessionId, 'ses')) err('INV-AS', `${p}.editsSessionId`, 'must be a session ID in edit mode');
        if (!isIsoTimestamp(a.baseUpdatedAt)) err('INV-AS', `${p}.baseUpdatedAt`, 'must be an ISO timestamp in edit mode');
        if (s && s.id !== a.editsSessionId) err('INV-AS', `${p}.session.id`, 'must equal editsSessionId');

        const original = sessionById.get(a.editsSessionId);
        if (!original) conflictKind = 'target_missing';
        else if (original.updatedAt !== a.baseUpdatedAt) conflictKind = 'target_changed';

        if (conflictKind) {
          activeSessionState = 'edit_conflict'; // PP3/PP6 cannot be checked against an original; the workout stays unverified.
        } else if (listOk && s && Array.isArray(s.performances)) {
          const origPerf = new Map((original.performances ?? []).filter(isObj).map((x) => [x.id, x]));
          const activePerf = new Map(s.performances.filter(isObj).map((x) => [x.id, x]));
          for (const id of new Set(list)) {
            const op = origPerf.get(id);
            if (!op) {
              err('INV-PP3', `${p}.preservedPerformanceIds`, `"${id}" does not exist in the original session`);
              continue;
            }
            const catalogType = exById.get(op.exerciseId)?.measurement?.type;
            if (op.measurement?.type !== 'unresolved' || catalogType !== 'unresolved') {
              err('INV-PP3', `${p}.preservedPerformanceIds`, `"${id}" does not reference an unresolved exercise in the original session`);
              continue;
            }
            const ap = activePerf.get(id);
            if (ap) {
              if (safeCanonical(withoutOrder(ap)) !== safeCanonical(withoutOrder(op))) {
                err('INV-PP6', `${p}.session.performances`, `preserved performance "${id}" was modified (only order may change)`);
              }
            } else {
              const opCanon = safeCanonical(op);
              const match = removedEntries.filter(
                (q) =>
                  q.context?.sessionId === a.editsSessionId &&
                  q.context?.performanceId === id &&
                  q.context?.verifiedAgainstOriginal === true &&
                  safeCanonical(q.raw) === opCanon,
              );
              if (match.length !== 1) err('INV-PP6', `${p}.preservedPerformanceIds`, `preserved performance "${id}" was removed without a matching verified quarantine entry`);
            }
          }
        }
      }
    }
  }

  await Promise.all(pending);
  return done(activeSessionState, conflictKind);
}
