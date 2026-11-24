// UI write actions (Step 2d.0). The ONLY module in src/ui that calls app.commit (static test UI-S1):
// every change goes through a domain function from src/core, never through an inline mutator.
import * as AS from '../core/active-session.js';
import * as GOALS from '../core/goals.js';
import * as MANAGE from '../core/manage.js';
import * as RECORDS from '../core/records.js';

/** @param {object} app the frozen facade from bootstrap() */
export function createActions(app) {
  /**
   * Saves typed values of one set and, optionally, its completion — in ONE commit (2d.3 ✓ rule).
   * Refused (NOT_FOUND) when the active workout is no longer the one the values were typed in.
   */
  function commitSetValues({ sessionId, performanceId, setId }, values, { completed } = {}) {
    return app.commit((s, c) => {
      if (s.activeSession?.session?.id !== sessionId) throw new AS.DomainError('NOT_FOUND', { sessionId });
      if (Object.keys(values).length > 0) AS.updateSet(s, { performanceId, setId, values }, c);
      if (completed !== undefined) AS.setSetCompleted(s, { performanceId, setId, completed }, c);
      return s;
    });
  }

  /**
   * Step 2d.2: starts a workout on the given local date — from a template (one tap, no start screen)
   * or empty. The template's exercise order and planned sets come from AS.startNew.
   * The workout must be the one the user is looking at: refused if another one is already active.
   */
  const startWorkout = ({ templateId = null, date }) => app.commit((s, c) => AS.startNew(s, { date, templateId }, c));

  /** Adds an exercise to the active workout (variable workouts such as HYROX). */
  const addExercise = ({ sessionId, exerciseId }) => app.commit((s, c) => {
    if (s.activeSession?.session?.id !== sessionId) throw new AS.DomainError('NOT_FOUND', { sessionId });
    return AS.addExercise(s, { exerciseId }, c);
  });

  /** Cancels the active workout that the user confirmed cancelling (nothing is saved to history). */
  const cancelWorkout = ({ sessionId }) => app.commit((s, c) => {
    if (s.activeSession?.session?.id !== sessionId) throw new AS.DomainError('NOT_FOUND', { sessionId });
    return AS.cancelActiveSession(s, c);
  });

  /** Step 2d.3: a change to the active workout the user is looking at (refused if it is another one). */
  const onActive = (sessionId, change) => app.commit((s, c) => {
    if (s.activeSession?.session?.id !== sessionId) throw new AS.DomainError('NOT_FOUND', { sessionId });
    return change(s, c);
  });
  const addSet = ({ sessionId, performanceId }) => onActive(sessionId, (s, c) => AS.addSet(s, { performanceId }, c));
  const removeSet = ({ sessionId, performanceId, setId }) => onActive(sessionId, (s, c) => AS.removeSet(s, { performanceId, setId }, c));
  const removeExercise = ({ sessionId, performanceId }) => onActive(sessionId, (s, c) => AS.removePerformance(s, { performanceId }, c));
  const setNote = ({ sessionId, performanceId, note }) => onActive(sessionId, (s, c) => AS.setPerformanceNote(s, { performanceId, note }, c));
  /**
   * Saves the workout to history (core commitSession). confirmDrop must be true when the user
   * confirmed the finish summary that drops something; otherwise core refuses (NEEDS_CONFIRMATION).
   */
  const finishWorkout = ({ sessionId, confirmDrop }) => onActive(sessionId, (s, c) => AS.commitSession(s, { confirmDrop: confirmDrop === true }, c));

  // ---- Step 2d.4: editing saved workouts -------------------------------------------------------------
  /** Opens a saved workout for editing (core startEdit: a copy; the saved session is untouched until saved). */
  const startEdit = ({ sessionId }) => app.commit((s, c) => AS.startEdit(s, { sessionId }, c));
  /** Date / note of the workout being logged or edited (core setSessionFields). */
  const setSessionFields = ({ sessionId, date, note }) => onActive(sessionId, (s, c) => AS.setSessionFields(s, { date, note }, c));
  /**
   * Moves every preserved (unresolved) performance of the conflicting edit to quarantine, ONE commit
   * per performance (the write boundary accepts a quarantine entry only together with the removal of
   * that performance from the active workout, and TR-SAVENEW copies the active workout as it stands
   * after those commits). Stops at the first refusal; each step on its own loses nothing.
   */
  async function quarantinePreserved(sessionId) {
    const a = app.snapshot().store?.activeSession;
    for (const id of [...(a?.preservedPerformanceIds ?? [])]) {
      if (!a.session.performances.some((p) => p.id === id)) continue;
      const r = await onActive(sessionId, (s, c) => AS.moveToQuarantine(s, { performanceId: id }, c));
      if (!r.ok || r.outcome === 'unsaved') return r;
    }
    return { ok: true };
  }
  /**
   * Edit conflict (the saved workout changed or disappeared meanwhile): keep the user's edit as a NEW
   * workout (TR-SAVENEW), after its unresolved performances are in quarantine.
   */
  async function resolveConflictSaveAsNew({ sessionId }) {
    const q = await quarantinePreserved(sessionId);
    if (!q.ok || q.outcome === 'unsaved') return q;
    return onActive(sessionId, (s, c) => AS.saveAsNew(s, c));
  }
  /** Edit conflict: drop the user's edit; the newer saved data stays as it is (TR-CANCEL). */
  async function resolveConflictDiscard({ sessionId }) {
    const q = await quarantinePreserved(sessionId);
    if (!q.ok || q.outcome === 'unsaved') return q;
    return onActive(sessionId, (s, c) => AS.cancelActiveSession(s, c));
  }

  /** Launch: corrections of saved / imported workouts during an edit (core/active-session.js). */
  const changeExercise = ({ sessionId, performanceId, exerciseId, confirmClear = false }) => onActive(sessionId, (s, c) => AS.changePerformanceExercise(s, { performanceId, exerciseId, confirmClear }, c));
  const moveSet = ({ sessionId, performanceId, setId, toPerformanceId }) => onActive(sessionId, (s, c) => AS.moveSet(s, { performanceId, setId, toPerformanceId }, c));
  /** Assigns an unresolved imported performance to an exercise (original → quarantine, one commit). */
  const resolvePerformance = ({ sessionId, performanceId, exerciseId, sets }) => onActive(sessionId, (s, c) => AS.resolvePerformance(s, { performanceId, exerciseId, sets }, c));

  /** Step 2d.5: starts a new workout copying a saved one's structure and values (core startNew fromSessionId). */
  const repeatWorkout = ({ sessionId, date }) => app.commit((s, c) => AS.startNew(s, { date, fromSessionId: sessionId }, c));

  /** Step 2d.6: goals (core/goals.js; targets validated by the Store, INV-11). */
  const addGoal = ({ exerciseId, metric, target, deadline }) => app.commit((s, c) => GOALS.addGoal(s, { exerciseId, metric, target, deadline }, c));
  const setGoalArchived = ({ goalId, archived }) => app.commit((s, c) => GOALS.setGoalArchived(s, { goalId, archived }, c));

  /** Manual personal records (core/records.js; validated by Store INV-10). */
  const addManualRecord = (args) => app.commit((s, c) => RECORDS.addManualRecord(s, args, c));
  /** Deletes a saved workout. Imported (Garmin/CSV/V1) workouts need confirmImported; the import's source snapshot is untouched. */
  const deleteWorkout = ({ sessionId, confirmImported = false }) => app.deleteSession(sessionId, { confirmImported });
  /** Sync review: puts this device's saved version of a workout back (replaces the shared one; it then syncs as a normal edit). */
  const restoreSessionVersion = ({ payload }) => app.commit((s) => {
    const i = s.sessions.findIndex((x) => x.id === payload.id);
    if (i >= 0) s.sessions[i] = structuredClone(payload); else s.sessions.push(structuredClone(payload));
    return s;
  });
  const updateManualRecord = (args) => app.commit((s, c) => RECORDS.updateManualRecord(s, args, c));
  const deleteManualRecord = (args) => app.commit((s, c) => RECORDS.deleteManualRecord(s, args, c));

  /** Step 2d.7: templates, exercises, settings (core/manage.js). */
  const c1 = (fn) => (args) => app.commit((s, c) => fn(s, args, c));
  const manage = Object.freeze({
    createCustomExercise: c1(MANAGE.createCustomExercise),
    renameExercise: c1(MANAGE.renameExercise),
    setExerciseArchived: c1(MANAGE.setExerciseArchived),
    saveTemplate: c1(MANAGE.saveTemplate),
    setTemplateArchived: c1(MANAGE.setTemplateArchived),
    setLoadUnit: c1(MANAGE.setLoadUnit),
    setBodyweight: c1(MANAGE.setBodyweight),
  });

  return Object.freeze({
    manage,
    addGoal,
    setGoalArchived,
    addManualRecord,
    updateManualRecord,
    deleteWorkout,
    restoreSessionVersion,
    deleteManualRecord,
    repeatWorkout,
    startEdit,
    setSessionFields,
    resolveConflictSaveAsNew,
    resolveConflictDiscard,
    commitSetValues,
    startWorkout,
    addExercise,
    cancelWorkout,
    addSet,
    removeSet,
    changeExercise,
    moveSet,
    resolvePerformance,
    removeExercise,
    setNote,
    finishWorkout,
    retrySave: () => app.retrySave(),
    reload: (opts) => app.reload(opts),
  });
}
