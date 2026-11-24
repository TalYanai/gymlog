import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers.js';
import { createInputBuffer } from '../src/ui/input-buffer.js';
import { hasUnsavedWork, activeWorkoutModel, finishModel } from '../src/ui/workout-model.js';
import { exerciseRecords } from '../src/derive/records.js';
import { distanceResults } from '../src/derive/tenk.js';
import { goalStatus } from '../src/derive/goals.js';
import { sessionVolume } from '../src/derive/volume.js';
import { progressExercises, exerciseProgress, goalsModel, GOAL_EXERCISES, chartMetrics, chartSeries } from '../src/ui/progress-model.js';
import { historyList, sessionDetail } from '../src/ui/history-model.js';

describe('Workout Logging, Editing, Conflict Resolution & Return to Selection', () => {
  it('starts a workout, tracks hasUnsavedWork accurately, logs sets via inputBuffer, and finishes', async () => {
    const { app, actions } = await createTestApp();
    let snap = app.snapshot().store;
    assert.equal(snap.activeSession, null);
    assert.equal(hasUnsavedWork(snap), false);

    // Start Push A workout
    const startRes = await actions.startWorkout({ templateId: 'tpl_push_a', date: '2026-05-02' });
    assert.equal(startRes.ok, true);
    snap = app.snapshot().store;
    assert.ok(snap.activeSession);
    // Untouched workout has no unsaved work (can return to selection immediately)
    assert.equal(hasUnsavedWork(snap), false);

    const model = activeWorkoutModel(snap);
    assert.equal(model.mode, 'new');
    assert.ok(model.performances.length > 0);
    const benchPerf = model.performances.find((p) => p.id && snap.activeSession.session.performances.find((sp) => sp.id === p.id)?.exerciseId === 'ex_bench_press');
    assert.ok(benchPerf);

    const sessionId = snap.activeSession.session.id;
    const setId = benchPerf.sets[0].id;
    const identity = { sessionId, performanceId: benchPerf.id, setId };

    // Use inputBuffer to type load and reps, then complete the set
    const buffer = createInputBuffer({ app, commitSet: actions.commitSetValues, debounceMs: 5000 });
    const t1 = buffer.type(identity, 'load', '92.5', null);
    assert.equal(t1.protected, true);
    const t2 = buffer.type(identity, 'reps', '8', null);
    assert.equal(t2.protected, true);
    assert.equal(buffer.pendingFor(sessionId), 2);

    const compRes = await buffer.complete(identity, true);
    assert.equal(compRes.ok, true);
    assert.equal(buffer.pendingFor(sessionId), 0);

    snap = app.snapshot().store;
    // Now workout has unsaved work (completed set with values)
    assert.equal(hasUnsavedWork(snap), true);

    const fModel = finishModel(snap);
    assert.equal(fModel.saveCount, 1);
    assert.equal(fModel.nothingToSave, false);

    // Finish workout (confirming drop of uncompleted sets/performances)
    const finRes = await actions.finishWorkout({ sessionId, confirmDrop: fModel.dropsSomething });
    assert.equal(finRes.ok, true);

    snap = app.snapshot().store;
    assert.equal(snap.activeSession, null);
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].performances.length, 1);
    assert.equal(snap.sessions[0].performances[0].sets[0].load, 92.5);
    assert.equal(snap.sessions[0].performances[0].sets[0].reps, 8);
  });

  it('supports editing a saved workout, detects unsaved edits, and cancels or saves cleanly', async () => {
    const { app, actions } = await createTestApp();
    await actions.startWorkout({ templateId: null, date: '2026-05-01' });
    let snap = app.snapshot().store;
    const sid = snap.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
    snap = app.snapshot().store;
    const pid = snap.activeSession.session.performances[0].id;
    const setId = snap.activeSession.session.performances[0].sets[0].id;
    await actions.commitSetValues({ sessionId: sid, performanceId: pid, setId }, { load: 100, reps: 5 }, { completed: true });
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    snap = app.snapshot().store;
    const savedId = snap.sessions[0].id;

    // Open for edit
    const editRes = await actions.startEdit({ sessionId: savedId });
    assert.equal(editRes.ok, true);
    snap = app.snapshot().store;
    assert.equal(snap.activeSession.mode, 'edit');
    assert.equal(hasUnsavedWork(snap), false);

    // Modify reps from 5 to 6
    await actions.commitSetValues({ sessionId: snap.activeSession.session.id, performanceId: pid, setId }, { reps: 6 }, {});
    snap = app.snapshot().store;
    assert.equal(hasUnsavedWork(snap), true);

    // Save edit
    const finEdit = await actions.finishWorkout({ sessionId: snap.activeSession.session.id, confirmDrop: false });
    assert.equal(finEdit.ok, true);
    snap = app.snapshot().store;
    assert.equal(snap.sessions[0].performances[0].sets[0].reps, 6);
  });
});

