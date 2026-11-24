// Seeding: default catalog and templates, tombstones, explicit Restore Default, upgrade offers.
//
// All functions are PURE: they never mutate their inputs and never read or write storage. Each returns
// either { ok: true, store, ... } with a new, fully validated store, or { ok: false, code, ... } with the
// input store left untouched. Persisting a result (and revision handling) belongs to the commit logic.
//
// Dependencies are injected: every function that writes a timestamp requires `now`; every function that
// creates IDs requires `newId(prefix)`. There is no hidden clock and no hidden randomness.
//
// meta.seedsApplied[id] = the LATEST SEED VERSION THE USER HAS HANDLED for that ID (applied, accepted as a
// copy, or dismissed). It is NOT necessarily the version the entity carries; that is entity.seed.version.
//
// meta.seedTombstones: written when a seeded entity is deleted; removed ONLY by restoreDefault (SD3).

import { validateStore } from '../schema/validate.js';
import { validateSeedDefaults, exerciseFromSeed, templateFromSeed } from '../schema/seed-schema.js';

const COPY_SUFFIX = ' (Copy)';

function requireNow(now) {
  if (typeof now !== 'string' || now.length === 0) throw new TypeError('`now` (ISO timestamp) is required');
}
function requireNewId(newId) {
  if (typeof newId !== 'function') throw new TypeError('`newId(prefix)` is required');
}

async function preconditions(store, seedDoc) {
  if (seedDoc !== undefined) {
    const s = await validateSeedDefaults(seedDoc);
    if (!s.valid) return { ok: false, code: 'SEED_INVALID', errors: s.errors };
  }
  const v = await validateStore(store);
  if (!v.valid) return { ok: false, code: 'INVALID_STORE', errors: v.errors };
  return null;
}

async function finalize(next, extra) {
  const v = await validateStore(next);
  if (!v.valid) return { ok: false, code: 'RESULT_INVALID', errors: v.errors };
  return { ok: true, store: next, ...extra };
}

const seedMaps = (seedDoc) => ({
  ex: new Map(seedDoc.exercises.map((e) => [e.id, e])),
  tpl: new Map(seedDoc.templates.map((t) => [t.id, t])),
});

const usedIds = (store) => {
  const ids = new Set();
  for (const e of store?.exercises ?? []) if (e && typeof e.id === 'string') ids.add(e.id);
  for (const t of store?.templates ?? []) {
    if (t && typeof t.id === 'string') ids.add(t.id);
    for (const it of t?.items ?? []) if (it && typeof it.id === 'string') ids.add(it.id);
  }
  return ids;
};

// ---- applySeeds -------------------------------------------------------------------------------------

/**
 * Applies the defaults per the approved rules. Exercises first, then templates. Idempotent.
 * report: { added[], markedExisting[], upgradeOffers[], skippedTombstoned[], blockedTemplates[], warnings[] }
 */
