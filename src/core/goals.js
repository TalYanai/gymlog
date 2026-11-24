// Goals (Step 2d.6): domain functions over a draft store, used through app.commit (actions.js).
// The target fields per metric and their compatibility with the exercise are enforced by validation
// (INV-11); these functions only build and change goal records. Nothing is deleted: a goal is archived.
import { createGoal } from '../schema/factories.js';
import { GOAL_METRICS } from '../schema/constants.js';
import { compatibleTypes } from '../schema/validate.js';
import { DomainError } from './active-session.js';

const requireCtx = (ctx) => {
  if (!ctx || typeof ctx.now !== 'string' || typeof ctx.newId !== 'function') throw new TypeError('ctx { now, newId } required');
};

/** The goal metrics that fit an exercise's measurement type. */
export const goalMetricsFor = (type) => GOAL_METRICS.filter((m) => compatibleTypes(m).includes(type));

/** Adds a manual goal. target: per metric (see fields goalTargets); deadline YYYY-MM-DD or null. */
export function addGoal(store, { exerciseId, metric, target, deadline = null } = {}, ctx) {
  requireCtx(ctx);
  const ex = store.exercises.find((e) => e.id === exerciseId);
  if (!ex) throw new DomainError('NOT_FOUND', { exerciseId });
  if (!goalMetricsFor(ex.measurement.type).includes(metric)) throw new DomainError('RESULT_INVALID', { field: 'metric' });
  store.goals.push(createGoal({ id: ctx.newId('goal'), exerciseId, metric, target, deadline, source: 'manual', now: ctx.now }));
  return store;
}

/** Archives (or restores) a goal. */
export function setGoalArchived(store, { goalId, archived } = {}, ctx) {
  requireCtx(ctx);
  const g = store.goals.find((x) => x.id === goalId);
  if (!g) throw new DomainError('NOT_FOUND', { goalId });
  if (typeof archived !== 'boolean') throw new DomainError('RESULT_INVALID', { field: 'archived' });
  g.archived = archived;
  g.updatedAt = ctx.now;
  return store;
}
