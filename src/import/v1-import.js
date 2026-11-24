// v1 import builders (Steps 2c.4–2c.6). Pure: they build candidates and plans in memory and never
// touch storage. The write sequences (M1–M8, late import) live in the application layer
// (src/app/workflows.js), which alone holds the Store and side-key handles.

import { canonicalize, canonicalSha256, sha256Hex } from '../schema/canonical.js';
import { createEmptyStore } from '../schema/factories.js';
import { validateStore } from '../schema/validate.js';
import { MIGRATION_RULES_VERSION } from '../schema/constants.js';
import { applySeeds } from '../store/seeding.js';
import { prepareV1Source } from './v1-source.js';
import { mapV1Source, quarantineEntries, EVIDENCE_LABELS, CBW_CHANGE_TEXT } from './v1-mapping.js';

const sumPerf = (sessions) => sessions.reduce((n, s) => n + s.performances.length, 0);
const sumSets = (sessions) => sessions.reduce((n, s) => n + s.performances.reduce((m, p) => m + p.sets.length, 0), 0);

function reportOf(src, m) {
  return {
    structure: src.structure,
    evidence: EVIDENCE_LABELS[src.structure],
    breakdown: m.breakdown,
    draftOutcome: m.draftOutcome,
    warnings: m.warnings,
    unresolvedExercises: m.unresolvedExercises,
    calculationChanges: m.calculationChanges,
  };
}

/**
 * M1: builds the complete first-migration candidate (status `pending`) in memory.
 * Deterministic: the same text, importId, importedAt, appVersion and seed give the same candidate.
 * @returns {Promise<{ok:true, candidate, candidateSha256, entry, seedSha256, report}
 *   | {ok:false, code, ...}>}
 */
export async function buildFirstMigration({ text, importId, importedAt, appVersion, seedDoc }) {
  const src = prepareV1Source(text);
  if (!src.ok) return src;
  const sourceSha256 = await sha256Hex(text);
  const seeded = await applySeeds(createEmptyStore({ now: importedAt, appVersion }), seedDoc, { now: importedAt });
  if (!seeded.ok) return { ok: false, code: seeded.code, errors: seeded.errors };
  const store = seeded.store;
  const m = await mapV1Source({ src, store, seedDoc, importId, importedAt, sourceSha256, origin: 'v1_migration', withDraft: true });
  if (!m.reconciled) return { ok: false, code: 'RECONCILIATION_FAILED', breakdown: m.breakdown };

  const sessions = m.sessions.map((x) => x.session);
  const quarantine = quarantineEntries(m.quarantine, importId);
  store.exercises.push(...m.newExercises);
  store.sessions.push(...sessions);
  store.quarantine.push(...quarantine);
  store.activeSession = m.activeSession;
  if (m.bodyweightSetting) store.settings.bodyweight = m.bodyweightSetting;
  const seedSha256 = await canonicalSha256(seedDoc);
  const entry = {
    importId,
    kind: 'v1_migration',
    status: 'pending',
    at: importedAt,
    reportSeenAt: null,
    sourceSha256,
    packageSha256: null,
    counts: { sessions: sessions.length, performances: sumPerf(sessions), sets: sumSets(sessions), quarantined: quarantine.length },
    unresolvedExercises: m.unresolvedExercises,
    warnings: m.warnings,
    calculationChanges: m.calculationChanges,
    reproduction: { seedSha256, appVersion, rulesVersion: MIGRATION_RULES_VERSION },
  };
  store.meta.importLog.push(entry);
  const v = await validateStore(store);
  if (!v.valid) return { ok: false, code: 'RESULT_INVALID', errors: v.errors };
  return { ok: true, candidate: store, candidateSha256: await canonicalSha256(store), sourceSha256, seedSha256, entry, report: reportOf(src, m) };
}

// ---- late import (Step 2c.6; Phase 2a S9 / R4) --------------------------------------------------

const ACTIONS = Object.freeze({
  new: { options: ['import', 'skip'], default: 'import' },
  conflict: { options: ['keep_existing', 'import_alt', 'quarantine'], default: 'keep_existing' },
  dup: { options: ['import', 'skip', 'quarantine'], default: 'skip' },
  noid: { options: ['import', 'skip', 'quarantine'], default: 'skip' },
  collision: { options: ['import', 'skip', 'quarantine'], default: 'skip' },
});
export const LATE_IMPORT_ACTIONS = ACTIONS;

const v1Kinds = ['v1_migration', 'v1_late_import'];

/**
 * Plans a late import of a v1 file into an existing store. Writes nothing.
 * @param {object} a
 * @param {(sha256:string) => Promise<{ok:boolean, present?:boolean, raw?:string, hashValid?:boolean}>} a.readLegacy
 * @returns {Promise<{ok:true, plan} | {ok:false, code}>}
 */