describe('Derive Layer, Restricted Goals & Progress Charts Model', () => {
  it('calculates records, Epley e1RM (2-10 reps only), volume, 10K exact results, and chart series', async () => {
    const { app, actions } = await createTestApp();

    // Log 3 dated sessions of Bench Press + Run to test progress charts & records
    const dates = ['2026-04-01', '2026-04-10', '2026-04-20'];
    const loads = [80, 85, 90];
    const repsList = [8, 6, 5];

    for (let i = 0; i < 3; i++) {
      await actions.startWorkout({ templateId: null, date: dates[i] });
      let s = app.snapshot().store;
      const sid = s.activeSession.session.id;
      await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
      await actions.addExercise({ sessionId: sid, exerciseId: 'ex_run' });
      s = app.snapshot().store;
      const bpPerf = s.activeSession.session.performances[0];
      const runPerf = s.activeSession.session.performances[1];
      await actions.commitSetValues(
        { sessionId: sid, performanceId: bpPerf.id, setId: bpPerf.sets[0].id },
        { load: loads[i], reps: repsList[i] },
        { completed: true },
      );
      await actions.commitSetValues(
        { sessionId: sid, performanceId: runPerf.id, setId: runPerf.sets[0].id },
        { distanceM: 10000, durationSec: 3100 - i * 60, durationBasis: 'elapsed' },
        { completed: true },
      );
      await actions.finishWorkout({ sessionId: sid, confirmDrop: false });
    }

    const store = app.snapshot().store;
    // Records
    const recs = exerciseRecords(store, 'ex_bench_press');
    assert.equal(recs.official.find((r) => r.metric === 'max_load')?.value, 90);
    assert.ok(recs.estimates.length > 0);

    // Volume
    const vol = sessionVolume(store.sessions[2]);
    assert.equal(vol.volumeKg, 90 * 5);

    // 10K exact results
    const tenk = distanceResults(store, { exerciseId: 'ex_run', distanceM: 10000 });
    assert.equal(tenk.elapsed.length, 3);
    assert.equal(tenk.elapsed[0].durationSec, 2980);

    // Progress exercises & inline chart series (Features #2, #4, #5)
    const progList = progressExercises(store);
    assert.equal(progList.length, 2);
    const bpProg = exerciseProgress(store, 'ex_bench_press');
    assert.equal(bpProg.insufficient, false);
    assert.equal(bpProg.timeline.length, 1);

    const metrics = chartMetrics('weight_reps');
    assert.deepEqual(metrics.map((m) => m.id), ['load', 'reps']);
    const loadSeries = chartSeries(bpProg.timeline[0], 'load');
    assert.equal(loadSeries.points.length, 3);
    assert.equal(loadSeries.line, true); // >= 3 points draws connecting line
    assert.equal(loadSeries.enough, true);
    assert.deepEqual(loadSeries.points.map((p) => p.value), [80, 85, 90]);

    // Restricted Goals (Feature #4)
    assert.deepEqual(GOAL_EXERCISES, ['ex_bench_press', 'ex_weighted_pull_up', 'ex_run']);
    const addGoalRes = await actions.addGoal({
      exerciseId: 'ex_run',
      metric: 'time_for_distance',
      target: { distanceM: 10000, durationSec: 3000, timeBasis: 'elapsed' },
      deadline: '2026-12-31',
    });
    assert.equal(addGoalRes.ok, true);
    const gModel = goalsModel(app.snapshot().store);
    assert.equal(gModel.length, 1);
    assert.equal(gModel[0].achieved, true);

    // History list & detail
    const hist = historyList(app.snapshot().store);
    assert.equal(hist.total, 3);
    const det = sessionDetail(app.snapshot().store, hist.rows[0].id);
    assert.ok(det);
    assert.equal(det.performances.length, 2);
  });
});