export async function applySeeds(store, seedDoc, { now } = {}) {
  requireNow(now);
  const bad = await preconditions(store, seedDoc);
  if (bad) return bad;

  const next = structuredClone(store);
  const applied = next.meta.seedsApplied;
  const tomb = next.meta.seedTombstones;
  const report = { added: [], markedExisting: [], upgradeOffers: [], skippedTombstoned: [], blockedTemplates: [], warnings: [] };

  const handleExisting = (kind, item, list) => {
    if (item.id in tomb) {
      report.skippedTombstoned.push({ kind, id: item.id });
      return true;
    }
    if (item.id in applied) {
      if (item.version > applied[item.id]) report.upgradeOffers.push({ kind, id: item.id, handledVersion: applied[item.id], availableVersion: item.version });
      return true;
    }
    const existing = list.find((x) => x.id === item.id);
    if (existing) {
      const recorded = existing.seed?.version ?? item.version;
      if (existing.seed === null) report.warnings.push({ code: 'W-SEED-ID-UNMARKED', id: item.id, message: 'an entity with this seed ID exists without a seed reference; marked as handled' });
      applied[item.id] = recorded;
      report.markedExisting.push({ kind, id: item.id, recordedVersion: recorded });
      if (item.version > recorded) report.upgradeOffers.push({ kind, id: item.id, handledVersion: recorded, availableVersion: item.version });
      return true;
    }
    return false;
  };

  for (const e of seedDoc.exercises) {
    if (handleExisting('exercise', e, next.exercises)) continue;
    next.exercises.push(exerciseFromSeed(e, now));
    applied[e.id] = e.version;
    report.added.push({ kind: 'exercise', id: e.id });
  }

  for (const t of seedDoc.templates) {
    if (handleExisting('template', t, next.templates)) continue;
    const exById = new Map(next.exercises.map((x) => [x.id, x]));
    const missing = [];
    const archived = [];
    for (const it of t.items) {
      const ex = exById.get(it.exerciseId);
      if (!ex) missing.push(it.exerciseId);
      else if (ex.archived) archived.push(it.exerciseId);
    }
    if (missing.length) {
      report.blockedTemplates.push({ id: t.id, code: 'SEED_DEPENDENCY_MISSING', dependencies: [...new Set(missing)].sort() });
      continue;
    }
    const taken = usedIds(next);
    const occupied = t.items.map((it) => it.id).filter((id) => taken.has(id)).sort();
    if (occupied.length) {
      report.blockedTemplates.push({ id: t.id, code: 'SEED_ID_OCCUPIED', occupiedIds: occupied });
      continue;
    }
    next.templates.push(templateFromSeed(t, now));
    applied[t.id] = t.version;
    report.added.push({ kind: 'template', id: t.id });
    for (const id of [...new Set(archived)]) report.warnings.push({ code: 'W-ARCHIVED-REF', id: t.id, exerciseId: id, message: 'template references an archived exercise' });
  }

  const changed = report.added.length > 0 || report.markedExisting.length > 0;
  return finalize(next, { changed, report });
}

// ---- references and deletion ----------------------------------------------------------------------------

/**
 * Every genuine reference to an exercise ID. Rule R-QREF: only Q-REMOVED entries
 * (reason "performance_removed_by_user", whose raw is a validated Performance) count, via raw.exerciseId.
 * Q-IMPORT entries are NEVER references, regardless of their raw content (raw is pre-mapping source data).
 */
export function findExerciseReferences(store, exerciseId) {
  const refs = [];
  (store.sessions ?? []).forEach((s, i) => s.performances.forEach((p, j) => {
    if (p.exerciseId === exerciseId) refs.push({ kind: 'session_performance', path: `$.sessions[${i}].performances[${j}]` });
  }));
  if (store.activeSession) {
    store.activeSession.session.performances.forEach((p, j) => {
      if (p.exerciseId === exerciseId) refs.push({ kind: 'active_performance', path: `$.activeSession.session.performances[${j}]` });
    });
  }
  (store.templates ?? []).forEach((t, i) => t.items.forEach((it, j) => {
    if (it.exerciseId === exerciseId) refs.push({ kind: 'template_item', path: `$.templates[${i}].items[${j}]` });
  }));
  (store.manualRecords ?? []).forEach((r, i) => { if (r.exerciseId === exerciseId) refs.push({ kind: 'manual_record', path: `$.manualRecords[${i}]` }); });
  (store.goals ?? []).forEach((g, i) => { if (g.exerciseId === exerciseId) refs.push({ kind: 'goal', path: `$.goals[${i}]` }); });
  (store.exercises ?? []).forEach((e, i) => { if (e.mergedInto === exerciseId) refs.push({ kind: 'merged_into', path: `$.exercises[${i}]` }); });
  (store.quarantine ?? []).forEach((q, i) => {
    if (q.reason === 'performance_removed_by_user' && q.raw?.exerciseId === exerciseId) refs.push({ kind: 'quarantine_removed_performance', path: `$.quarantine[${i}]` });
  });
  return refs;
}