export async function planLateImport({ text, store, seedDoc, importId, importedAt, readLegacy }) {
  const src = prepareV1Source(text);
  if (!src.ok) return src;
  const sourceSha256 = await sha256Hex(text);
  if (store.meta.importLog.some((e) => v1Kinds.includes(e.kind) && e.sourceSha256 === sourceSha256)) return { ok: false, code: 'ALREADY_IMPORTED', sourceSha256 };
  const m = await mapV1Source({ src, store, seedDoc, importId, importedAt, sourceSha256, origin: 'v1_late_import', withDraft: false });
  if (!m.reconciled) return { ok: false, code: 'RECONCILIATION_FAILED', breakdown: m.breakdown };

  // Cross-check the stored source identity of existing sessions against their snapshot (LATE4).
  const extraWarnings = [];
  const snapshotCache = new Map();
  const byId = new Map(store.sessions.map((s) => [s.id, s]));
  for (const x of m.sessions) {
    if (x.cls !== 'identical' && x.cls !== 'conflict') continue;
    const existing = byId.get(x.existingId);
    const p = existing?.provenance;
    if (!p) continue;
    if (!snapshotCache.has(p.snapshotSha256)) {
      const r = await readLegacy(p.snapshotSha256);
      let workouts = null;
      if (r.ok && r.present && r.hashValid) {
        const parsed = prepareV1Source(r.raw);
        if (parsed.ok) workouts = parsed.root.workouts;
      }
      snapshotCache.set(p.snapshotSha256, workouts);
    }
    const workouts = snapshotCache.get(p.snapshotSha256);
    if (workouts && workouts[p.legacyWorkoutIndex] !== undefined) {
      let h = null;
      try {
        h = await canonicalSha256(workouts[p.legacyWorkoutIndex]);
      } catch {
        h = null;
      }
      if (h !== p.sourceSessionSha256) extraWarnings.push({ code: 'SOURCE_IDENTITY_MISMATCH', ref: existing.id });
    }
  }

  const items = m.sessions.map((x) => {
    const a = ACTIONS[x.cls];
    return {
      index: x.index,
      cls: x.cls,
      sessionId: x.session ? x.session.id : null,
      existingId: x.existingId,
      defaultAction: a ? a.default : null,
      options: a ? [...a.options] : [],
      date: x.session ? x.session.date : null,
      performances: x.session ? x.session.performances.length : 0,
      sets: x.sourceSets,
    };
  });
  return {
    ok: true,
    plan: {
      importId,
      importedAt,
      sourceSha256,
      text,
      storeCanonical: canonicalize(store),
      mapping: m,
      extraWarnings,
      items,
      draftPresent: src.root.draft !== null && src.root.draft !== undefined,
      structure: src.structure,
    },
  };
}

/**
 * Builds the additions for a planned late import from the user's selection ({ [index]: action };
 * unspecified items take their default). Returns null additions when nothing would change.
 */
export function buildLateImport(plan, selection = {}) {
  const m = plan.mapping;
  const chosen = new Map();
  for (const it of plan.items) {
    if (!it.options.length) continue;
    const action = Object.prototype.hasOwnProperty.call(selection, it.index) ? selection[it.index] : it.defaultAction;
    if (!it.options.includes(action)) return { ok: false, code: 'RESULT_INVALID', errors: [{ code: 'LATE_ACTION', path: `$selection.${it.index}`, message: `allowed: ${it.options.join(', ')}` }] };
    chosen.set(it.index, action);
  }
  const selected = m.sessions.filter((x) => x.session && ['import', 'import_alt'].includes(chosen.get(x.index))).map((x) => x.session);
  const userQuarantine = m.sessions
    .filter((x) => chosen.get(x.index) === 'quarantine')
    .map((x) => ({
      sortKey: [x.index, -2, -2],
      reason: x.cls === 'conflict' ? 'conflict_after_migration' : 'user_quarantined_import',
      raw: { format: 'v1_item', path: `workouts[${x.index}]`, value: prepareV1Source(plan.text).root.workouts[x.index] },
    }));
  const items = [...m.quarantine, ...userQuarantine].sort((a, b) => a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1] || a.sortKey[2] - b.sortKey[2]);
  if (selected.length === 0 && items.length === 0) return { ok: true, additions: null };

  const usedEx = new Set(selected.flatMap((s) => s.performances.map((p) => p.exerciseId)));
  const exercises = m.newExercises.filter((e) => usedEx.has(e.id));
  const sessionIds = new Set(selected.flatMap((s) => [s.id, ...s.performances.flatMap((p) => p.sets.map((x) => x.id))]));
  const keepRef = (ref) => {
    if (typeof ref !== 'string') return true;
    if (ref.startsWith('ses_') || ref.startsWith('set_')) return sessionIds.has(ref);
    if (ref.startsWith('ex_')) return usedEx.has(ref);
    return true;
  };
  const warnings = [...m.warnings.filter((w) => keepRef(w.ref)), ...plan.extraWarnings];
  for (const x of m.sessions) if (chosen.get(x.index) === 'import_alt') warnings.push({ code: 'V1_LEGACY_ID_CONFLICT', ref: x.session.id });
  const quarantine = quarantineEntries(items, plan.importId);
  const entry = {
    importId: plan.importId,
    kind: 'v1_late_import',
    status: 'pending',
    at: plan.importedAt,
    reportSeenAt: null,
    sourceSha256: plan.sourceSha256,
    packageSha256: null,
    counts: { sessions: selected.length, performances: sumPerf(selected), sets: sumSets(selected), quarantined: quarantine.length },
    unresolvedExercises: [...usedEx].filter((id) => id.startsWith('ex_v1u_')),
    warnings,
    calculationChanges: exercises.filter((e) => e.id.startsWith('ex_v1c_') && e.measurement.type === 'bodyweight_plus_load').map((e) => CBW_CHANGE_TEXT(e.name)),
  };
  return { ok: true, additions: { exercises, sessions: selected, quarantine, entry } };
}
