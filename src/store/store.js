// Store — loading, validated commits, dataRevision, write-failure handling, external-change protection.
// Step 2b.5, revision 2 (approved), extended by Step 2c.2 (approved Step 2c plan, revisions 2–9).
// Deliberately simple for a single-user app:
//
// - Every write validates the full candidate store first. Invalid data is never written.
// - Every operation that can write, plus load/reload, runs through ONE per-instance FIFO queue.
// - The final step of every write is persist(): one synchronous block with no await inside it:
//     re-check `stale` → read storage → compare with the baseline → apply in memory → write.
//   This narrows the cross-window race window but does NOT make cross-window writes atomic:
//   browsers do not lock Web Storage across windows, so two windows that pass the check at the
//   same instant can still overwrite each other. There is no Web Locks and no BroadcastChannel
//   by design (approved simplification B/C).
// - A failed write is never reported as saved. The change stays in memory (`unsaved`) and can be
//   retried (retrySave, or the next write) or exported (exportCurrentState).
// - A read failure during a write attempt never results in a write.
// - An external change is never overwritten. The store becomes `stale`; every write is refused
//   until reload({ discardUnsaved }) — and the in-memory data stays exportable.
// - No read-back after a normal write (approved simplification D): a storage write either stores
//   the value or throws, and reading it back proves nothing about the disk. The one exception is
//   markImportVerified (Step 2c), which re-reads storage on purpose before marking an import.
//
// dataRevision: commit() adds exactly 1 per real user-data change (no-op → no increase).
// Bookkeeping (recordBackup, updateOnboarding, markImportReportSeen, markImportVerified) never
// changes it.
//
// Bookkeeping while `unsaved`: recordBackup refuses (UNSAVED_STATE: an unsaved state cannot be the
// verified latest backup). updateOnboarding / markImportReportSeen apply their one field on top of
// the CURRENT in-memory store, so a successful write also saves the earlier unsaved user-data
// changes; a failed write keeps all of them in memory.
//
// Step 2c.2 additions:
// - Pending lock (R2-2): while any import-log entry is `pending`, every user write (commit,
//   retrySave and all bookkeeping) is refused with IMPORT_PENDING. Only markImportVerified and
//   rebuildPendingMigration may write a store that holds a pending import.
// - Protected fields (R4-5): settings.lastBackupAt/Revision, settings.lastPartialBackupAt/Revision
//   and meta.onboarding.userVerifiedAt. commit can never change them; initialize and
//   rebuildPendingMigration require them all null; recordBackup changes only its own pair;
//   updateOnboarding is the only way to set a new userVerifiedAt, and only with a current
//   COMPLETE backup (BACKUP_REQUIRED). replaceStore (restore) takes the backup's values as history.
// - Step 2b.6: commit also enforces the commit-time transition rules (src/core/transitions.js).
// - Remediation A/B/D8: an ordinary commit cannot change the import log, session origin/provenance,
//   protected (unresolved) performances, unresolved exercises or existing quarantine entries.
//   appendLateImport is the dedicated, checked write for a late import (strict persistence).
// - replaceStore, markImportVerified and rebuildPendingMigration use 'strict' persistence: the
//   candidate is applied in memory only after the write succeeded (R2-6). A failed write leaves
//   memory and storage on the old state.

import { STORAGE_KEYS, QUARANTINE_REASONS } from '../schema/constants.js';
import { canonicalize, sha256Hex } from '../schema/canonical.js';
import { createEmptyStore } from '../schema/factories.js';
import { validateStore } from '../schema/validate.js';
import { SCHEMA_FIELDS } from '../schema/fields.js';
import { createStorage, StorageWriteError, StorageReadError } from './storage.js';
import { checkTransition } from '../core/transitions.js';
import { stampOutbox, reconcileOutbox, emptySyncSection } from '../sync/local.js';
import { randomUuid } from '../schema/ids.js';

const KEY = STORAGE_KEYS.v2;
const F = SCHEMA_FIELDS[2];
const HEX64 = /^[0-9a-f]{64}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function canonicalOrNull(value) {
  try {
    return canonicalize(value);
  } catch {
    return null;
  }
}

// ---- no-op check key (O3) ------------------------------------------------------------------------
// The no-op check compares canonical(memory) with canonical(candidate). canonical() is a one-to-one
// encoding with sorted keys, so it can be split exactly into two parts:
//   rest = canonical(store without meta.dataRevision and meta.updatedAt)
//   bump = canonical({ the present ones of those two fields })
// canonical(A) === canonical(B)  ⇔  rest(A) === rest(B) && bump(A) === bump(B).
// The revision bump changes ONLY those two fields, so after an apply write the new memory's `rest`
// is the candidate's `rest` computed before the bump, and the next commit can reuse it (memoryKey).
const BUMP_FIELDS = Object.freeze(['dataRevision', 'updatedAt']);
const isPlainObj = (v) => isObj(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
/** The split is used only where it is provably exact: plain root and meta, no symbol keys on either. */
const splittable = (s) => isPlainObj(s) && isPlainObj(s.meta) && Object.getOwnPropertySymbols(s).length === 0 && Object.getOwnPropertySymbols(s.meta).length === 0;
const bumpText = (meta) => canonicalOrNull(Object.fromEntries(BUMP_FIELDS.filter((k) => Object.hasOwn(meta, k)).map((k) => [k, meta[k]])));
function restText(s) {
  const meta = { ...s.meta };
  for (const k of BUMP_FIELDS) delete meta[k];
  return canonicalOrNull({ ...s, meta });
}
/** { split, rest, bump } or null when the value is not canonicalizable. Not splittable → full text in `rest`. */
function noOpKey(s) {
  if (!splittable(s)) {
    const full = canonicalOrNull(s);
    return full === null ? null : { split: false, rest: full, bump: '' };
  }
  const rest = restText(s);
  const bump = bumpText(s.meta);
  return rest === null || bump === null ? null : { split: true, rest, bump };
}

/**
 * Is `storedRaw` a meaningful change relative to `baselineRaw`?
 * Byte-identical (incl. both null) → no. Exactly one null → yes. Unparseable or
 * non-canonicalizable → yes (never ignored). Canonical JSON differs → yes. Formatting only → no.
 */
function isMeaningfulChange(baselineRaw, storedRaw) {
  if (baselineRaw === storedRaw) return false;
  if (baselineRaw === null || storedRaw === null) return true;
  let a;
  let b;
  try {
    a = JSON.parse(baselineRaw);
    b = JSON.parse(storedRaw);
  } catch {
    return true;
  }
  const ca = canonicalOrNull(a);
  const cb = canonicalOrNull(b);
  if (ca === null || cb === null) return true;
  return ca !== cb;
}

const rejected = (code, extra = {}) => ({ ok: false, outcome: 'rejected', code, ...extra });

// ---- Step 2c.2 helpers -------------------------------------------------------------------------

/** Fields no ordinary write may change (R4-5). */
const PROTECTED_PATHS = Object.freeze([
  ['settings', 'lastBackupAt'],
  ['settings', 'lastBackupRevision'],
  ['settings', 'lastPartialBackupAt'],
  ['settings', 'lastPartialBackupRevision'],
  ['meta', 'onboarding', 'userVerifiedAt'],
]);
const atPath = (o, path) => path.reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o);
const protectedChanges = (before, after) => PROTECTED_PATHS.filter((p) => !Object.is(atPath(before, p), atPath(after, p))).map((p) => p.join('.'));
const protectedNotNull = (s) => PROTECTED_PATHS.filter((p) => atPath(s, p) !== null).map((p) => p.join('.'));