/** Deletes a SEEDED exercise or template and writes its tombstone in the same result. */
export async function deleteSeededEntity(store, id, { now } = {}) {
  requireNow(now);
  const bad = await preconditions(store);
  if (bad) return bad;
  const ex = store.exercises.find((x) => x.id === id);
  const tpl = store.templates.find((x) => x.id === id);
  const entity = ex ?? tpl;
  if (!entity) return { ok: false, code: 'NOT_FOUND', id };
  if (entity.seed === null) return { ok: false, code: 'NOT_SEEDED', id };
  if (ex) {
    const refs = findExerciseReferences(store, id);
    if (refs.length) return { ok: false, code: 'EXERCISE_REFERENCED', id, references: refs };
  }
  const next = structuredClone(store);
  if (ex) next.exercises = next.exercises.filter((x) => x.id !== id);
  else next.templates = next.templates.filter((x) => x.id !== id);
  next.meta.seedTombstones[id] = { deletedAt: now, versionAtDeletion: entity.seed.version };
  if (!(id in next.meta.seedsApplied)) next.meta.seedsApplied[id] = entity.seed.version;
  return finalize(next, { deleted: id });
}

// ---- restoreDefault (the ONLY way a tombstone is removed — SD3) -------------------------------------------

/**
 * Error precedence (approved):
 *   SEED_INVALID → store validation, where an INV-SD1 violation that is fully explained by an occupied
 *   restore-target ID yields SEED_ID_OCCUPIED (any other structural error yields INVALID_STORE, never masked)
 *   → SEED_NOT_TOMBSTONED → SEED_NOT_AVAILABLE → SEED_DEPENDENCY_MISSING → SEED_ID_OCCUPIED
 *   → NEEDS_CONFIRMATION → restore (validated).
 * In every non-ok case the input store is unchanged and the tombstone remains.
 */
export async function restoreDefault(store, seedDoc, id, { confirmDependencies = false, now } = {}) {
  requireNow(now);
  const seedCheck = await validateSeedDefaults(seedDoc);
  if (!seedCheck.valid) return { ok: false, code: 'SEED_INVALID', errors: seedCheck.errors };
  const seeds = seedMaps(seedDoc);
  const tombs = store?.meta?.seedTombstones ?? {};
  const seedTpl = seeds.tpl.get(id);
  const exIdsInStore = new Set((store?.exercises ?? []).map((e) => e?.id));

  // IDs this restore would add (computed leniently so it also works on an SD1-violating store).
  const deps = seedTpl
    ? [...new Set(seedTpl.items.map((it) => it.exerciseId))].filter((x) => x in tombs && seeds.ex.has(x))
    : [];
  const targetIds = [id, ...(seedTpl ? seedTpl.items.map((it) => it.id) : []), ...(confirmDependencies ? deps : [])];
  const taken = usedIds(store);
  const occupied = [...new Set(targetIds.filter((x) => taken.has(x)))].sort();

  const v = await validateStore(store);
  if (!v.valid) {
    const explained = occupied.length > 0 && v.errors.every((e) => e.code === 'INV-SD1' && occupied.some((o) => e.path === `$.meta.seedTombstones.${o}`));
    if (explained) return { ok: false, code: 'SEED_ID_OCCUPIED', id, occupiedIds: occupied };
    return { ok: false, code: 'INVALID_STORE', errors: v.errors };
  }

  if (!(id in tombs)) return { ok: false, code: 'SEED_NOT_TOMBSTONED', id };
  const seedEx = seeds.ex.get(id);
  if (!seedEx && !seedTpl) return { ok: false, code: 'SEED_NOT_AVAILABLE', id };

  const warnings = [];
  if (seedTpl) {
    const missing = [];
    for (const it of seedTpl.items) {
      if (exIdsInStore.has(it.exerciseId)) {
        if (store.exercises.find((e) => e.id === it.exerciseId).archived) warnings.push({ code: 'W-ARCHIVED-REF', exerciseId: it.exerciseId });
      } else if (!(it.exerciseId in tombs && seeds.ex.has(it.exerciseId))) missing.push(it.exerciseId);
    }
    if (missing.length) return { ok: false, code: 'SEED_DEPENDENCY_MISSING', id, dependencies: [...new Set(missing)].sort() };
  }
  if (occupied.length) return { ok: false, code: 'SEED_ID_OCCUPIED', id, occupiedIds: occupied };
  if (seedTpl && deps.length && !confirmDependencies) {
    return { ok: false, code: 'NEEDS_CONFIRMATION', id, dependencies: deps.sort().map((d) => ({ id: d, name: seeds.ex.get(d).name })) };
  }

  const next = structuredClone(store);
  const restored = [];
  const restoreExercise = (e) => {
    next.exercises.push(exerciseFromSeed(e, now));
    delete next.meta.seedTombstones[e.id];
    next.meta.seedsApplied[e.id] = e.version;
    restored.push(e.id);
  };
  if (seedEx) restoreExercise(seedEx);
  else {
    for (const d of deps.sort()) restoreExercise(seeds.ex.get(d));
    next.templates.push(templateFromSeed(seedTpl, now));
    delete next.meta.seedTombstones[seedTpl.id];
    next.meta.seedsApplied[seedTpl.id] = seedTpl.version;
    restored.push(seedTpl.id);
  }
  return finalize(next, { restored, warnings });
}

