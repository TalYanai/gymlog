// v1 → v2 mapping (Steps 2c.3–2c.4): exercises, custom types, sets, sessions, the draft,
// quarantine and reconciliation. Pure and deterministic: the only inputs are the prepared source,
// the existing store, importId and importedAt (Revision 4 §3). No clock reads, no randomness, no
// locale-dependent ordering; every ID is derived.
//
// Rules (approved Step 2c plan, revisions 1–7):
// - Catalog names map to the seeded exercise with that name; custom names to a deterministic custom
//   exercise (ex_v1c_<16 hex of sha256(name)>); everything else is `unresolved`.
// - A set is mapped with the v3/C rules only when its keys are exactly fieldsOfC(name). If ANY set of
//   an entry differs, the whole performance is unresolved and points to a dedicated exercise
//   ex_v1u_<16 hex of sha256(name \0 sorted keys)> (R4-4, R5 A2). Unknown names use sha256(name).
// - Unresolved sets keep every metric null, sourceRaw = the parsed set (structural, not textual) and
//   sourceContext. The exact bytes live only in the legacy snapshot.
// - Unit conversion: Run d km → m; other d m; t minutes → seconds (distance types) or seconds (time).
//   distanceM to 0.1 m, durationSec to whole seconds; an inexact conversion keeps sourceRaw.
// - 0 means "empty" → null + sourceRaw + V1_ZERO_AS_NULL (added load: V1_ADDED_LOAD_ZERO). NaN/null,
//   negative, non-numbers and fractional reps → null + sourceRaw + V1_BAD_VALUE.
// - Broken items (workout, entry, set) → quarantine `invalid_item` with the parsed value. Items with
//   a literal that can't be stored faithfully → quarantine with the exact source text (R6-2).
// - Reconciliation: source sets = mapped + unresolved + merged into notes + sets inside quarantined
//   items, or RECONCILIATION_FAILED.

import { sha256Hex, canonicalSha256 } from '../schema/canonical.js';
import { createExercise, createSession, createSet, snapshotMeasurement, emptyBodyweight } from '../schema/factories.js';
import { v1SessionId, v1DuplicateSessionId, v1NoIdSessionId, v1AltSessionId, derivedPerformanceId, derivedSetId, resolveCollision } from '../schema/ids.js';
import { isLocalDate } from '../schema/validate.js';
import { fieldsOfC, unitsOfC, isV1CatalogName, V1_CUSTOM_TYPES, V1_LABEL_MISMATCH_NAMES } from './v1-rules.js';
import { sourceSlice, countWorkoutSets } from './v1-source.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hex16 = async (s) => (await sha256Hex(s)).slice(0, 16);
const pad2 = (n) => String(n).padStart(2, '0');
const sameKeySet = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const SAFE_LEGACY_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Hebrew report text for a custom bodyweight exercise mapped to added load (Revision 3 §5). */
export const CBW_CHANGE_TEXT = (name) =>
  `תרגיל מותאם '${name}': ב-v3 חושבו שיא, 1RM משוער ונפח מהמשקל הנוסף בלבד. ב-v2 נשמר המשקל הנוסף כפי שהוזן; 1RM ונפח אינם מחושבים ללא משקל גוף נמדד. ערכי v3 הישנים אינם מועברים ואינם שקולים לערכים החדשים.`;

/** Evidence labels (Revision 4 §6). The report never claims compatibility for A or B. */
export const EVIDENCE_LABELS = Object.freeze({
  C: 'Converted using rules verified against v3.',
  B_or_C: "Converted using v3/C rules. If this file came from an earlier release, those rules weren't verified for it.",
  A: "Converted using v3/C rules where the fields matched exactly. The rules weren't verified for this release.",
});