/** meta.onboarding of a fresh store: the only value a rebuild candidate may carry. */
const DEFAULT_ONBOARDING_CANONICAL = canonicalize(createEmptyStore().meta.onboarding);

const importLogOf = (s) => (Array.isArray(s?.meta?.importLog) ? s.meta.importLog : []);
const pendingEntries = (s) => importLogOf(s).filter((e) => isObj(e) && e.status === 'pending');
const hasPendingImport = (s) => pendingEntries(s).length > 0;

const V1_IMPORT_KINDS = ['v1_migration', 'v1_late_import'];
const lateInvalid = (message) => rejected('LATE_IMPORT_INVALID', { message });
const unique = (list) => new Set(list).size === list.length;

/**
 * Structural checks of late-import additions against the current store (remediation A, Store.appendLateImport).
 * Returns a message, or null when every addition and relationship is consistent. validateStore and
 * checkTransition run afterwards on the complete candidate.
 */
function lateImportProblem(store, a) {
  if (!isObj(a) || !Array.isArray(a.exercises) || !Array.isArray(a.sessions) || !Array.isArray(a.quarantine) || !isObj(a.entry)) return 'additions must be { exercises[], sessions[], quarantine[], entry }';
  const e = a.entry;
  const log = importLogOf(store);
  if (e.kind !== 'v1_late_import' || e.status !== 'pending') return 'the entry must be a pending v1_late_import entry';
  if (typeof e.importId !== 'string' || !e.importId.startsWith('imp_')) return 'invalid importId';
  if (log.some((x) => x.importId === e.importId || x.restoreId === e.importId)) return 'importId is already used';
  if (typeof e.sourceSha256 !== 'string' || !HEX64.test(e.sourceSha256)) return 'invalid sourceSha256';
  if (log.some((x) => V1_IMPORT_KINDS.includes(x.kind) && x.sourceSha256 === e.sourceSha256)) return 'this source was already imported';
  if (a.sessions.length === 0 && a.quarantine.length === 0) return 'nothing to import';

  const sessionIds = new Set(store.sessions.map((s) => s.id));
  const ids = a.sessions.map((s) => s?.id);
  if (!unique(ids)) return 'duplicate session id in the additions';
  for (const s of a.sessions) {
    if (!isObj(s) || typeof s.id !== 'string' || sessionIds.has(s.id)) return `session ${s?.id} must be new`;
    if (s.origin !== 'v1_late_import') return `session ${s.id} must have origin v1_late_import`;
    if (!isObj(s.provenance) || s.provenance.importId !== e.importId) return `session ${s.id} provenance.importId must be ${e.importId}`;
    if (s.provenance.snapshotSha256 !== e.sourceSha256) return `session ${s.id} provenance.snapshotSha256 must equal the entry's sourceSha256`;
    if (!Array.isArray(s.performances)) return `session ${s.id} has no performances list`;
  }

  const used = new Set(a.sessions.flatMap((s) => s.performances.map((p) => p?.exerciseId)));
  const current = new Map(store.exercises.map((x) => [x.id, x]));
  if (!unique(a.exercises.map((x) => x?.id))) return 'duplicate exercise id in the additions';
  for (const x of a.exercises) {
    if (!isObj(x) || typeof x.id !== 'string' || !(x.id.startsWith('ex_v1u_') || x.id.startsWith('ex_v1c_'))) return `exercise ${x?.id} is not an imported exercise`;
    if (!used.has(x.id)) return `exercise ${x.id} is not used by the imported sessions`;
    if (current.has(x.id) && canonicalize(current.get(x.id)) !== canonicalize(x)) return `exercise ${x.id} differs from the existing exercise with that id`;
  }

  const qIds = new Set(store.quarantine.map((q) => q.id));
  if (!unique(a.quarantine.map((q) => q?.id))) return 'duplicate quarantine id in the additions';
  for (const q of a.quarantine) {
    if (!isObj(q) || typeof q.id !== 'string' || qIds.has(q.id)) return `quarantine entry ${q?.id} must be new`;
    if (q.importId !== e.importId) return `quarantine entry ${q.id} must belong to ${e.importId}`;
    if (!QUARANTINE_REASONS.import.includes(q.reason)) return `quarantine entry ${q.id} must have an import reason`;
  }

  const perfs = a.sessions.reduce((n, s) => n + s.performances.length, 0);
  const sets = a.sessions.reduce((n, s) => n + s.performances.reduce((m, p) => m + (Array.isArray(p?.sets) ? p.sets.length : 0), 0), 0);
  const c = e.counts;
  if (!isObj(c) || c.sessions !== a.sessions.length || c.performances !== perfs || c.sets !== sets || c.quarantined !== a.quarantine.length) return 'entry.counts do not match the additions';
  const unresolved = [...used].filter((id) => typeof id === 'string' && id.startsWith('ex_v1u_'));
  if (!Array.isArray(e.unresolvedExercises) || !unique(e.unresolvedExercises) || e.unresolvedExercises.length !== unresolved.length || !unresolved.every((id) => e.unresolvedExercises.includes(id))) {
    return 'entry.unresolvedExercises does not match the imported sessions';
  }
  return null;
}

/**
 * Structural checks of CSV-import additions (Step 2f, Store.appendCsvImport): only new csv_import
 * sessions of one new entry, no Garmin activity twice, no file twice, only its own unresolved exercises,
 * only set-aside quarantine entries. validateStore and checkTransition run afterwards on the candidate.
 */
