// Manage (Step 2d.7): domain functions for templates, exercises and personal settings, used through
// app.commit (actions.js). Validation (shape, ids, order, measurement rules) and the write-boundary
// rules (D8: unresolved exercises and exercises of protected performances never change) still apply
// to every commit. Nothing is deleted: templates and exercises are archived. Saved sessions are never
// touched here (they keep their own name and measurement snapshots).
import { createExercise, createMeasurement, createTemplate, createTemplateItem } from '../schema/factories.js';
import { ALLOWED_SET_FIELDS, ALLOWED_LOAD_BASIS, LOAD_UNITS, MEASUREMENT_TYPES, TYPES_WITH_REPS } from '../schema/constants.js';
import { DomainError } from './active-session.js';

const err = (code, details) => new DomainError(code, details);
const requireCtx = (ctx) => {
  if (!ctx || typeof ctx.now !== 'string' || typeof ctx.newId !== 'function') throw new TypeError('ctx { now, newId } required');
};
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const sameName = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

/** Measurement types a user can create (not 'unresolved'). */
export const CREATABLE_TYPES = Object.freeze(MEASUREMENT_TYPES.filter((t) => t !== 'unresolved'));
export const loadBasisOptions = (type) => ALLOWED_LOAD_BASIS[type] ?? [];
export const hasLoad = (type) => (ALLOWED_SET_FIELDS[type] ?? []).includes('load');

// ---- exercises ------------------------------------------------------------------------------------
/** A custom exercise. Names are unique (case-insensitive) among exercises that are not archived. */
export function createCustomExercise(store, { name, group = null, equipment = null, type, loadBasis = null, repsPerSide = false } = {}, ctx) {
  requireCtx(ctx);
  const n = norm(name);
  if (!n) throw err('RESULT_INVALID', { field: 'name' });
  if (!CREATABLE_TYPES.includes(type)) throw err('RESULT_INVALID', { field: 'type' });
  if (store.exercises.some((e) => !e.archived && sameName(e.name, n))) throw err('NAME_EXISTS', { name: n });
  const opts = loadBasisOptions(type);
  const basis = opts.length ? (loadBasis ?? opts[0]) : null;
  if (opts.length && !opts.includes(basis)) throw err('RESULT_INVALID', { field: 'loadBasis' });
  const measurement = createMeasurement({
    type,
    loadBasis: basis,
    loadUnit: hasLoad(type) ? store.settings.loadUnit : null,
    repsBasis: repsPerSide && TYPES_WITH_REPS.includes(type) ? 'per_side' : null,
  });
  store.exercises.push(createExercise({ id: ctx.newId('ex'), name: n, measurement, group: norm(group) || null, equipment: norm(equipment) || null, isCustom: true, now: ctx.now }));
  return store;
}

/** Renames an exercise (its history keeps the name snapshots it was logged with). */
export function renameExercise(store, { exerciseId, name } = {}, ctx) {
  requireCtx(ctx);
  const ex = store.exercises.find((e) => e.id === exerciseId);
  if (!ex) throw err('NOT_FOUND', { exerciseId });
  const n = norm(name);
  if (!n) throw err('RESULT_INVALID', { field: 'name' });
  if (store.exercises.some((e) => e.id !== exerciseId && !e.archived && sameName(e.name, n))) throw err('NAME_EXISTS', { name: n });
  ex.name = n;
  ex.updatedAt = ctx.now;
  return store;
}

/** Archives / restores an exercise: hidden from pickers, history unaffected. */
export function setExerciseArchived(store, { exerciseId, archived } = {}, ctx) {
  requireCtx(ctx);
  const ex = store.exercises.find((e) => e.id === exerciseId);
  if (!ex) throw err('NOT_FOUND', { exerciseId });
  if (typeof archived !== 'boolean') throw err('RESULT_INVALID', { field: 'archived' });
  ex.archived = archived;
  ex.updatedAt = ctx.now;
  return store;
}

// ---- templates ------------------------------------------------------------------------------------
/**
 * Creates (templateId null) or replaces a template's name and items, in the given order.
 * items: [{ id?, exerciseId, plannedSets, targetReps: {min,max}|null, targetNote: string|null }].
 * Existing item ids are kept; new items get new ids. Unknown or unresolved exercises are refused.
 */
export function saveTemplate(store, { templateId = null, name, items = [] } = {}, ctx) {
  requireCtx(ctx);
  const n = norm(name);
  if (!n) throw err('RESULT_INVALID', { field: 'name' });
  const t = templateId ? store.templates.find((x) => x.id === templateId) : null;
  if (templateId && !t) throw err('NOT_FOUND', { templateId });
  const keep = new Set((t?.items ?? []).map((i) => i.id));
  const built = items.map((it, i) => {
    const ex = store.exercises.find((e) => e.id === it.exerciseId);
    if (!ex) throw err('NOT_FOUND', { exerciseId: it.exerciseId });
    if (ex.measurement.type === 'unresolved') throw err('UNRESOLVED_EXERCISE', { exerciseId: it.exerciseId });
    const tr = it.targetReps ?? null;
    if (tr !== null && !(Number.isSafeInteger(tr.min) && Number.isSafeInteger(tr.max) && tr.min >= 1 && tr.max >= tr.min)) throw err('RESULT_INVALID', { field: `items[${i}].targetReps` });
    if (!Number.isSafeInteger(it.plannedSets) || it.plannedSets < 0 || it.plannedSets > 20) throw err('RESULT_INVALID', { field: `items[${i}].plannedSets` });
    const note = norm(it.targetNote) || null;
    return createTemplateItem({ id: it.id && keep.has(it.id) ? it.id : ctx.newId('tpi'), exerciseId: it.exerciseId, order: i + 1, plannedSets: it.plannedSets, targetReps: tr === null ? null : { min: tr.min, max: tr.max }, targetNote: note });
  });
  if (t) {
    t.name = n;
    t.items = built;
    t.updatedAt = ctx.now;
  } else {
    store.templates.push(createTemplate({ id: ctx.newId('tpl'), name: n, items: built, now: ctx.now }));
  }
  return store;
}

export function setTemplateArchived(store, { templateId, archived } = {}, ctx) {
  requireCtx(ctx);
  const t = store.templates.find((x) => x.id === templateId);
  if (!t) throw err('NOT_FOUND', { templateId });
  if (typeof archived !== 'boolean') throw err('RESULT_INVALID', { field: 'archived' });
  t.archived = archived;
  t.updatedAt = ctx.now;
  return store;
}

// ---- settings ----------------------------------------------------------------------------------------
/** The default load unit for new custom exercises. */
export function setLoadUnit(store, { unit } = {}, ctx) {
  requireCtx(ctx);
  if (!LOAD_UNITS.includes(unit)) throw err('RESULT_INVALID', { field: 'unit' });
  store.settings.loadUnit = unit;
  return store;
}

/**
 * The user's measured bodyweight (used as the default of new workouts, D10). value null clears it.
 * A value typed here is the user's own measurement: confirmed.
 */
export function setBodyweight(store, { value, unit = 'kg' } = {}, ctx) {
  requireCtx(ctx);
  if (value === null) {
    store.settings.bodyweight = { value: null, unit: null, confirmed: false, updatedAt: ctx.now };
    return store;
  }
  if (!(typeof value === 'number' && Number.isFinite(value) && value > 20 && value < 400) || !LOAD_UNITS.includes(unit)) throw err('RESULT_INVALID', { field: 'bodyweight' });
  store.settings.bodyweight = { value, unit, confirmed: true, updatedAt: ctx.now };
  return store;
}
