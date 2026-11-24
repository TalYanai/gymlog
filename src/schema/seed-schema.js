// validateSeedDefaults — strict schema for the public seed file (Phase 2a R8 layer 2, G2).
//
// The seed contains only public defaults: exercise definitions and template structures (D8 approved
// keeping template structures public). It never contains personal data (prefill loads, records, goals,
// bodyweight, personal_seed) or progression rules/thresholds (G2). Any field outside the allowlist is
// rejected; known personal/progression fields are reported with the more specific code SEED-FORBIDDEN.
//
// Fields set by applySeeds itself (isCustom, seed, prefill, archived, mergedInto, timestamps) are not
// allowed in the seed file.

import { FORMATS, SCHEMA_VERSION } from './constants.js';
import { createEmptyStore } from './factories.js';
import { validateStore } from './validate.js';

export const SEED_FIELDS = Object.freeze({
  root: Object.freeze(['format', 'formatVersion', 'schemaVersion', 'exercises', 'templates']),
  exercise: Object.freeze(['id', 'version', 'name', 'aliases', 'group', 'equipment', 'variantGroup', 'measurement']),
  template: Object.freeze(['id', 'version', 'name', 'items']),
  item: Object.freeze(['id', 'exerciseId', 'order', 'plannedSets', 'targetReps', 'targetNote']),
});

/** Known personal-data and progression field names (rejected anywhere in the seed). */
export const FORBIDDEN_SEED_FIELDS = Object.freeze([
  'prefill', 'load', 'manualRecords', 'goals', 'bodyweight', 'source',
  'progression', 'progressionRule', 'progressionRules', 'threshold', 'thresholds', 'suggestion', 'suggestions', 'nextWeight',
]);
export const FORBIDDEN_SEED_VALUES = Object.freeze(['personal_seed']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const T = '1970-01-01T00:00:00.000Z';

/** Converts a seed exercise/template into the store entity applySeeds would create. */
export function exerciseFromSeed(e, now) {
  return {
    id: e.id, name: e.name, aliases: [...e.aliases], group: e.group, equipment: e.equipment,
    measurement: { ...e.measurement }, variantGroup: e.variantGroup,
    isCustom: false, seed: { id: e.id, version: e.version }, prefill: null,
    archived: false, mergedInto: null, createdAt: now, updatedAt: now,
  };
}
export function templateFromSeed(t, now) {
  return {
    id: t.id, name: t.name, archived: false, seed: { id: t.id, version: t.version },
    createdAt: now, updatedAt: now, items: t.items.map((it) => ({ ...it, targetReps: it.targetReps === null ? null : { ...it.targetReps } })),
  };
}

export async function validateSeedDefaults(doc) {
  const errors = [];
  const err = (code, path, message) => errors.push({ code, path, message });

  // Forbidden names/values anywhere (deep), so nested personal data cannot slip through.
  const scan = (v, path) => {
    if (Array.isArray(v)) return v.forEach((x, i) => scan(x, `${path}[${i}]`));
    if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_SEED_FIELDS.includes(k)) err('SEED-FORBIDDEN', `${path}.${k}`, 'personal-data or progression field is not allowed in the public seed');
        scan(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === 'string' && FORBIDDEN_SEED_VALUES.includes(v)) err('SEED-FORBIDDEN', path, `value "${v}" is not allowed in the public seed`);
  };

  const keys = (obj, path, allowed) => {
    if (!isObj(obj)) {
      err('SEED-SHAPE', path, 'must be an object');
      return false;
    }
    for (const k of allowed) if (!(k in obj)) err('SEED-SHAPE', `${path}.${k}`, 'required field missing');
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k) && !FORBIDDEN_SEED_FIELDS.includes(k)) err('SEED-SHAPE', `${path}.${k}`, 'unknown field');
    }
    return true;
  };

  if (!keys(doc, '$', SEED_FIELDS.root)) return { valid: false, errors };
  scan(doc, '$');
  if (doc.format !== FORMATS.seedDefaults) err('SEED-SHAPE', '$.format', `must be "${FORMATS.seedDefaults}"`);
  if (doc.formatVersion !== FORMATS.seedDefaultsVersion) err('SEED-SHAPE', '$.formatVersion', `must be ${FORMATS.seedDefaultsVersion}`);
  if (doc.schemaVersion !== SCHEMA_VERSION) err('SEED-SHAPE', '$.schemaVersion', `must be ${SCHEMA_VERSION}`);
  if (!Array.isArray(doc.exercises) || !Array.isArray(doc.templates)) {
    err('SEED-SHAPE', '$', 'exercises and templates must be arrays');
    return { valid: false, errors };
  }

  const exIds = new Set();
  doc.exercises.forEach((e, i) => {
    const p = `$.exercises[${i}]`;
    if (!keys(e, p, SEED_FIELDS.exercise)) return;
    if (!Number.isSafeInteger(e.version) || e.version < 1) err('SEED-SHAPE', `${p}.version`, 'must be an integer ≥ 1');
    if (e.measurement?.type === 'unresolved') err('SEED-SHAPE', `${p}.measurement.type`, 'seed exercises cannot be unresolved');
    if (typeof e.id === 'string') exIds.add(e.id);
  });
  doc.templates.forEach((t, i) => {
    const p = `$.templates[${i}]`;
    if (!keys(t, p, SEED_FIELDS.template)) return;
    if (!Number.isSafeInteger(t.version) || t.version < 1) err('SEED-SHAPE', `${p}.version`, 'must be an integer ≥ 1');
    if (!Array.isArray(t.items)) return err('SEED-SHAPE', `${p}.items`, 'must be an array');
    t.items.forEach((it, j) => {
      if (!keys(it, `${p}.items[${j}]`, SEED_FIELDS.item)) return;
      if (!exIds.has(it.exerciseId)) err('SEED-SHAPE', `${p}.items[${j}].exerciseId`, 'must reference an exercise defined in the same seed file');
    });
  });
  if (errors.length) return { valid: false, errors };

  // The entities applySeeds would create must satisfy every stored-data invariant
  // (IDs, prefixes, uniqueness, measurement rules incl. D6/D17/INV-13, template rules INV-6/7, P1a).
  const probe = createEmptyStore({ now: T });
  probe.exercises = doc.exercises.map((e) => exerciseFromSeed(e, T));
  probe.templates = doc.templates.map((t) => templateFromSeed(t, T));
  const r = await validateStore(probe);
  for (const e of r.errors) {
    err('SEED-INVARIANT', e.path.replace('$.exercises', '$.exercises').replace('$.templates', '$.templates'), `${e.code}: ${e.message}`);
  }
  return { valid: errors.length === 0, errors };
}