/** v3 custom type → v2 measurement (R2-7 for bodyweight_reps is decided per exercise from the data). */
function customMeasurement(type, anyAddedLoad) {
  switch (type) {
    case 'weight_reps':
      return { type: 'weight_reps', loadBasis: 'total', loadUnit: 'kg', volumeFactor: null, repsBasis: null };
    case 'bodyweight_reps':
      return anyAddedLoad
        ? { type: 'bodyweight_plus_load', loadBasis: 'added', loadUnit: 'kg', volumeFactor: null, repsBasis: null }
        : { type: 'bodyweight_reps', loadBasis: null, loadUnit: null, volumeFactor: null, repsBasis: null };
    case 'time':
      return { type: 'duration', loadBasis: null, loadUnit: null, volumeFactor: null, repsBasis: null };
    case 'distance':
      return { type: 'distance_duration', loadBasis: null, loadUnit: null, volumeFactor: null, repsBasis: null };
    case 'other':
      return { type: 'note', loadBasis: null, loadUnit: null, volumeFactor: null, repsBasis: null };
    default:
      return null;
  }
}
const UNRESOLVED_MEASUREMENT = { type: 'unresolved', loadBasis: null, loadUnit: null, volumeFactor: null, repsBasis: null };

/** v3 field → v2 set field for a mapped exercise. */
const V2_FIELD = { w: 'load', r: 'reps', d: 'distanceM', t: 'durationSec' };

/**
 * Converts one v3 numeric value. Returns { value, code } where code is null (exact), 'inexact'
 * (rounded, keep sourceRaw), 'zero', or 'bad'.
 */
function convertNumber(v, field, units) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return { value: null, code: 'bad' };
  if (v === 0) return { value: null, code: 'zero' };
  if (v < 0) return { value: null, code: 'bad' };
  if (field === 'r') return Number.isInteger(v) ? { value: v, code: null } : { value: null, code: 'bad' };
  if (field === 'w') return { value: v, code: null };
  if (field === 'd') {
    const m = units.d === 'km' ? v * 1000 : v;
    const tenths = Math.round(m * 10);
    return { value: tenths / 10, code: Math.abs(m * 10 - tenths) < 1e-6 ? null : 'inexact' };
  }
  // t
  const sec = units.t === 'min' ? v * 60 : v;
  const whole = Math.round(sec);
  if (whole === 0) return { value: null, code: 'bad' }; // a positive time that rounds to 0 s can't be stored
  return { value: whole, code: Math.abs(sec - whole) < 1e-6 ? null : 'inexact' };
}