function csvImportProblem(store, a) {
  if (!isObj(a) || !Array.isArray(a.exercises) || !Array.isArray(a.sessions) || !Array.isArray(a.quarantine) || !isObj(a.entry)) return 'additions must be { exercises[], sessions[], quarantine[], entry }';
  const e = a.entry;
  const log = importLogOf(store);
  if (e.kind !== 'csv_import' || e.status !== 'pending') return 'the entry must be a pending csv_import entry';
  if (typeof e.importId !== 'string' || !e.importId.startsWith('imp_')) return 'invalid importId';
  if (log.some((x) => x.importId === e.importId || x.restoreId === e.importId)) return 'importId is already used';
  if (typeof e.sourceSha256 !== 'string' || !HEX64.test(e.sourceSha256) || typeof e.packageSha256 !== 'string' || !HEX64.test(e.packageSha256)) return 'invalid sourceSha256 / packageSha256';
  if (log.some((x) => x.kind === 'csv_import' && x.sourceSha256 === e.sourceSha256)) return 'this file was already imported';
  if (a.sessions.length === 0 && a.quarantine.length === 0) return 'nothing to import';
  const sessionIds = new Set(store.sessions.map((x) => x.id));
  const fingerprints = new Set(store.sessions.filter((x) => x.origin === 'csv_import').map((x) => x.provenance.fingerprint));
  if (!unique(a.sessions.map((x) => x?.id))) return 'duplicate session id in the additions';
  if (!unique(a.sessions.map((x) => x?.provenance?.fingerprint))) return 'the same activity twice in the additions';
  for (const x of a.sessions) {
    if (!isObj(x) || typeof x.id !== 'string' || sessionIds.has(x.id)) return `session ${x?.id} must be new`;
    if (x.origin !== 'csv_import') return `session ${x.id} must have origin csv_import`;
    const pv = x.provenance;
    if (!isObj(pv) || pv.importId !== e.importId || pv.fileSha256 !== e.sourceSha256 || pv.packageSha256 !== e.packageSha256) return `session ${x.id} provenance must match its entry`;
    if (fingerprints.has(pv.fingerprint)) return `activity ${pv.fingerprint} was already imported`;
    if (!Array.isArray(x.performances)) return `session ${x.id} has no performances list`;
  }
  const used = new Set(a.sessions.flatMap((x) => x.performances.map((p) => p?.exerciseId)));
  const current = new Map(store.exercises.map((x) => [x.id, x]));
  if (!unique(a.exercises.map((x) => x?.id))) return 'duplicate exercise id in the additions';
  for (const x of a.exercises) {
    const unresolvedOk = isObj(x) && typeof x.id === 'string' && x.id.startsWith('ex_csvu_') && x.measurement?.type === 'unresolved';
    // accepted under its Garmin name: a normal custom exercise (weight/reps, bodyweight + load, bodyweight reps or duration)
    const acceptedOk = isObj(x) && typeof x.id === 'string' && x.id.startsWith('ex_csvn_') && isObj(x.measurement) && ['weight_reps', 'bodyweight_plus_load', 'bodyweight_reps', 'duration'].includes(x.measurement.type) && x.isCustom === true && x.archived === false && x.mergedInto === null && typeof x.name === 'string' && x.name !== '';
    // the two fixed activity exercises the importer maps Pool Swim / HIIT activities to (ids are fixed so they match the ones on the sync server)
    const activityOk = isObj(x) && isObj(x.measurement) && x.isCustom === true && x.archived === false && x.mergedInto === null && typeof x.name === 'string' && x.name !== ''
      && ((x.id === 'ex_hiit' && x.measurement.type === 'duration') || (x.id === 'ex_swim_freestyle' && x.measurement.type === 'distance_duration'));
    if (!unresolvedOk && !acceptedOk && !activityOk) return `exercise ${x?.id} is not an exercise created by the import`;
    if (!used.has(x.id)) return `exercise ${x.id} is not used by the imported sessions`;
    if (current.has(x.id)) return `exercise ${x.id} already exists`;
  }
  const qIds = new Set(store.quarantine.map((q) => q.id));
  if (!unique(a.quarantine.map((q) => q?.id))) return 'duplicate quarantine id in the additions';
  for (const q of a.quarantine) {
    if (!isObj(q) || typeof q.id !== 'string' || qIds.has(q.id)) return `quarantine entry ${q?.id} must be new`;
    if (q.importId !== e.importId || q.reason !== 'user_quarantined_import') return `quarantine entry ${q.id} must be a set-aside entry of ${e.importId}`;
  }
  const perfs = a.sessions.reduce((n, x) => n + x.performances.length, 0);
  const sets = a.sessions.reduce((n, x) => n + x.performances.reduce((m, p) => m + (Array.isArray(p?.sets) ? p.sets.length : 0), 0), 0);
  const c = e.counts;
  if (!isObj(c) || c.sessions !== a.sessions.length || c.performances !== perfs || c.sets !== sets || c.quarantined !== a.quarantine.length) return 'entry.counts do not match the additions';
  const unresolved = [...used].filter((id) => typeof id === 'string' && (current.get(id) ?? a.exercises.find((x) => x.id === id))?.measurement?.type === 'unresolved');
  if (!Array.isArray(e.unresolvedExercises) || !unique(e.unresolvedExercises) || e.unresolvedExercises.length !== unresolved.length || !unresolved.every((id) => e.unresolvedExercises.includes(id))) {
    return 'entry.unresolvedExercises does not match the imported sessions';
  }
  return null;
}

/**
 * @param {object} deps
 * @param {Storage} [deps.backend] Web Storage-compatible backend (defaults inside storage.js).
 * @param {() => string} deps.now injected clock returning an ISO timestamp.
 */