// ---- upgrade offers ------------------------------------------------------------------------------------------

function upgradeOffer(store, seeds, id) {
  const item = seeds.ex.get(id) ?? seeds.tpl.get(id);
  if (!item || id in store.meta.seedTombstones) return null;
  const handled = store.meta.seedsApplied[id];
  if (handled === undefined || !(item.version > handled)) return null;
  return item;
}

/** Accepts a higher default version as a NEW entity named "<name> (Copy)". The original is untouched. */
export async function acceptSeedUpgradeAsCopy(store, seedDoc, id, { now, newId } = {}) {
  requireNow(now);
  requireNewId(newId);
  const bad = await preconditions(store, seedDoc);
  if (bad) return bad;
  const seeds = seedMaps(seedDoc);
  const item = upgradeOffer(store, seeds, id);
  if (!item) return { ok: false, code: 'SEED_UPGRADE_NOT_AVAILABLE', id };

  const next = structuredClone(store);
  const warnings = [];
  let copyId;
  if (seeds.ex.has(id)) {
    const copy = exerciseFromSeed(item, now);
    copyId = newId('ex');
    Object.assign(copy, { id: copyId, name: `${item.name}${COPY_SUFFIX}`, seed: null, isCustom: true });
    next.exercises.push(copy);
  } else {
    const exById = new Map(next.exercises.map((x) => [x.id, x]));
    const missing = item.items.map((it) => it.exerciseId).filter((x) => !exById.has(x));
    if (missing.length) return { ok: false, code: 'SEED_DEPENDENCY_MISSING', id, dependencies: [...new Set(missing)].sort() };
    for (const it of item.items) if (exById.get(it.exerciseId).archived) warnings.push({ code: 'W-ARCHIVED-REF', exerciseId: it.exerciseId });
    const copy = templateFromSeed(item, now);
    copyId = newId('tpl');
    Object.assign(copy, { id: copyId, name: `${item.name}${COPY_SUFFIX}`, seed: null });
    copy.items = copy.items.map((it) => ({ ...it, id: newId('tpi') }));
    next.templates.push(copy);
  }
  next.meta.seedsApplied[id] = item.version;
  return finalize(next, { copyId, warnings });
}

/** Dismisses a higher default version: nothing is created; the version is recorded as handled. */
export async function dismissSeedUpgrade(store, seedDoc, id) {
  const bad = await preconditions(store, seedDoc);
  if (bad) return bad;
  const item = upgradeOffer(store, seedMaps(seedDoc), id);
  if (!item) return { ok: false, code: 'SEED_UPGRADE_NOT_AVAILABLE', id };
  const next = structuredClone(store);
  next.meta.seedsApplied[id] = item.version;
  return finalize(next, {});
}