class WarningList {
  constructor() {
    this.list = [];
    this.seen = new Set();
  }
  add(code, ref = null) {
    const k = `${code}\u0000${ref}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.list.push({ code, ref });
  }
}

/**
 * Exercise resolution for one v1 source against an existing store (seeded catalog + earlier imports).
 * Creates custom and unresolved exercises lazily, in first-use order.
 */
async function createResolver({ src, store, seedDoc, importedAt, warnings, quarantineCustom }) {
  const exById = new Map(store.exercises.map((e) => [e.id, e]));
  const seedIdByName = new Map(seedDoc.exercises.map((e) => [e.name, e.id]));
  const added = []; // new exercises, in creation order
  const unresolvedIds = [];
  const cbwChanges = [];

  // Custom list: first valid entry per name wins (v3 exOf uses Array.find); catalog names win.
  const customs = new Map();
  for (let k = 0; k < src.root.custom.length; k++) {
    const c = src.root.custom[k];
    if (src.textItems.has(`custom:${k}`)) {
      quarantineCustom(k, 'text');
      continue;
    }
    if (!isObj(c) || typeof c.name !== 'string' || c.name.length === 0) {
      quarantineCustom(k, 'invalid');
      continue;
    }
    if (isV1CatalogName(c.name)) {
      warnings.add('V1_CUSTOM_COLLIDES', `custom[${k}]`);
      continue;
    }
    if (customs.has(c.name)) {
      warnings.add('V1_CUSTOM_COLLIDES', `custom[${k}]`);
      continue;
    }
    customs.set(c.name, { index: k, type: c.type });
  }

  // R2-7: a custom bodyweight_reps exercise has added load if ANY set in the file (workouts or draft) has w > 0.
  const anyAddedLoad = new Set();
  const scanEntries = (entries) => {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!isObj(e) || !Array.isArray(e.sets) || !customs.has(e.name)) continue;
      if (e.sets.some((s) => isObj(s) && typeof s.w === 'number' && s.w > 0)) anyAddedLoad.add(e.name);
    }
  };
  src.root.workouts.forEach((w, i) => { if (!src.textItems.has(`workout:${i}`) && isObj(w)) scanEntries(w.entries); });
  if (isObj(src.root.draft) && !src.textItems.has('draft')) scanEntries(src.root.draft.entries);

  async function ensure(id, make) {
    if (exById.has(id)) return exById.get(id);
    const ex = await make();
    exById.set(id, ex);
    added.push(ex);
    return ex;
  }

  async function unresolvedExercise(name, keys, customType, reason) {
    const key = reason === 'field_mismatch' ? `${name}\u0000${[...keys].sort().join('\u0000')}` : name;
    const id = `ex_v1u_${await hex16(key)}`;
    const displayName = reason === 'field_mismatch' ? `${name} [v1: ${[...keys].sort().join(', ')}]` : name;
    const ex = await ensure(id, () => createExercise({ id, name: displayName, measurement: UNRESOLVED_MEASUREMENT, isCustom: true, now: importedAt }));
    if (!unresolvedIds.includes(id)) unresolvedIds.push(id);
    warnings.add('V1_UNKNOWN_EXERCISE', id);
    return { ex, reason, customType };
  }

  /**
   * @returns {Promise<{kind:'mapped', ex, fields, units, customType} | {kind:'unknown', name, customType, reason}>}
   */
  async function resolve(name) {
    if (isV1CatalogName(name)) {
      const ex = exById.get(seedIdByName.get(name));
      if (ex && ex.measurement.type !== 'unresolved') {
        if (V1_LABEL_MISMATCH_NAMES.includes(name)) warnings.add('V1_LABEL_MISMATCH', ex.id);
        return { kind: 'mapped', ex, fields: fieldsOfC(name), units: unitsOfC(name), customType: null };
      }
      return { kind: 'unknown', name, customType: null, reason: 'unknown_name' };
    }
    const c = customs.get(name);
    if (!c) return { kind: 'unknown', name, customType: null, reason: 'unknown_name' };
    const customType = typeof c.type === 'string' ? c.type : null;
    const measurement = V1_CUSTOM_TYPES.includes(c.type) ? customMeasurement(c.type, anyAddedLoad.has(name)) : null;
    if (!measurement) return { kind: 'unknown', name, customType, reason: 'unknown_custom_type' };
    const id = `ex_v1c_${await hex16(name)}`;
    const ex = await ensure(id, async () => {
      if (measurement.type === 'bodyweight_plus_load') cbwChanges.push(CBW_CHANGE_TEXT(name));
      return createExercise({ id, name, measurement, isCustom: true, now: importedAt });
    });
    if (ex.measurement.type === 'unresolved') return { kind: 'unknown', name, customType, reason: 'unknown_custom_type' };
    warnings.add('V1_CUSTOM_TYPE', ex.id);
    return { kind: 'mapped', ex, fields: fieldsOfC(name, c.type), units: unitsOfC(name, c.type), customType: c.type };
  }

  return { resolve, unresolvedExercise, added, unresolvedIds, cbwChanges, customs };
}

/**
 * Maps the saved workouts of a prepared v1 source.
 * @param {object} args
 * @param {object} args.src        prepareV1Source result (ok)
 * @param {object} args.store      existing v2 store (seeded); not modified
 * @param {object} args.seedDoc
 * @param {string} args.importId
 * @param {string} args.importedAt
 * @param {string} args.sourceSha256
 * @param {'v1_migration'|'v1_late_import'} args.origin
 * @param {boolean} [args.withDraft]  first migration only
 */
export async function mapV1Source({ src, store, seedDoc, importId, importedAt, sourceSha256, origin, withDraft = false }) {
  const warnings = new WarningList();
  const quarantine = []; // { sortKey:[offset, e, s], reason, raw, setCount, kind }
  const breakdown = {
    sourceSets: 0,
    mapped: 0,
    unresolved: { unknown_name: 0, field_mismatch: 0, unknown_custom_type: 0 },
    mergedIntoNotes: 0,
    quarantinedItems: 0,
    setsInQuarantinedItems: 0,
    alreadyPresent: 0, // late import only: sets of sessions already in the store (identical)
  };
  const offsetOf = (path) => src.spans[path]?.start ?? Number.MAX_SAFE_INTEGER;

  const qItem = (sortKey, reason, raw, setCount, kind) => quarantine.push({ sortKey, reason, raw, setCount, kind });
  const textRaw = (path) => ({ format: 'v1_source_text', path: path.slice(2), text: sourceSlice(src, path) });
  const itemRaw = (path, value) => ({ format: 'v1_item', path, value });

  // Literal findings → warnings (one per finding).
  for (const f of src.findings) warnings.add('V1_SOURCE_LITERAL_NORMALIZED', `${f.path}|${f.reason}|${f.offset}`);

  const resolver = await createResolver({
    src,
    store,
    seedDoc,
    importedAt,
    warnings,
    quarantineCustom: (k, how) => {
      const path = `$.custom[${k}]`;
      qItem([offsetOf(path), -1, -1], 'invalid_item', how === 'text' ? textRaw(path) : itemRaw(`custom[${k}]`, src.root.custom[k]), 0, 'custom');
    },
  });

  if (structureWarning(src.structure)) warnings.add('V1_STRUCTURE_UNVERIFIED', src.structure);

  // ---- saved workouts ------------------------------------------------------------------------
  const existingSessions = new Map(store.sessions.map((s) => [s.id, s]));
  const v1Existing = store.sessions.filter((s) => (s.origin === 'v1_migration' || s.origin === 'v1_late_import') && isObj(s.provenance));
  const assigned = new Map(); // id → mapped session of this run
  const legacyCount = new Map(); // String(legacyId) → occurrences so far
  const legacyTotal = new Map();
  const workouts = src.root.workouts;
  const validLegacyId = (id) => (Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && SAFE_LEGACY_ID.test(id));
  workouts.forEach((w, i) => {
    if (!src.textItems.has(`workout:${i}`) && isObj(w) && validLegacyId(w.id)) legacyTotal.set(String(w.id), (legacyTotal.get(String(w.id)) ?? 0) + 1);
  });

  const sessions = []; // { session|null, index, cls: new|dup|noid|collision|conflict|identical, existingId, … }
  for (let i = 0; i < workouts.length; i++) {
    const w = workouts[i];
    const path = `$.workouts[${i}]`;
    const sourceSets = countWorkoutSets(w);
    breakdown.sourceSets += sourceSets;
    if (src.textItems.has(`workout:${i}`)) {
      qItem([offsetOf(path), -1, -1], 'invalid_item', textRaw(path), sourceSets, 'workout');
      continue;
    }
    if (!isObj(w) || !Array.isArray(w.entries)) {
      qItem([offsetOf(path), -1, -1], 'invalid_item', itemRaw(`workouts[${i}]`, w), sourceSets, 'workout');
      continue;
    }
    const sourceSessionSha256 = await canonicalSha256(w);
    const sessionWarnings = [];

    // ---- session ID (approved patterns + two-pass collision rule) -----------------------------
    let legacyWorkoutId = null;
    let baseId;
    let pattern;
    if (validLegacyId(w.id)) {
      legacyWorkoutId = w.id;
      const key = String(w.id);
      const n = (legacyCount.get(key) ?? 0) + 1;
      legacyCount.set(key, n);
      if (legacyTotal.get(key) > 1) sessionWarnings.push('V1_DUP_ID');
      baseId = n === 1 ? v1SessionId(w.id) : v1DuplicateSessionId(w.id, n);
      pattern = n === 1 ? 'legacy' : 'dup';
    } else {
      if (w.id !== undefined && w.id !== null) warnings.add('V1_BAD_VALUE', `workouts[${i}].id`);
      baseId = v1NoIdSessionId(sourceSessionSha256, i);
      pattern = 'noid';
    }
    // Late import (Phase 2a R4): classify against the ORIGINAL source identity of existing sessions
    // (provenance.sourceSessionSha256), never against their v2 content.
    let cls = 'new';
    let existingId = null;
    if (origin === 'v1_late_import') {
      if (legacyWorkoutId !== null) {
        const matches = v1Existing.filter((x) => String(x.provenance.legacyWorkoutId) === String(legacyWorkoutId));
        const same = matches.find((x) => x.provenance.sourceSessionSha256 === sourceSessionSha256);
        if (same) {
          sessions.push({ session: null, index: i, cls: 'identical', existingId: same.id, sourceSessionSha256, legacyWorkoutId, sourceSets, pattern });
          breakdown.alreadyPresent += sourceSets;
          continue;
        }
        if (matches.length) {
          cls = 'conflict';
          existingId = matches[0].id;
          baseId = v1AltSessionId(legacyWorkoutId, sourceSessionSha256);
          pattern = 'alt';
        }
      } else {
        const same = v1Existing.find((x) => x.provenance.sourceSessionSha256 === sourceSessionSha256);
        if (same) existingId = same.id; // "looks identical to …" — still not selected by default
      }
      if (cls === 'new' && legacyWorkoutId !== null && legacyTotal.get(String(legacyWorkoutId)) > 1) cls = 'dup';
      if (cls === 'new' && legacyWorkoutId === null) cls = 'noid';
    }
    const isSameOrigin = (id) => {
      const s = existingSessions.get(id) ?? assigned.get(id);
      const p = s?.provenance;
      if (!p || (s.origin !== 'v1_migration' && s.origin !== 'v1_late_import')) return false;
      if (pattern === 'legacy' || pattern === 'alt') return String(p.legacyWorkoutId) === String(legacyWorkoutId) && p.sourceSessionSha256 === sourceSessionSha256;
      return p.sourceSessionSha256 === sourceSessionSha256 && p.snapshotSha256 === sourceSha256 && p.legacyWorkoutIndex === i;
    };
    const col = resolveCollision({ baseId, isUsed: (id) => existingSessions.has(id) || assigned.has(id), isSameOrigin });
    if (col.status === 'already_exists') {
      sessions.push({ session: null, index: i, cls: 'identical', existingId: col.id, sourceSessionSha256, legacyWorkoutId, sourceSets, pattern });
      breakdown.alreadyPresent += sourceSets;
      continue;
    }
    if (col.status === 'unresolved') {
      warnings.add('ID_COLLISION_UNRESOLVED', `workouts[${i}]`);
      qItem([offsetOf(path), -1, -1], 'id_collision_unresolved', itemRaw(`workouts[${i}]`, w), sourceSets, 'workout');
      continue;
    }
    const sessionId = col.id;

    // ---- date, template ------------------------------------------------------------------------
    let date = null;
    let legacyDateRaw = null;
    if (isLocalDate(w.date)) date = w.date;
    else {
      legacyDateRaw = w.date === undefined ? null : w.date;
      sessionWarnings.push('V1_BAD_DATE');
    }
    let templateId = null;
    let templateNameSnapshot = null;
    if (typeof w.name === 'string' && w.name.length > 0) {
      templateNameSnapshot = w.name;
      const tpl = store.templates.find((t) => t.seed !== null && t.name === w.name);
      if (tpl) templateId = tpl.id;
      else sessionWarnings.push('V1_TEMPLATE_NAME');
    } else if (w.name !== undefined && typeof w.name !== 'string') warnings.add('V1_BAD_VALUE', `workouts[${i}].name`);

    const session = createSession({
      id: sessionId,
      origin,
      provenance: { importId, snapshotSha256: sourceSha256, legacyWorkoutIndex: i, legacyWorkoutId, legacyDateRaw, sourceSessionSha256 },
      date,
      templateId,
      templateNameSnapshot,
      bodyweight: emptyBodyweight(),
      now: importedAt,
    });
    if (col.collisionResolved) sessionWarnings.push('ID_COLLISION_RESOLVED');

    const tally = { mapped: 0, unresolved: { unknown_name: 0, field_mismatch: 0, unknown_custom_type: 0 }, notes: 0 };
    for (let e = 0; e < w.entries.length; e++) {
      const entry = w.entries[e];
      const epath = `workouts[${i}].entries[${e}]`;
      if (!isObj(entry) || typeof entry.name !== 'string' || entry.name.length === 0 || !Array.isArray(entry.sets)) {
        const n = isObj(entry) && Array.isArray(entry.sets) ? entry.sets.length : 0;
        qItem([offsetOf(path), e, -1], 'invalid_item', itemRaw(epath, entry), n, 'entry');
        continue;
      }
      const goodSets = [];
      entry.sets.forEach((s, j) => {
        if (isObj(s)) goodSets.push([j, s]);
        else qItem([offsetOf(path), e, j], 'invalid_item', itemRaw(`${epath}.sets[${j}]`, s), 1, 'set');
      });
      const order = session.performances.length + 1;
      const perf = await mapPerformance({ entry, goodSets, e, order, sessionId, resolver, warnings, tally, quarantineSet: (j, s) => qItem([offsetOf(path), e, j], 'invalid_item', itemRaw(`${epath}.sets[${j}]`, s), 1, 'set') });
      session.performances.push(perf);
    }
    session.warnings = [...new Set(sessionWarnings)];
    for (const c of session.warnings) warnings.add(c, sessionId);
    breakdown.mapped += tally.mapped;
    for (const r of Object.keys(tally.unresolved)) breakdown.unresolved[r] += tally.unresolved[r];
    breakdown.mergedIntoNotes += tally.notes;
    if (cls === 'new' && col.collisionResolved) cls = 'collision';
    const mapped = { session, index: i, pattern, cls, existingId, collisionResolved: col.collisionResolved === true, sourceSessionSha256, legacyWorkoutId, sourceSets };
    if (col.status === 'assigned') assigned.set(sessionId, session);
    sessions.push(mapped);
  }

  // ---- draft (first migration only) ------------------------------------------------------------
  let activeSession = null;
  let draftOutcome = 'none';
  if (withDraft && src.root.draft !== null && src.root.draft !== undefined) {
    const r = await mapDraft({ src, store, resolver, sourceSha256, importedAt, workouts, sessions, warnings });
    draftOutcome = r.outcome;
    if (r.activeSession) activeSession = r.activeSession;
    else qItem([offsetOf('$.draft'), -1, -1], r.reason, r.textQuarantine ? textRaw('$.draft') : itemRaw('draft', src.root.draft), 0, 'draft');
  }

  // ---- settings bodyweight ---------------------------------------------------------------------
  let bodyweightSetting = null;
  if (src.root.bw !== undefined) {
    if (src.textItems.has('bw')) {
      // literal finding already reported; the setting stays empty
    } else if (typeof src.root.bw === 'number' && Number.isFinite(src.root.bw) && src.root.bw > 0) {
      bodyweightSetting = { value: src.root.bw, unit: 'kg', confirmed: false, updatedAt: importedAt };
      warnings.add('V1_BW_SETTING_AMBIGUOUS', 'bw');
    } else warnings.add('V1_BAD_VALUE', 'bw');
  }
  if (sessions.length > 0) warnings.add('V1_BODYWEIGHT_UNKNOWN', null);

  // ---- quarantine in source order; reconciliation ----------------------------------------------
  quarantine.sort((a, b) => a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1] || a.sortKey[2] - b.sortKey[2]);
  for (const q of quarantine) {
    if (q.kind === 'draft' || q.kind === 'custom') continue;
    breakdown.setsInQuarantinedItems += q.setCount;
  }
  breakdown.quarantinedItems = quarantine.length;
  const unresolvedSets = Object.values(breakdown.unresolved).reduce((a, b) => a + b, 0);
  const reconciled = breakdown.sourceSets === breakdown.mapped + unresolvedSets + breakdown.mergedIntoNotes + breakdown.setsInQuarantinedItems + breakdown.alreadyPresent;

  return {
    sessions,
    activeSession,
    draftOutcome,
    quarantine,
    newExercises: resolver.added,
    unresolvedExercises: resolver.unresolvedIds,
    calculationChanges: resolver.cbwChanges,
    bodyweightSetting,
    warnings: warnings.list,
    breakdown,
    reconciled,
  };
}

const structureWarning = (structure) => structure === 'A' || structure === 'B_or_C';

/** Maps one v1 entry (with its object sets) to a v2 performance. */
async function mapPerformance({ entry, goodSets, e, order, sessionId, resolver, warnings, tally, quarantineSet }) {
  const prfId = derivedPerformanceId(sessionId, order);
  const res = await resolver.resolve(entry.name);
  const keysOf = (s) => Object.keys(s);
  let mismatch = false;
  if (res.kind === 'mapped') {
    const want = res.fields.map((f) => f.k);
    mismatch = goodSets.some(([, s]) => !sameKeySet(keysOf(s), want));
  }

  if (res.kind === 'unknown' || mismatch) {
    const reason = res.kind === 'unknown' ? res.reason : 'field_mismatch';
    const allKeys = [...new Set(goodSets.flatMap(([, s]) => keysOf(s)))];
    const customType = res.customType;
    const u = await resolver.unresolvedExercise(entry.name, allKeys, customType, reason);
    const cFields = isV1CatalogName(entry.name) ? fieldsOfC(entry.name) : res.kind === 'mapped' ? res.fields : null;
    const labelOf = new Map((cFields ?? []).map((f) => [f.k, f.l]));
    const perf = {
      id: prfId, exerciseId: u.ex.id, order, nameSnapshot: entry.name,
      measurement: { ...UNRESOLVED_MEASUREMENT }, note: null, sets: [],
    };
    goodSets.forEach(([j, s], k) => {
      const set = createSet({ id: derivedSetId(sessionId, order, k + 1), measurement: UNRESOLVED_MEASUREMENT, order: k + 1 });
      set.completed = true;
      set.sourceRef = { e, s: j };
      set.sourceRaw = structuredClone(s);
      const v1Fields = keysOf(s);
      set.sourceContext = {
        v1Fields,
        v1Labels: v1Fields.filter((f) => labelOf.has(f)).map((f) => labelOf.get(f)),
        v1CustomType: typeof customType === 'string' ? customType : null,
      };
      perf.sets.push(set);
    });
    tally.unresolved[reason] += goodSets.length;
    return perf;
  }

  const ex = res.ex;
  const perf = { id: prfId, exerciseId: ex.id, order, nameSnapshot: ex.name, measurement: snapshotMeasurement(ex), note: null, sets: [] };

  if (ex.measurement.type === 'note') {
    const notes = [];
    for (const [j, s] of goodSets) {
      if (typeof s.note !== 'string') {
        quarantineSet(j, s);
        continue;
      }
      tally.notes++;
      const t = s.note.trim();
      if (t.length > 0) notes.push(t);
    }
    perf.note = notes.length ? notes.join('\n\n') : null;
    if (goodSets.length) warnings.add('V1_NOTE_SET', ex.id);
    return perf;
  }

  const allowed = new Set(Object.values(V2_FIELD));
  let k = 0;
  for (const [j, s] of goodSets) {
    k++;
    const set = createSet({ id: derivedSetId(sessionId, order, k), measurement: ex.measurement, order: k });
    set.completed = true;
    set.sourceRef = { e, s: j };
    const setWarnings = [];
    let keepRaw = false;
    for (const f of res.fields) {
      const v = s[f.k];
      const dropW = f.k === 'w' && ex.measurement.type === 'bodyweight_reps'; // custom reps-only: "+kg" 0 = not entered
      const conv = convertNumber(v, f.k, res.units);
      if (dropW) {
        if (conv.code === 'zero') continue; // raw stays in the legacy snapshot (R2-7)
        keepRaw = true;
        setWarnings.push('V1_BAD_VALUE');
        continue;
      }
      const field = V2_FIELD[f.k];
      if (!allowed.has(field)) continue;
      set[field] = conv.value;
      if (conv.code === 'zero') {
        keepRaw = true;
        setWarnings.push(f.k === 'w' && res.units.wAdded ? 'V1_ADDED_LOAD_ZERO' : 'V1_ZERO_AS_NULL');
      } else if (conv.code === 'bad') {
        keepRaw = true;
        setWarnings.push('V1_BAD_VALUE');
      } else if (conv.code === 'inexact') keepRaw = true;
    }
    if (ex.measurement.type === 'distance_duration' && set.durationSec !== null) warnings.add('V1_DURATION_BASIS_UNKNOWN', ex.id);
    if (keepRaw) set.sourceRaw = structuredClone(s);
    if (setWarnings.length) {
      set.warnings = [...new Set(setWarnings)];
      for (const c of set.warnings) warnings.add(c, set.id);
    }
    perf.sets.push(set);
  }
  tally.mapped += goodSets.length;
  return perf;
}

/**
 * Draft → active session (Revision 2 §6). Returns { activeSession } or { outcome, reason } for quarantine.
 * The original draft always stays byte-exact in the legacy snapshot.
 */
async function mapDraft({ src, store, resolver, sourceSha256, importedAt, workouts, sessions, warnings }) {
  const d = src.root.draft;
  if (src.textItems.has('draft')) {
    warnings.add('V1_DRAFT', 'draft');
    return { outcome: 'quarantined_text', reason: 'invalid_item', textQuarantine: true };
  }
  const editId = Object.prototype.hasOwnProperty.call(d, 'editId') ? d.editId : undefined;
  if (editId !== undefined && editId !== null) {
    const ti = workouts.findIndex((w) => isObj(w) && w.id === editId);
    if (ti >= 0) {
      const target = sessions.find((s) => s.index === ti);
      warnings.add('V1_DRAFT', target ? target.session.id : `workouts[${ti}]`);
      return { outcome: 'edit_quarantined', reason: 'v1_draft_not_migrated' };
    }
    warnings.add('V1_DRAFT_EDIT_MISSING', 'draft');
  }
  const malformed = () => {
    warnings.add('V1_DRAFT', 'draft');
    return { outcome: 'malformed', reason: 'invalid_item' };
  };
  const notMigrated = (outcome) => {
    warnings.add('V1_DRAFT', 'draft');
    return { outcome, reason: 'v1_draft_not_migrated' };
  };
  if (!Array.isArray(d.entries)) return malformed();
  if (d.name !== undefined && typeof d.name !== 'string') return malformed();
  for (const e of d.entries) {
    if (!isObj(e) || typeof e.name !== 'string' || e.name.length === 0 || !Array.isArray(e.sets)) return malformed();
    if (e.sets.some((s) => !isObj(s) || typeof s.done !== 'boolean')) return malformed();
  }
  if (!isLocalDate(d.date)) return notMigrated('unrepresentable');

  const sessionId = `ses_v1draft_${sourceSha256.slice(0, 16)}`;
  let templateId = null;
  let templateNameSnapshot = null;
  if (typeof d.name === 'string' && d.name.length > 0) {
    templateNameSnapshot = d.name;
    const tpl = store.templates.find((t) => t.seed !== null && t.name === d.name);
    if (tpl) templateId = tpl.id;
  }
  const session = createSession({ id: sessionId, origin: 'app', provenance: null, date: d.date, templateId, templateNameSnapshot, bodyweight: emptyBodyweight(), now: importedAt });
  let zero = false;
  for (let ei = 0; ei < d.entries.length; ei++) {
    const entry = d.entries[ei];
    const res = await resolver.resolve(entry.name);
    if (res.kind !== 'mapped') return notMigrated('unknown_exercise');
    const want = [...res.fields.map((f) => f.k), 'done'];
    if (entry.sets.some((s) => !sameKeySet(Object.keys(s), want))) return notMigrated('field_mismatch');
    const order = ei + 1;
    const ex = res.ex;
    const perf = { id: derivedPerformanceId(sessionId, order), exerciseId: ex.id, order, nameSnapshot: ex.name, measurement: snapshotMeasurement(ex), note: null, sets: [] };
    if (ex.measurement.type === 'note') {
      const notes = [];
      for (const s of entry.sets) {
        if (typeof s.note !== 'string') return notMigrated('unrepresentable');
        if (s.note.trim()) notes.push(s.note.trim());
      }
      perf.note = notes.length ? notes.join('\n\n') : null;
      session.performances.push(perf);
      continue;
    }
    let k = 0;
    for (const s of entry.sets) {
      k++;
      const set = createSet({ id: derivedSetId(sessionId, order, k), measurement: ex.measurement, order: k });
      set.completed = s.done;
      for (const f of res.fields) {
        const v = s[f.k];
        if (v === '') continue;
        const conv = convertNumber(v, f.k, res.units);
        if (conv.code === 'zero') {
          zero = true;
          continue;
        }
        if (conv.code !== null) return notMigrated('unrepresentable');
        if (f.k === 'w' && ex.measurement.type === 'bodyweight_reps') return notMigrated('unrepresentable');
        set[V2_FIELD[f.k]] = conv.value;
      }
      perf.sets.push(set);
    }
    session.performances.push(perf);
  }
  if (zero) warnings.add('V1_ZERO_AS_NULL', sessionId);
  warnings.add('V1_DRAFT', sessionId);
  return {
    outcome: 'active_session',
    activeSession: { mode: 'new', editsSessionId: null, baseUpdatedAt: null, session, preservedPerformanceIds: [] },
  };
}

/** Quarantine entries with derived IDs q_<importId suffix>_<nn>, in source order (R4-3). */
export function quarantineEntries(items, importId) {
  const suffix = importId.slice('imp_'.length);
  return items.map((q, n) => ({ id: `q_${suffix}_${pad2(n + 1)}`, importId, reason: q.reason, raw: q.raw }));
}