export function createStore({ backend, now, newOpId = () => `op_${randomUuid()}` } = {}) {
  if (typeof now !== 'function') throw new TypeError('createStore requires an injected clock: now()');
  const storage = createStorage(backend);

  let status = 'unloaded'; // unloaded | absent | ok | invalid | unavailable
  let memory = null;
  let changeSeq = 0; // bumped by setMemory on every memory replacement (read-API cache key, Step 2d.0)
  let baseline = null; // last loaded/written text; for an invalid store, its stored text
  let invalidRaw = null;
  let unsaved = false;
  let saveError = null;
  let stale = false;
  // { obj, rest }: the no-op `rest` text of the memory object `obj` (O3). Valid only while
  // obj === memory; set only by validateAndPersist, dropped by setMemory for any other object.
  let memoryKey = null;

  /** The ONLY place that replaces `memory` (static test S6). Memory objects are never mutated in place. */
  function setMemory(next) {
    if (next === memory) return; // e.g. retrySave writes the same object again: no change
    if (memoryKey !== null && memoryKey.obj !== next) memoryKey = null;
    memory = next;
    changeSeq += 1;
  }

  // ---- queue -------------------------------------------------------------------------------
  let tail = Promise.resolve();
  function enqueue(op) {
    const p = tail.then(() => op());
    tail = p.catch(() => {});
    return p;
  }

  // ---- shared preconditions --------------------------------------------------------------------
  /** Refusal for a write on the current state, or null when writing is allowed. */
  function writeBlocked() {
    if (stale) return rejected('EXTERNAL_CHANGE');
    if (status === 'ok') return null;
    return rejected(
      {
        unloaded: 'STORE_NOT_LOADED',
        absent: 'STORE_ABSENT',
        invalid: 'INVALID_STORE',
        unavailable: 'STORE_UNAVAILABLE',
      }[status],
    );
  }

  /** writeBlocked plus the pending lock (R2-2), for every user write. */
  function userWriteBlocked() {
    return writeBlocked() ?? (hasPendingImport(memory) ? rejected('IMPORT_PENDING') : null);
  }

  // ---- persist: the single synchronous check-and-write block ---------------------------------
  // mode: 'initialize' | 'apply' (commit and bookkeeping) | 'retry' | 'strict' (replaceStore,
  // markImportVerified, rebuildPendingMigration: memory changes only after a successful write).
  // Contains no await.
  function persist(candidate, mode) {
    if (stale) return rejected('EXTERNAL_CHANGE');

    let stored;
    try {
      stored = storage.get(KEY);
    } catch (err) {
      if (!(err instanceof StorageReadError)) throw err;
      if (mode === 'strict') return rejected('STORAGE_READ_FAILED', { kind: err.kind });
      saveError = { phase: 'read', kind: err.kind, at: now() };
      if (mode !== 'retry') {
        setMemory(candidate);
        if (mode === 'initialize') status = 'ok';
      }
      unsaved = true;
      return { ok: false, outcome: 'unsaved', code: 'STORAGE_READ_FAILED', saveError: { ...saveError } };
    }

    // A strict write over an INVALID store compares bytes: the caller proved the exact stored text
    // (expected.invalidSha256), so even a formatting-only external change counts.
    const changed = mode === 'strict' && status === 'invalid' ? stored !== baseline : isMeaningfulChange(baseline, stored);
    if (changed) {
      if (mode === 'initialize' || (mode === 'strict' && status === 'absent')) return rejected('STORE_EXISTS');
      stale = true;
      return rejected('EXTERNAL_CHANGE');
    }

    const raw = JSON.stringify(candidate);
    if (mode === 'strict') {
      try {
        storage.set(KEY, raw);
      } catch (err) {
        if (!(err instanceof StorageWriteError)) throw err;
        return rejected('STORAGE_WRITE_FAILED', { kind: err.kind });
      }
      setMemory(candidate);
      status = 'ok';
      invalidRaw = null;
      baseline = raw;
      unsaved = false;
      saveError = null;
      return { ok: true, outcome: 'saved' };
    }

    setMemory(candidate);
    if (mode === 'initialize') status = 'ok';
    try {
      storage.set(KEY, raw);
    } catch (err) {
      if (!(err instanceof StorageWriteError)) throw err;
      unsaved = true;
      saveError = { phase: 'write', kind: err.kind, at: now() };
      return { ok: false, outcome: 'unsaved', code: 'STORAGE_WRITE_FAILED', saveError: { ...saveError } };
    }
    baseline = raw;
    unsaved = false;
    saveError = null;
    return { ok: true, outcome: 'saved' };
  }

  /** Shared tail of commit and bookkeeping: no-op check, validation, persist. */
  async function validateAndPersist(next, { bumpRevision, stamp = true }) {
    // No-op check (O3): exactly `canonical(next) === canonical(memory)`, with memory's `rest` reused
    // from the previous write when memory is still that object (see noOpKey).
    const after = noOpKey(next);
    if (after === null) return rejected('RESULT_INVALID', { errors: [{ code: 'INV-SHAPE', path: '$', message: 'store is not canonicalizable JSON' }] });
    const before = memoryKey !== null && memoryKey.obj === memory ? { split: true, rest: memoryKey.rest, bump: bumpText(memory.meta) } : noOpKey(memory);
    const same = before !== null && before.split === after.split
      ? before.rest === after.rest && before.bump === after.bump
      : canonicalOrNull(memory) === canonicalOrNull(next); // mixed split (never for valid stores): full texts
    if (same) return { ok: true, outcome: 'unchanged' };
    // Sync outbox (src/sync/local.js): ops for every changed synchronized entity are added to the SAME
    // candidate, so they are written by the same single storage write as the data (or not at all).
    const opsBefore = next.sync?.outbox?.length ?? 0;
    if (stamp) stampOutbox(memory, next, { now, newOpId });
    const afterKey = (next.sync?.outbox?.length ?? 0) !== opsBefore ? noOpKey(next) : after;
    if (bumpRevision && isObj(next.meta)) {
      next.meta.dataRevision = memory.meta.dataRevision + 1;
      next.meta.updatedAt = now();
    }
    const v = await validateStore(next);
    if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });
    const result = persist(next, 'apply');
    // The bump above changed only BUMP_FIELDS; validateStore and persist do not modify `next`.
    if (memory === next && afterKey?.split) memoryKey = { obj: next, rest: afterKey.rest };
    return result;
  }

  // ---- load / reload -------------------------------------------------------------------------
  async function loadBody() {
    setMemory(null);
    baseline = null;
    invalidRaw = null;
    unsaved = false;
    saveError = null;
    stale = false;
    let raw;
    try {
      raw = storage.get(KEY);
    } catch (err) {
      if (!(err instanceof StorageReadError)) throw err;
      status = 'unavailable';
      return { ok: false, status, code: 'STORE_UNAVAILABLE' };
    }
    if (raw === null) {
      status = 'absent';
      return { ok: true, status };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      status = 'invalid';
      invalidRaw = raw;
      baseline = raw;
      return { ok: false, status, code: 'INVALID_STORE', errors: [{ code: 'INV-SHAPE', path: '$', message: 'stored text is not valid JSON' }] };
    }
    const v = await validateStore(parsed);
    if (!v.valid) {
      status = 'invalid';
      invalidRaw = raw;
      baseline = raw;
      return { ok: false, status, code: 'INVALID_STORE', errors: v.errors };
    }
    status = 'ok';
    setMemory(parsed);
    baseline = raw;
    return { ok: true, status, revision: memory.meta.dataRevision };
  }

  /**
   * Initial load only. Allowed before the first load and again after `unavailable` (a read failure
   * can be retried). After a completed load (absent, invalid or ok) it is refused; use reload().
   */
  function load() {
    return enqueue(async () => {
      if (status !== 'unloaded' && status !== 'unavailable') return rejected('STORE_ALREADY_LOADED');
      return loadBody();
    });
  }

  /** The only operation that re-reads storage into memory. Unsaved changes need discardUnsaved: true. */
  function reload({ discardUnsaved = false } = {}) {
    return enqueue(async () => {
      if (unsaved && discardUnsaved !== true) return rejected('UNSAVED_STATE');
      return loadBody();
    });
  }

  // ---- writes --------------------------------------------------------------------------------
  /** Writes a validated initial store; only when the key is absent. */
  function initialize(initialStore) {
    return enqueue(async () => {
      if (stale) return rejected('EXTERNAL_CHANGE');
      if (memory !== null) return rejected('STORE_ALREADY_LOADED');
      if (status !== 'absent') return writeBlocked();
      const candidate = structuredClone(initialStore);
      const v = await validateStore(candidate);
      if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });
      const prot = protectedNotNull(candidate);
      if (prot.length) return rejected('PROTECTED_FIELD', { fields: prot });
      return persist(candidate, 'initialize');
    });
  }

  /** User-data change. fn(copy) returns the next store (or a promise of it). */
  function commit(fn) {
    if (typeof fn !== 'function') throw new TypeError('commit(fn) requires a function');
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      const next = await fn(structuredClone(memory));
      if (!isObj(next)) throw new TypeError('commit fn must return the next store object');
      const candidate = structuredClone(next);
      const changedProtected = protectedChanges(memory, candidate);
      if (changedProtected.length) return rejected('PROTECTED_FIELD', { fields: changedProtected });
      // The sync section is written only by the Store (outbox stamping) and applySync, never by a domain change.
      if (canonicalOrNull(memory.sync ?? null) !== canonicalOrNull(candidate.sync ?? null)) return rejected('PROTECTED_FIELD', { fields: ['sync'] });
      // Step 2b.6: transition rules against the previous store (TR-P1b/e, PP6/QM/QV, edit conflict, cancel, save-as-new).
      const tr = checkTransition(memory, candidate);
      if (tr) return rejected(tr.code, { message: tr.message });
      return validateAndPersist(candidate, { bumpRevision: true });
    });
  }

  /**
   * Deletes one saved workout (explicit user action). The only write allowed to remove a saved session; the
   * transition rules still protect unresolved performances, and the workout being edited cannot be deleted.
   * Manual-record links into the deleted workout are cleared (INV-RSR). The deletion is stamped like any other
   * change, so it reaches the other devices as a tombstone and a stale device cannot bring it back.
   */
  function deleteSession(sessionId, { confirmImported = false } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('deleteSession requires a session id');
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      const target = memory.sessions.find((x) => x.id === sessionId);
      if (!target) return rejected('NOT_FOUND', { sessionId });
      if (memory.activeSession?.editsSessionId === sessionId) return rejected('SESSION_IN_EDIT', { sessionId });
      if (target.origin !== 'app' && confirmImported !== true) return rejected('CONFIRMATION_REQUIRED', { reason: 'imported_session' });
      const candidate = structuredClone(memory);
      candidate.sessions = candidate.sessions.filter((x) => x.id !== sessionId);
      for (const r of candidate.manualRecords) if (r.relatedSetRef?.sessionId === sessionId) r.relatedSetRef = null;
      const tr = checkTransition(memory, candidate, { deleteSessionId: sessionId });
      if (tr) return rejected(tr.code, { message: tr.message });
      return validateAndPersist(candidate, { bumpRevision: true });
    });
  }

  /**
   * Sync: the only writer of the `sync` section besides outbox stamping. fn(draft, { now, newOpId })
   * mutates a copy and returns { dataChanged, stamp?, refusal? }. Pulled data is not re-stamped as local ops
   * (stamp false) and bumps the data revision only when synchronized data changed; the active workout is
   * never touched. Refused while an import is pending (userWriteBlocked) or when sync is not enabled.
   */
  function applySync(fn) {
    if (typeof fn !== 'function') throw new TypeError('applySync(fn) requires a function');
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      if (!isObj(memory.sync)) return rejected('SYNC_NOT_ENABLED');
      const draft = structuredClone(memory);
      const r = fn(draft, { now: now(), newOpId }) ?? {};
      if (r.refusal) return r.refusal;
      if (canonicalOrNull(memory.activeSession) !== canonicalOrNull(draft.activeSession)) return rejected('PROTECTED_FIELD', { fields: ['activeSession'] });
      return validateAndPersist(draft, { bumpRevision: r.dataChanged === true, stamp: r.stamp === true });
    });
  }

  /** Sync: creates the device-local sync section (once). The data is untouched; reconciliation follows. */
  function enableSync(section) {
    if (!isObj(section)) throw new TypeError('enableSync requires a sync section');
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      if (isObj(memory.sync)) return rejected('SYNC_ALREADY_ENABLED');
      const draft = structuredClone(memory);
      draft.sync = structuredClone(section);
      return validateAndPersist(draft, { bumpRevision: false, stamp: false });
    });
  }

  /** Writes the current in-memory state again after a failed write, under the same checks. */
  function retrySave() {
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      if (!unsaved) return rejected('NO_UNSAVED_CHANGES');
      return persist(memory, 'retry');
    });
  }

  function bookkeeping(apply) {
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      const draft = structuredClone(memory);
      const refusal = apply(draft);
      if (refusal) return refusal;
      return validateAndPersist(draft, { bumpRevision: false });
    });
  }

  /**
   * Records a completed backup of the current, fully saved revision. No revision change.
   * complete: true → only lastBackupAt/lastBackupRevision; false → only the partial pair.
   */
  function recordBackup({ revision, at, complete } = {}) {
    return bookkeeping((draft) => {
      if (typeof complete !== 'boolean') {
        return rejected('RESULT_INVALID', { errors: [{ code: 'INV-SHAPE', path: '$complete', message: 'complete must be true or false' }] });
      }
      if (unsaved) return rejected('UNSAVED_STATE');
      if (revision !== draft.meta.dataRevision) return rejected('BACKUP_REVISION_MISMATCH');
      if (complete) {
        draft.settings.lastBackupAt = at;
        draft.settings.lastBackupRevision = revision;
      } else {
        draft.settings.lastPartialBackupAt = at;
        draft.settings.lastPartialBackupRevision = revision;
      }
      return null;
    });
  }

  /**
   * Patches meta.onboarding (personalSeed, checks.*, userVerifiedAt). No revision change.
   * A new non-null userVerifiedAt requires a current COMPLETE backup (BACKUP_REQUIRED).
   */
  function updateOnboarding(patch) {
    return bookkeeping((draft) => {
      if (!isObj(patch)) return rejected('RESULT_INVALID', { errors: [{ code: 'INV-SHAPE', path: '$patch', message: 'patch must be an object' }] });
      const errors = [];
      for (const k of Object.keys(patch)) {
        if (!F.onboarding.includes(k)) errors.push({ code: 'INV-SHAPE', path: `$patch.${k}`, message: 'unknown onboarding field' });
      }
      if ('checks' in patch) {
        if (!isObj(patch.checks)) errors.push({ code: 'INV-SHAPE', path: '$patch.checks', message: 'must be an object' });
        else for (const k of Object.keys(patch.checks)) {
          if (!F.onboardingChecks.includes(k)) errors.push({ code: 'INV-SHAPE', path: `$patch.checks.${k}`, message: 'unknown onboarding check' });
        }
      }
      if (errors.length) return rejected('RESULT_INVALID', { errors });
      const ob = draft.meta.onboarding;
      if ('userVerifiedAt' in patch && patch.userVerifiedAt !== null && patch.userVerifiedAt !== ob.userVerifiedAt) {
        const st = draft.settings;
        if (st.lastBackupAt === null || st.lastBackupRevision !== draft.meta.dataRevision) return rejected('BACKUP_REQUIRED');
      }
      if ('personalSeed' in patch) ob.personalSeed = patch.personalSeed;
      if ('userVerifiedAt' in patch) ob.userVerifiedAt = patch.userVerifiedAt;
      if ('checks' in patch) Object.assign(ob.checks, patch.checks);
      return null;
    });
  }

  /** Sets reportSeenAt on one import-log entry. No revision change. */
  function markImportReportSeen(importId, at) {
    return bookkeeping((draft) => {
      const entry = draft.meta.importLog.find((e) => e.importId === importId);
      if (!entry) return rejected('NOT_FOUND');
      entry.reportSeenAt = at;
      return null;
    });
  }

  // ---- Step 2c.2: import verification, restore, migration rebuild --------------------------------

  /**
   * Marks a pending import `verified` (bookkeeping: no revision change). Before writing it re-reads
   * gymlog.v2 from storage and requires: the stored text equals the last written text exactly;
   * its canonical form equals memory (and expectedCandidateSha256, when given); it validates.
   * The legacy-key check is the caller's (the Store never reads side keys).
   * @param {string} importId
   * @param {{expectedCandidateSha256?: string, sourceUnavailable?: boolean, candidateUnproven?: boolean}} [opts]
   */
  function markImportVerified(importId, { expectedCandidateSha256, sourceUnavailable = false, candidateUnproven = false } = {}) {
    if (expectedCandidateSha256 !== undefined && !HEX64.test(expectedCandidateSha256)) throw new TypeError('expectedCandidateSha256 must be 64 hex characters');
    return enqueue(async () => {
      const blocked = writeBlocked();
      if (blocked) return blocked;
      if (unsaved) return rejected('UNSAVED_STATE');
      const index = memory.meta.importLog.findIndex((e) => e.importId === importId);
      if (index < 0) return rejected('NOT_FOUND');
      if (memory.meta.importLog[index].status !== 'pending') return rejected('IMPORT_NOT_PENDING');

      let stored;
      try {
        stored = storage.get(KEY);
      } catch (err) {
        if (!(err instanceof StorageReadError)) throw err;
        return rejected('STORAGE_READ_FAILED', { kind: err.kind });
      }
      if (stored !== baseline) {
        stale = true;
        return rejected('EXTERNAL_CHANGE');
      }
      let parsed;
      try {
        parsed = JSON.parse(stored);
      } catch {
        return rejected('RESULT_INVALID', { errors: [{ code: 'INV-SHAPE', path: '$', message: 'stored text is not valid JSON' }] });
      }
      const storedCanonical = canonicalOrNull(parsed);
      if (storedCanonical === null || storedCanonical !== canonicalOrNull(memory)) return rejected('CANDIDATE_MISMATCH', { reason: 'memory' });
      if (expectedCandidateSha256 !== undefined && (await sha256Hex(canonicalOrNull((({ sync, ...rest }) => rest)(parsed)))) !== expectedCandidateSha256) { // the candidate never contains device-local sync state
        return rejected('CANDIDATE_MISMATCH', { reason: 'expected' });
      }
      const v = await validateStore(parsed);
      if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });

      const next = structuredClone(memory);
      const entry = next.meta.importLog[index];
      entry.status = 'verified';
      if (sourceUnavailable === true) entry.warnings.push({ code: 'SOURCE_SNAPSHOT_UNAVAILABLE', ref: entry.sourceSha256 });
      if (candidateUnproven === true) entry.warnings.push({ code: 'IMPORT_CANDIDATE_UNPROVEN', ref: entry.importId });
      // The import's entities become eligible for sync only now (pending imports are never synchronized).
      reconcileOutbox(next, { now, newOpId });
      const v2 = await validateStore(next);
      if (!v2.valid) return rejected('RESULT_INVALID', { errors: v2.errors });
      return persist(next, 'strict');
    });
  }

  /**
   * Restore only: replaces the whole store with a verified backup's data plus exactly one new
   * pending backup_restore entry.
   * @param {object} next
   * `expected` must describe exactly the state the proven export was taken from:
   *   absent → { absent: true }; ok → { revision, storeSha256 } (canonical SHA-256 of the whole
   *   current store, so bookkeeping changes that do not bump the revision are caught too);
   *   invalid → { invalidSha256 } (SHA-256 of the exact stored text; the write then also requires
   *   the stored text to be byte-identical).
   * @param {{expected: {absent:true} | {revision:number, storeSha256:string} | {invalidSha256:string},
   *          discardUnsaved?: boolean, overwriteInvalid?: boolean}} opts
   */
  function replaceStore(next, { expected, discardUnsaved = false, overwriteInvalid = false } = {}) {
    if (!isObj(expected)) throw new TypeError('replaceStore requires { expected }');
    return enqueue(async () => {
      if (stale) return rejected('EXTERNAL_CHANGE');
      let currentLog = [];
      if (status === 'absent') {
        if (expected.absent !== true) return rejected('CONFLICT');
      } else if (status === 'ok') {
        if (expected.revision !== memory.meta.dataRevision) return rejected('CONFLICT');
        if (typeof expected.storeSha256 !== 'string' || expected.storeSha256 !== (await sha256Hex(canonicalize(memory)))) return rejected('CONFLICT');
        if (hasPendingImport(memory)) return rejected('IMPORT_PENDING');
        if (unsaved && discardUnsaved !== true) return rejected('UNSAVED_STATE');
        currentLog = memory.meta.importLog;
      } else if (status === 'invalid') {
        if (overwriteInvalid !== true) return rejected('INVALID_STORE');
        if (expected.invalidSha256 !== (await sha256Hex(invalidRaw))) return rejected('CONFLICT');
      } else {
        return writeBlocked();
      }

      const candidate = structuredClone(next);
      // Sync state belongs to the device, never to a backup: a restore keeps this device's identity, drops every
      // pending op and known version (they describe the replaced data) and requires a reconciliation with the
      // server before anything is sent. Unresolved conflict artifacts are carried over.
      delete candidate.sync;
      if (status === 'ok' && isObj(memory.sync)) {
        candidate.sync = emptySyncSection({ deviceId: memory.sync.deviceId, epoch: memory.sync.epoch, store: candidate, state: 'reconcile' });
        candidate.sync.opCounter = memory.sync.opCounter;
        candidate.sync.conflicts = structuredClone(memory.sync.conflicts);
      }
      const v = await validateStore(candidate);
      if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });

      const pend = pendingEntries(candidate);
      const knownRestoreIds = new Set(currentLog.filter((e) => e.kind === 'backup_restore').map((e) => e.restoreId));
      if (pend.length !== 1 || pend[0].kind !== 'backup_restore' || knownRestoreIds.has(pend[0].restoreId)) {
        return rejected('RESULT_INVALID', { errors: [{ code: 'RESTORE_ENTRY', path: '$.meta.importLog', message: 'exactly one new pending backup_restore entry is required' }] });
      }
      if (status === 'ok' && !(candidate.meta.dataRevision > memory.meta.dataRevision)) {
        return rejected('RESULT_INVALID', { errors: [{ code: 'INV-REV', path: '$.meta.dataRevision', message: 'must be greater than the current revision' }] });
      }
      return persist(candidate, 'strict');
    });
  }

  /**
   * The ONLY write that may add an import-log entry outside the first migration and restore (remediation A).
   * Late import (Step 2c.6): takes plain data — never a function — and builds the candidate itself from
   * the current store plus appends. Every addition and every relationship between them is checked here;
   * the transition authorization for the imported history is created inside this method from the checked
   * additions and is not something a caller can pass. Persistence is strict: memory changes only after a
   * successful write, so a refused or failed import leaves memory and storage unchanged.
   * Called only by bootstrap's applyLateImport workflow (static test GATE-S5).
   * @param {{exercises:object[], sessions:object[], quarantine:object[], entry:object}} additions
   */
  function appendLateImport(additions) {
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      if (unsaved) return rejected('UNSAVED_STATE');
      let a;
      try {
        a = structuredClone(additions);
      } catch {
        return lateInvalid('additions must be plain data');
      }
      const problem = lateImportProblem(memory, a);
      if (problem) return lateInvalid(problem);

      const candidate = structuredClone(memory);
      const existing = new Map(candidate.exercises.map((e) => [e.id, e]));
      for (const e of a.exercises) if (!existing.has(e.id)) candidate.exercises.push(e);
      candidate.sessions.push(...a.sessions);
      candidate.quarantine.push(...a.quarantine);
      candidate.meta.importLog.push(a.entry);
      candidate.meta.dataRevision = memory.meta.dataRevision + 1;
      candidate.meta.updatedAt = now();

      const v = await validateStore(candidate);
      if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });
      const auth = { lateImport: { entry: a.entry, sessionIds: new Set(a.sessions.map((x) => x.id)), quarantineIds: new Set(a.quarantine.map((x) => x.id)) } };
      const tr = checkTransition(memory, candidate, auth);
      if (tr) return rejected(tr.code, { message: tr.message });
      return persist(candidate, 'strict');
    });
  }

  /** Step 2f: the dedicated, checked write for a CSV import (same guarantees as appendLateImport). */
  function appendCsvImport(additions) {
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      if (unsaved) return rejected('UNSAVED_STATE');
      let a;
      try {
        a = structuredClone(additions);
      } catch {
        return rejected('CSV_IMPORT_INVALID', { message: 'additions must be plain data' });
      }
      const problem = csvImportProblem(memory, a);
      if (problem) return rejected('CSV_IMPORT_INVALID', { message: problem });
      const candidate = structuredClone(memory);
      candidate.exercises.push(...a.exercises);
      candidate.sessions.push(...a.sessions);
      candidate.quarantine.push(...a.quarantine);
      candidate.meta.importLog.push(a.entry);
      candidate.meta.dataRevision = memory.meta.dataRevision + 1;
      candidate.meta.updatedAt = now();
      const v = await validateStore(candidate);
      if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });
      // The import-append authorization of checkTransition (same shape as the late import's).
      const auth = { lateImport: { entry: a.entry, sessionIds: new Set(a.sessions.map((x) => x.id)), quarantineIds: new Set(a.quarantine.map((x) => x.id)) } };
      const tr = checkTransition(memory, candidate, auth);
      if (tr) return rejected(tr.code, { message: tr.message });
      return persist(candidate, 'strict');
    });
  }

  /**
   * Step 2f: the dedicated write for the personal-data file. Adds only: goals and manual records with
   * source "personal_seed" (new ids), prefill loads on existing resolved exercises, settings.bodyweight,
   * and its own pending import-log entry.
   */
  function appendPersonalSeed(additions) {
    return enqueue(async () => {
      const blocked = userWriteBlocked();
      if (blocked) return blocked;
      if (unsaved) return rejected('UNSAVED_STATE');
      let a;
      try {
        a = structuredClone(additions);
      } catch {
        return rejected('PERSONAL_IMPORT_INVALID', { message: 'additions must be plain data' });
      }
      const bad = (message) => rejected('PERSONAL_IMPORT_INVALID', { message });
      if (!isObj(a) || !Array.isArray(a.goals) || !Array.isArray(a.manualRecords) || !Array.isArray(a.prefills) || !isObj(a.entry) || typeof a.at !== 'string') return bad('invalid additions');
      const e = a.entry;
      const log = importLogOf(memory);
      if (e.kind !== 'personal_seed' || e.status !== 'pending' || typeof e.importId !== 'string' || !e.importId.startsWith('imp_')) return bad('the entry must be a pending personal_seed entry');
      if (log.some((x) => x.importId === e.importId || (x.kind === 'personal_seed' && x.sourceSha256 === e.sourceSha256))) return bad('this file was already imported');
      if (a.goals.some((g) => g?.source !== 'personal_seed' || memory.goals.some((x) => x.id === g.id))) return bad('goals must be new personal_seed goals');
      if (a.manualRecords.some((r) => r?.source !== 'personal_seed' || memory.manualRecords.some((x) => x.id === r.id))) return bad('records must be new personal_seed records');
      const candidate = structuredClone(memory);
      for (const pf of a.prefills) {
        const ex = candidate.exercises.find((x) => x.id === pf?.exerciseId);
        if (!ex || ex.measurement.type === 'unresolved') return bad(`prefill for ${pf?.exerciseId}: no such resolved exercise`);
        ex.prefill = { load: pf.load, source: 'personal_seed' };
        ex.updatedAt = a.at;
      }
      if (a.bodyweight !== null) candidate.settings.bodyweight = { value: a.bodyweight?.value, unit: a.bodyweight?.unit, confirmed: true, updatedAt: a.at };
      candidate.goals.push(...a.goals);
      candidate.manualRecords.push(...a.manualRecords);
      candidate.meta.importLog.push(e);
      candidate.meta.dataRevision = memory.meta.dataRevision + 1;
      candidate.meta.updatedAt = now();
      const v = await validateStore(candidate);
      if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });
      const auth = { lateImport: { entry: e, sessionIds: new Set(), quarantineIds: new Set() } };
      const tr = checkTransition(memory, candidate, auth);
      if (tr) return rejected(tr.code, { message: tr.message });
      return persist(candidate, 'strict');
    });
  }

  /**
   * Rebuilds a pending first migration from its exact reproduction (Revisions 3–5).
   * Allowed for an `invalid` store (guarded by the hash of its stored text) or an `ok` store whose
   * only import-log entry is the pending v1_migration named by the proof (guarded by its revision
   * and stored-text hash). The candidate must hash to proof.candidateSha256.
   * @param {object} candidate
   * @param {{proof: {importId:string, sourceSha256:string, candidateSha256:string},
   *          expected: {invalidSha256:string} | {revision:number, rawSha256:string}}} opts
   */
  function rebuildPendingMigration(candidate, { proof, expected } = {}) {
    if (!isObj(proof) || !isObj(expected)) throw new TypeError('rebuildPendingMigration requires { proof, expected }');
    return enqueue(async () => {
      if (stale) return rejected('EXTERNAL_CHANGE');
      if (status === 'invalid') {
        if (expected.invalidSha256 !== (await sha256Hex(invalidRaw))) return rejected('CONFLICT');
      } else if (status === 'ok') {
        const log = memory.meta.importLog;
        const onlyPendingMigration = log.length === 1 && log[0].kind === 'v1_migration' && log[0].status === 'pending' && log[0].importId === proof.importId;
        if (!onlyPendingMigration) return rejected('NOT_REBUILDABLE');
        if (unsaved) return rejected('UNSAVED_STATE');
        if (expected.revision !== memory.meta.dataRevision || expected.rawSha256 !== (await sha256Hex(baseline))) return rejected('CONFLICT');
      } else {
        return rejected('NOT_REBUILDABLE');
      }

      const c = structuredClone(candidate);
      const canonical = canonicalOrNull(c);
      if (canonical === null) return rejected('RESULT_INVALID', { errors: [{ code: 'INV-SHAPE', path: '$', message: 'candidate is not canonicalizable JSON' }] });
      if ((await sha256Hex(canonical)) !== proof.candidateSha256) return rejected('CANDIDATE_MISMATCH', { reason: 'proof' });

      const problems = [];
      const log = importLogOf(c);
      const e = log[0];
      if (!(log.length === 1 && e.kind === 'v1_migration' && e.status === 'pending' && e.importId === proof.importId && e.sourceSha256 === proof.sourceSha256)) {
        problems.push('exactly one pending v1_migration entry matching the proof is required');
      }
      if (!Array.isArray(c.sessions) || c.sessions.some((s) => s?.origin !== 'v1_migration')) problems.push('every session must have origin v1_migration');
      if (c.manualRecords?.length !== 0 || c.goals?.length !== 0) problems.push('a migration candidate has no manual records or goals');
      if (c.activeSession !== null && c.activeSession?.mode !== 'new') problems.push('a migration candidate can only hold a new-mode active session');
      const prot = protectedNotNull(c);
      if (prot.length) problems.push(`protected fields must be null: ${prot.join(', ')}`);
      // Everything a fresh first-migration candidate always satisfies (2c.2 review fixes).
      if (Array.isArray(c.sessions) && c.sessions.some((s) => s?.provenance?.importId !== proof.importId)) problems.push('every session must belong to the proof import');
      if (!Array.isArray(c.quarantine) || c.quarantine.some((q) => !QUARANTINE_REASONS.import.includes(q?.reason) || q?.importId !== proof.importId)) {
        problems.push('every quarantine entry must be a Q-IMPORT entry of the proof import');
      }
      if (e?.reportSeenAt !== null) problems.push('reportSeenAt must be null');
      if (canonicalOrNull(c.meta?.onboarding) !== DEFAULT_ONBOARDING_CANONICAL) problems.push('meta.onboarding must have its default values');
      if (!isObj(c.meta?.seedTombstones) || Object.keys(c.meta.seedTombstones).length !== 0) problems.push('meta.seedTombstones must be empty');
      if (c.meta?.dataRevision !== 1) problems.push('dataRevision must be 1');
      if (problems.length) return rejected('RESULT_INVALID', { errors: problems.map((message) => ({ code: 'REBUILD_CANDIDATE', path: '$', message })) });

      const v = await validateStore(c);
      if (!v.valid) return rejected('RESULT_INVALID', { errors: v.errors });
      return persist(c, 'strict');
    });
  }

  // ---- events and read-only access -----------------------------------------------------------
  /** Wire to window 'storage' events (2d). Marks the store stale on a meaningful external change. */
  function handleStorageEvent(e) {
    if (!e || (e.key !== null && e.key !== KEY)) return;
    if (memory === null) return;
    const newValue = e.key === null ? null : (e.newValue ?? null);
    if (isMeaningfulChange(baseline, newValue)) stale = true;
  }

  function getState() {
    return {
      status,
      unsaved,
      saveError: saveError ? { ...saveError } : null,
      stale,
      revision: memory ? memory.meta.dataRevision : null,
      seq: changeSeq,
    };
  }

  /** Export path for an INVALID stored state: the original stored text, untouched. */
  function rawForExport() {
    if (status !== 'invalid') return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, raw: invalidRaw };
  }

  /** Export path for the in-memory store, including changes not yet in storage (unsaved/stale). */
  function exportCurrentState() {
    if (memory === null) return { ok: false, code: writeBlocked()?.code ?? 'STORE_NOT_LOADED' };
    return { ok: true, store: structuredClone(memory), unsaved, stale, revision: memory.meta.dataRevision };
  }

  return {
    load,
    reload,
    initialize,
    commit,
    retrySave,
    deleteSession,
    applySync,
    enableSync,
    recordBackup,
    updateOnboarding,
    markImportReportSeen,
    markImportVerified,
    replaceStore,
    appendLateImport,
    appendCsvImport,
    appendPersonalSeed,
    rebuildPendingMigration,
    handleStorageEvent,
    getState,
    rawForExport,
    exportCurrentState,
  };
}
