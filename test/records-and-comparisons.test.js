import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeSyntheticGarminCsv } from './helpers.js';
import { validateStore } from '../src/schema/validate.js';
import { exerciseRecords } from '../src/derive/records.js';
import { compareRecords, compareTimeForDistanceRecords } from '../src/derive/compare.js';
import {
  isLeapYear,
  daysInMonth,
  weekBoundsOf,
  monthBoundsOf,
  resolvePeriodBounds,
  availableWeeks,
  availableMonths,
  summarizePeriod,
  comparePeriods,
} from '../src/derive/period-compare.js';
import {
  personalRecordsModel,
  periodComparisonModel,
  manualRecordExercises,
  manualRecordMetricOptions,
  exerciseSelectorLabel,
  formatPeriodLabel,
} from '../src/ui/progress-model.js';
import {
  normalizeAndValidateRecordFields,
  resolveRecordExercise,
  ensureRingDipExercise,
} from '../src/core/records.js';

describe('Personal Records (Automatic Detection & Invariants)', () => {
  it('detects automatic max_load, actual_1rm, and load_for_min_reps records on weighted barbell exercises', async () => {
    const { app, actions } = await createTestApp();
    await actions.startWorkout({ templateId: null, date: '2026-06-10' });
    const sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
    let perfs = app.snapshot().store.activeSession.session.performances;
    await actions.addSet({ sessionId: sid, performanceId: perfs[0].id });
    perfs = app.snapshot().store.activeSession.session.performances;

    // Set 1: 90kg x 5 (reps >= 2)
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perfs[0].id, setId: perfs[0].sets[0].id },
      { load: 90, reps: 5 },
      { completed: true },
    );
    // Set 2: 100kg x 1 (actual 1RM)
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perfs[0].id, setId: perfs[0].sets[1].id },
      { load: 100, reps: 1 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    const store = app.snapshot().store;
    const recs = exerciseRecords(store, 'ex_bench_press', { minReps: [5] }).official;

    const maxLoad = recs.find((r) => r.metric === 'max_load');
    assert.equal(maxLoad?.value, 100);

    const actual1rm = recs.find((r) => r.metric === 'actual_1rm');
    assert.equal(actual1rm?.value, 100);

    const loadMin5 = recs.find((r) => r.metric === 'load_for_min_reps' && r.minReps === 5);
    assert.equal(loadMin5?.value, 90);
  });

  it('detects automatic max_reps on bodyweight-only exercises', async () => {
    const { app, actions } = await createTestApp();
    // Add custom bodyweight_reps exercise via manage.createCustomExercise
    const addExRes = await actions.manage.createCustomExercise({
      name: 'Push-Up',
      group: 'חזה',
      type: 'bodyweight_reps',
    });
    assert.equal(addExRes.ok, true);
    const exId = app.snapshot().store.exercises.find((e) => e.name === 'Push-Up').id;

    await actions.startWorkout({ templateId: null, date: '2026-06-12' });
    const sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: exId });
    const perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { reps: 42 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    const store = app.snapshot().store;
    const recs = exerciseRecords(store, exId).official;
    const maxReps = recs.find((r) => r.metric === 'max_reps');
    assert.equal(maxReps?.value, 42);
    assert.equal(maxReps?.loadBasis, null);
  });

  it('detects separated bodyweight max_reps and added load records on bodyweight_plus_load exercises', async () => {
    const { app, actions } = await createTestApp();
    await actions.startWorkout({ templateId: null, date: '2026-06-15' });
    const sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_weighted_pull_up' });
    let perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.addSet({ sessionId: sid, performanceId: perf.id });
    perf = app.snapshot().store.activeSession.session.performances[0];

    // Set 1: Weighted Pull-Up with +25kg x 6
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { load: 25, reps: 6 },
      { completed: true },
    );
    // Set 2: Bodyweight Pull-Up (load: null) with 18 reps
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[1].id },
      { load: null, reps: 18 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    const store = app.snapshot().store;
    const recs = exerciseRecords(store, 'ex_weighted_pull_up').official;

    const weightedMaxLoad = recs.find((r) => r.metric === 'max_load' && r.loadBasis === 'added');
    assert.equal(weightedMaxLoad?.value, 25);
    assert.equal(weightedMaxLoad?.reps, 6);

    const weightedMaxReps = recs.find((r) => r.metric === 'max_reps' && r.loadBasis === 'added');
    assert.equal(weightedMaxReps?.value, 6);
    assert.equal(weightedMaxReps?.load, 25);

    const bodyweightMaxReps = recs.find((r) => r.metric === 'max_reps' && r.loadBasis === null);
    assert.equal(bodyweightMaxReps?.value, 18);
    assert.equal(bodyweightMaxReps?.load, null);
  });

  it('detects max_distance and fastest time_for_distance for running/cardio activities', async () => {
    const { app, actions } = await createTestApp();
    await actions.startWorkout({ templateId: null, date: '2026-06-18' });
    const sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_run' });
    const perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { distanceM: 5000, durationSec: 1380, durationBasis: 'moving' },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    const store = app.snapshot().store;
    const recs = exerciseRecords(store, 'ex_run').official;
    assert.equal(recs.find((r) => r.metric === 'max_distance')?.value, 5000);

    const timeRecs = compareTimeForDistanceRecords(store, 'ex_run');
    const moving5k = timeRecs.find((r) => r.distanceM === 5000 && r.timeBasis === 'moving');
    assert.equal(moving5k?.calculated?.durationSec, 1380);
  });

  it('strictly excludes unresolved exercises or unreliable load semantics from PR calculations', async () => {
    const { app, actions } = await createTestApp();
    // Valid workout first
    await actions.startWorkout({ templateId: null, date: '2026-06-01' });
    const sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
    const perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { load: 85, reps: 5 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    // Import a CSV where user marks load semantics as unknown (creating an unresolved exercise)
    const csv = makeSyntheticGarminCsv([
      {
        'שם_אימון_תאריך': 'אימון 02-06-2026',
        'שם_האימון': 'אימון',
        'תאריך': '02-06-2026',
        'מזהה_פעילות_Garmin': '99000000101',
        'Set': '1',
        'Exercise Name': 'Bench Press',
        'Time': '0:40',
        'Rest': '1:30',
        'Reps': '10.0',
        'Weight': '150.0 kg',
        'Volume': '1500.0 kg',
      },
    ]);
    const plan = await app.planGarminCsv(csv.bytes, 'test.csv');
    assert.equal(plan.ok, true);
    const decisions = structuredClone(plan.defaults);
    decisions.datesConfirmed = true;
    decisions.unit = 'kg';
    decisions.load.ex_bench_press = 'unknown'; // Marks load as unresolved
    const imp = await app.applyGarminCsv(plan.planId, decisions);
    assert.equal(imp.ok, true);

    const store = app.snapshot().store;
    const recs = exerciseRecords(store, 'ex_bench_press').official;
    // 150kg from the unresolved CSV set MUST NOT be counted as max_load
    assert.equal(recs.find((r) => r.metric === 'max_load')?.value, 85);
  });

  it('prevents duplicate workout records upon re-importing identical files (idempotency)', async () => {
    const { app } = await createTestApp();
    const csv = makeSyntheticGarminCsv([
      {
        'שם_אימון_תאריך': 'אימון 05-06-2026',
        'שם_האימון': 'אימון',
        'תאריך': '05-06-2026',
        'מזהה_פעילות_Garmin': '99000000102',
        'Set': '1',
        'Exercise Name': 'Bench Press',
        'Time': '0:40',
        'Rest': '1:30',
        'Reps': '8.0',
        'Weight': '80.0 kg',
        'Volume': '640.0 kg',
      },
    ]);
    const plan1 = await app.planGarminCsv(csv.bytes, 'test.csv');
    assert.equal(plan1.ok, true);
    const decisions = structuredClone(plan1.defaults);
    decisions.datesConfirmed = true;
    decisions.unit = 'kg';
    decisions.load.ex_bench_press = 'basis';
    const imp1 = await app.applyGarminCsv(plan1.planId, decisions);
    assert.equal(imp1.ok, true);

    // Attempt re-import of the exact same bytes
    const plan2 = await app.planGarminCsv(csv.bytes, 'test.csv');
    assert.equal(plan2.ok, false);
    assert.equal(plan2.code, 'ALREADY_IMPORTED');
  });
});

describe('Personal Records (Manual PR CRUD & Separation of Distinct Exercises)', () => {
  it('creates manual bodyweight PR (Pull-Up 27 reps) on ex_weighted_pull_up without fake workout sessions', async () => {
    const { app, actions } = await createTestApp();
    const initialSessionCount = app.snapshot().store.sessions.length;

    const res = await actions.addManualRecord({
      exerciseId: 'Pull-Up', // maps cleanly to ex_weighted_pull_up
      metric: 'max_reps',
      load: null,
      reps: 27,
      date: '2026-05-15',
      note: '27 חזרות נקיות במשקל גוף ללא תוספת משקל',
    });
    assert.equal(res.ok, true);

    const store = app.snapshot().store;
    assert.equal(store.sessions.length, initialSessionCount, 'No fake session created');
    assert.equal(store.manualRecords.length, 1);
    const rec = store.manualRecords[0];
    assert.equal(rec.exerciseId, 'ex_weighted_pull_up');
    assert.equal(rec.metric, 'max_reps');
    assert.equal(rec.load, null);
    assert.equal(rec.reps, 27);
    assert.equal(rec.date, '2026-05-15');
    assert.equal(rec.note, '27 חזרות נקיות במשקל גוף ללא תוספת משקל');
  });

  it('creates separate manual bodyweight PR for Ring Dip (21 reps) with dedicated exercise ex_ring_dip, distinct from Weighted Dips', async () => {
    const { app, actions } = await createTestApp();

    // Verify Weighted Dips exists initially
    const hasDipsInitially = app.snapshot().store.exercises.some((e) => e.id === 'ex_weighted_dips');
    assert.equal(hasDipsInitially, true);
    // Ring Dip does not exist initially
    assert.equal(app.snapshot().store.exercises.some((e) => e.id === 'ex_ring_dip'), false);

    // Add manual record using the name "Ring Dip"
    const res = await actions.addManualRecord({
      exerciseId: 'Ring Dip',
      metric: 'max_reps',
      load: null,
      reps: 21,
      date: '2026-05-20',
      note: '21 חזרות נקיות בטבעות במשקל גוף ללא תוספת משקל',
    });
    assert.equal(res.ok, true);

    const store = app.snapshot().store;
    // Dedicated exercise ex_ring_dip was auto-created and NOT merged into ex_weighted_dips
    const ringDipEx = store.exercises.find((e) => e.id === 'ex_ring_dip');
    assert.ok(ringDipEx, 'ex_ring_dip exists');
    assert.equal(ringDipEx.name, 'Ring Dip');
    assert.equal(ringDipEx.measurement.type, 'bodyweight_plus_load');
    assert.equal(ringDipEx.equipment, 'טבעות');

    // Manual record references ex_ring_dip, NOT ex_weighted_dips
    const manualRec = store.manualRecords.find((r) => r.exerciseId === 'ex_ring_dip');
    assert.ok(manualRec, 'manual record found on ex_ring_dip');
    assert.equal(manualRec.reps, 21);

    // compareRecords for ex_ring_dip contains the 21 reps PR
    const ringDipCmp = compareRecords(store, 'ex_ring_dip');
    const ringDipBw = ringDipCmp.find((r) => r.key === 'ex_ring_dip|max_reps|-|reps|-');
    assert.ok(ringDipBw);
    assert.equal(ringDipBw.manual[0]?.value, 21);

    // compareRecords for ex_weighted_dips has NO manual records
    const dipsCmp = compareRecords(store, 'ex_weighted_dips');
    const dipsBw = dipsCmp.find((r) => r.key === 'ex_weighted_dips|max_reps|-|reps|-');
    assert.equal(dipsBw, undefined);
  });

  it('creates manual weighted repetition PR (+20kg x 12 reps) separated from bodyweight repetition PRs', async () => {
    const { app, actions } = await createTestApp();
    // Add both a bodyweight manual PR and a weighted manual PR on ex_weighted_pull_up
    await actions.addManualRecord({
      exerciseId: 'ex_weighted_pull_up',
      metric: 'max_reps',
      load: null,
      reps: 27,
      date: '2026-05-15',
    });
    await actions.addManualRecord({
      exerciseId: 'ex_weighted_pull_up',
      metric: 'load_for_min_reps',
      load: 20,
      reps: 12,
      date: '2026-07-01',
    });

    const store = app.snapshot().store;
    const cmp = compareRecords(store, 'ex_weighted_pull_up');

    const bwRow = cmp.find((r) => r.key === 'ex_weighted_pull_up|max_reps|-|reps|-');
    const weightedRow = cmp.find((r) => r.key === 'ex_weighted_pull_up|load_for_min_reps|added|kg|12');

    assert.ok(bwRow);
    assert.ok(weightedRow);
    assert.equal(bwRow.manual[0]?.value, 27);
    assert.equal(weightedRow.manual[0]?.value, 20);
    assert.equal(weightedRow.manual[0]?.reps, 12);
  });

  it('coexists manual and automatic records on the same exercise and identifies the higher value', async () => {
    const { app, actions } = await createTestApp();

    // Log an automatic session with 21 bodyweight pull-ups
    await actions.startWorkout({ templateId: null, date: '2026-08-01' });
    const sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_weighted_pull_up' });
    const perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { load: null, reps: 21 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    // Add manual record with 27 reps
    await actions.addManualRecord({
      exerciseId: 'ex_weighted_pull_up',
      metric: 'max_reps',
      load: null,
      reps: 27,
      date: '2026-05-15',
    });

    const store = app.snapshot().store;
    const prModel = personalRecordsModel(store);
    const puGroup = prModel.groups.find((g) => g.exerciseId === 'ex_weighted_pull_up');
    assert.ok(puGroup);

    const bwRec = puGroup.records.find((r) => r.key === 'ex_weighted_pull_up|max_reps|-|reps|-');
    assert.ok(bwRec);
    assert.equal(bwRec.coexists, true);
    assert.equal(bwRec.calculated.value, 21);
    assert.equal(bwRec.manual.value, 27);
    assert.equal(bwRec.higher, 'manual');
    assert.equal(bwRec.best.sourceKind, 'manual');
    assert.equal(bwRec.best.text, '27 חזרות (משקל גוף ללא תוספת משקל)');
  });

  it('updates an existing manual PR without altering other records or workout sessions', async () => {
    const { app, actions } = await createTestApp();
    await actions.addManualRecord({
      exerciseId: 'ex_bench_press',
      metric: 'max_load',
      load: 100,
      reps: 1,
      date: '2026-05-01',
      note: 'Initial note',
    });
    const recId = app.snapshot().store.manualRecords[0].id;

    const updateRes = await actions.updateManualRecord({
      recordId: recId,
      exerciseId: 'ex_bench_press',
      metric: 'max_load',
      load: 105,
      reps: 1,
      date: '2026-05-10',
      note: 'Updated note',
    });
    assert.equal(updateRes.ok, true);

    const store = app.snapshot().store;
    const rec = store.manualRecords.find((r) => r.id === recId);
    assert.equal(rec.load, 105);
    assert.equal(rec.date, '2026-05-10');
    assert.equal(rec.note, 'Updated note');
  });

  it('deletes a manual PR without affecting workout sessions or other manual PRs', async () => {
    const { app, actions } = await createTestApp();
    await actions.addManualRecord({
      exerciseId: 'ex_bench_press',
      metric: 'max_load',
      load: 100,
      reps: 1,
    });
    await actions.addManualRecord({
      exerciseId: 'ex_weighted_pull_up',
      metric: 'max_reps',
      reps: 27,
    });
    const store1 = app.snapshot().store;
    assert.equal(store1.manualRecords.length, 2);
    const delId = store1.manualRecords[0].id;
    const keepId = store1.manualRecords[1].id;

    const delRes = await actions.deleteManualRecord({ recordId: delId });
    assert.equal(delRes.ok, true);

    const store2 = app.snapshot().store;
    assert.equal(store2.manualRecords.length, 1);
    assert.equal(store2.manualRecords[0].id, keepId);
  });

  it('validates manual PR input fields: rejects negative values, zero reps, invalid dates, and missing required load', async () => {
    const { app, actions } = await createTestApp();

    // Rejects zero or negative reps
    const zeroReps = await actions.addManualRecord({
      exerciseId: 'ex_bench_press',
      metric: 'max_load',
      load: 100,
      reps: 0,
    });
    assert.equal(zeroReps.ok, false);

    // Rejects negative load
    const negLoad = await actions.addManualRecord({
      exerciseId: 'ex_bench_press',
      metric: 'max_load',
      load: -10,
      reps: 1,
    });
    assert.equal(negLoad.ok, false);

    // Rejects missing load on a metric that requires load
    const noLoad = await actions.addManualRecord({
      exerciseId: 'ex_bench_press',
      metric: 'max_load',
      load: null,
      reps: 1,
    });
    assert.equal(noLoad.ok, false);

    // Rejects invalid date format
    const badDate = await actions.addManualRecord({
      exerciseId: 'ex_bench_press',
      metric: 'max_load',
      load: 100,
      reps: 1,
      date: 'not-a-date',
    });
    assert.equal(badDate.ok, false);
  });

  it('supports manual PR metric options based on exercise measurement type', () => {
    const bodyweightPlusLoadEx = { measurement: { type: 'bodyweight_plus_load' } };
    const bwPlusOpts = manualRecordMetricOptions(bodyweightPlusLoadEx);
    assert.ok(bwPlusOpts.some((o) => o.metric === 'max_reps' && !o.requiresLoad));
    assert.ok(bwPlusOpts.some((o) => o.metric === 'load_for_min_reps' && o.requiresLoad));
    assert.ok(bwPlusOpts.some((o) => o.metric === 'max_load' && o.requiresLoad));
    assert.ok(bwPlusOpts.some((o) => o.metric === 'actual_1rm' && o.requiresLoad));

    const cardioEx = { measurement: { type: 'distance_duration' } };
    const cardioOpts = manualRecordMetricOptions(cardioEx);
    assert.ok(cardioOpts.some((o) => o.metric === 'max_distance'));
    assert.ok(cardioOpts.some((o) => o.metric === 'time_for_distance'));
  });
});

describe('Calendar Periods, Leap Years & Future/Partial Boundary Edge Cases', () => {
  it('calculates Sunday–Saturday weekly boundaries correctly regardless of which day in the week is given', () => {
    // 2026-11-04 is Wednesday -> week is Sunday 2026-11-01 to Saturday 2026-11-07
    const wWed = weekBoundsOf('2026-11-04');
    assert.equal(wWed.startDate, '2026-11-01');
    assert.equal(wWed.endDate, '2026-11-07');
    assert.equal(wWed.totalDays, 7);

    // Sunday itself stays in the same week
    const wSun = weekBoundsOf('2026-11-01');
    assert.equal(wSun.startDate, '2026-11-01');
    assert.equal(wSun.endDate, '2026-11-07');

    // Saturday itself stays in the same week
    const wSat = weekBoundsOf('2026-11-07');
    assert.equal(wSat.startDate, '2026-11-01');
    assert.equal(wSat.endDate, '2026-11-07');

    // Month-crossing week: 2026-06-01 is Monday -> Sunday is 2026-05-31, Saturday is 2026-06-06
    const wCross = weekBoundsOf('2026-06-01');
    assert.equal(wCross.startDate, '2026-05-31');
    assert.equal(wCross.endDate, '2026-06-06');
  });

  it('calculates month boundaries accurately for 30-day and 31-day months', () => {
    const jun = monthBoundsOf('2026-06');
    assert.equal(jun.startDate, '2026-06-01');
    assert.equal(jun.endDate, '2026-06-30');
    assert.equal(jun.totalDays, 30);

    const oct = monthBoundsOf('2026-10');
    assert.equal(oct.startDate, '2026-10-01');
    assert.equal(oct.endDate, '2026-10-31');
    assert.equal(oct.totalDays, 31);
  });

  it('calculates February month boundaries accurately for leap years (29 days) and non-leap years (28 days)', () => {
    assert.equal(isLeapYear(2024), true);
    assert.equal(isLeapYear(2028), true);
    assert.equal(isLeapYear(2000), true);
    assert.equal(isLeapYear(2026), false);
    assert.equal(isLeapYear(1900), false);

    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2024, 2), 29);

    const feb2026 = monthBoundsOf('2026-02');
    assert.equal(feb2026.startDate, '2026-02-01');
    assert.equal(feb2026.endDate, '2026-02-28');
    assert.equal(feb2026.totalDays, 28);

    const feb2024 = monthBoundsOf('2024-02');
    assert.equal(feb2024.startDate, '2024-02-01');
    assert.equal(feb2024.endDate, '2024-02-29');
    assert.equal(feb2024.totalDays, 29);
  });

  it('classifies past completed periods with full totalDays and elapsedDays', () => {
    const raw = monthBoundsOf('2026-06');
    const resolved = resolvePeriodBounds(raw, '2026-11-04');
    assert.equal(resolved.isPartial, false);
    assert.equal(resolved.isFuture, false);
    assert.equal(resolved.elapsedDays, 30);
    assert.equal(resolved.actualStartDate, '2026-06-01');
    assert.equal(resolved.actualEndDate, '2026-06-30');
  });

  it('classifies current ongoing periods as partial periods with valid elapsedDays and actual date bounds', () => {
    const raw = monthBoundsOf('2026-11');
    const resolved = resolvePeriodBounds(raw, '2026-11-04');
    assert.equal(resolved.isPartial, true);
    assert.equal(resolved.isFuture, false);
    assert.equal(resolved.elapsedDays, 4);
    assert.equal(resolved.actualStartDate, '2026-11-01');
    assert.equal(resolved.actualEndDate, '2026-11-04');
  });

  it('classifies future periods strictly as isFuture: true, isPartial: false, with elapsedDays: 0 and null actual dates', () => {
    const raw = monthBoundsOf('2026-12');
    const resolved = resolvePeriodBounds(raw, '2026-11-04');
    assert.equal(resolved.isFuture, true);
    assert.equal(resolved.isPartial, false);
    assert.equal(resolved.elapsedDays, 0);
    assert.equal(resolved.actualStartDate, null);
    assert.equal(resolved.actualEndDate, null);

    // Also verify future week
    const rawFutureWeek = weekBoundsOf('2026-11-15');
    const resFutureWeek = resolvePeriodBounds(rawFutureWeek, '2026-11-04');
    assert.equal(resFutureWeek.isFuture, true);
    assert.equal(resFutureWeek.isPartial, false);
    assert.equal(resFutureWeek.elapsedDays, 0);
    assert.equal(resFutureWeek.actualStartDate, null);
    assert.equal(resFutureWeek.actualEndDate, null);
  });

  it('handles arbitrary non-consecutive weekly comparisons with accurate workout and metric deltas', async () => {
    const { app, actions } = await createTestApp();
    const logWorkout = async (date, load) => {
      await actions.startWorkout({ templateId: null, date });
      const sid = app.snapshot().store.activeSession.session.id;
      await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
      const perf = app.snapshot().store.activeSession.session.performances[0];
      await actions.commitSetValues(
        { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
        { load, reps: 5 },
        { completed: true },
      );
      await actions.finishWorkout({ sessionId: sid, confirmDrop: false });
    };

    // Week A (June 2026): 80kg
    await logWorkout('2026-06-08', 80);
    // Week B (August 2026): 90kg
    await logWorkout('2026-08-17', 90);

    const store = app.snapshot().store;
    const cmp = comparePeriods(store, {
      mode: 'week',
      periodA: '2026-06-07',
      periodB: '2026-08-16',
      today: '2026-11-04',
    });

    assert.equal(cmp.periodA.workoutCount, 1);
    assert.equal(cmp.periodB.workoutCount, 1);
    assert.equal(cmp.workoutDelta, 0);

    const bp = cmp.exerciseComparisons.find((e) => e.exerciseId === 'ex_bench_press');
    assert.ok(bp);
    assert.equal(bp.comparable, true);
    assert.equal(bp.deltas.loadDeltaKg, 10);
  });

  it('handles arbitrary non-consecutive monthly comparisons with accurate workout and metric deltas', async () => {
    const { app, actions } = await createTestApp();
    const logWorkout = async (date, load) => {
      await actions.startWorkout({ templateId: null, date });
      const sid = app.snapshot().store.activeSession.session.id;
      await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
      const perf = app.snapshot().store.activeSession.session.performances[0];
      await actions.commitSetValues(
        { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
        { load, reps: 5 },
        { completed: true },
      );
      await actions.finishWorkout({ sessionId: sid, confirmDrop: false });
    };

    // June 2026: 85kg
    await logWorkout('2026-06-15', 85);
    // October 2026: 95kg
    await logWorkout('2026-10-15', 95);

    const store = app.snapshot().store;
    const cmp = comparePeriods(store, {
      mode: 'month',
      periodA: '2026-06',
      periodB: '2026-10',
      today: '2026-11-04',
    });

    assert.equal(cmp.periodA.workoutCount, 1);
    assert.equal(cmp.periodB.workoutCount, 1);
    const bp = cmp.exerciseComparisons.find((e) => e.exerciseId === 'ex_bench_press');
    assert.ok(bp);
    assert.equal(bp.comparable, true);
    assert.equal(bp.deltas.loadDeltaKg, 10);
  });

  it('handles comparison against an empty period gracefully: yields null volume and comparable: false', async () => {
    const { app, actions } = await createTestApp();
    // Only log workout in August 2026
    await actions.startWorkout({ templateId: null, date: '2026-08-15' });
    const sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
    const perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { load: 80, reps: 5 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    const store = app.snapshot().store;
    // July 2026 has 0 workouts
    const cmp = comparePeriods(store, {
      mode: 'month',
      periodA: '2026-07',
      periodB: '2026-08',
      today: '2026-11-04',
    });

    assert.equal(cmp.periodA.isEmpty, true);
    assert.equal(cmp.periodA.workoutCount, 0);
    assert.equal(cmp.periodA.volume.volumeKg, null);
    assert.equal(cmp.volumeComparison.comparable, false);
    assert.equal(cmp.volumeComparison.deltaKg, null);
  });

  it('prevents incompatible exercise comparisons across load bases and measurement types', async () => {
    const { app, actions } = await createTestApp();
    // Week A: Incline DB Press (per_hand)
    await actions.startWorkout({ templateId: null, date: '2026-06-08' });
    let sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_incline_db_press' });
    let perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { load: 28, reps: 10 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    // Week B: Bench Press (total)
    await actions.startWorkout({ templateId: null, date: '2026-08-17' });
    sid = app.snapshot().store.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
    perf = app.snapshot().store.activeSession.session.performances[0];
    await actions.commitSetValues(
      { sessionId: sid, performanceId: perf.id, setId: perf.sets[0].id },
      { load: 90, reps: 6 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    const store = app.snapshot().store;
    const cmp = comparePeriods(store, {
      mode: 'week',
      periodA: '2026-06-07',
      periodB: '2026-08-16',
      today: '2026-11-04',
    });

    // Incline DB Press is not comparable to Bench Press and is marked not comparable in Week B
    const db = cmp.exerciseComparisons.find((e) => e.exerciseId === 'ex_incline_db_press');
    assert.ok(db);
    assert.equal(db.comparable, false);
    assert.equal(db.deltas.loadDeltaKg, null);
  });
});

describe('Store Invariants, Backup/Restore & UI View Rendering', () => {
  it('preserves all manual records and custom exercises across full export and restore', async () => {
    const { app, actions } = await createTestApp();

    await actions.addManualRecord({
      exerciseId: 'ex_weighted_pull_up',
      metric: 'max_reps',
      reps: 27,
      date: '2026-05-15',
      note: 'Pull-Up 27',
    });
    await actions.addManualRecord({
      exerciseId: 'Ring Dip', // Creates ex_ring_dip
      metric: 'max_reps',
      reps: 21,
      date: '2026-05-20',
      note: 'Ring Dip 21',
    });

    const storeBefore = app.snapshot().store;
    assert.equal((await validateStore(storeBefore)).valid, true);
    assert.equal(storeBefore.manualRecords.length, 2);
    assert.ok(storeBefore.exercises.some((e) => e.id === 'ex_ring_dip'));

    const backup = await app.createBackup();
    assert.equal(backup.ok, true);

    const { app: app2 } = await createTestApp();
    const backupBytes = new TextEncoder().encode(backup.json);
    const curBackup = await app2.createBackup();
    const provenExportBytes = new TextEncoder().encode(curBackup.json);
    const rest = await app2.restoreBackup({ backupBytes, provenExportBytes });
    assert.equal(rest.ok, true);

    const restoredStore = app2.snapshot().store;
    assert.equal((await validateStore(restoredStore)).valid, true);
    assert.equal(restoredStore.manualRecords.length, 2);
    assert.ok(restoredStore.exercises.some((e) => e.id === 'ex_ring_dip'));
  });

  it('renders Personal Records UI section with best records, source badges, and manual CRUD actions', async () => {
    class FakeNode {
      constructor(tag) {
        this.tagName = tag;
        this.className = '';
        this.textContent = '';
        this.attrs = {};
        this.children = [];
        this.listeners = {};
      }
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
      getAttribute(k) { return this.attrs[k] ?? null; }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      append(...nodes) { this.children.push(...nodes); }
      findAll(pred, out = []) {
        if (pred(this)) out.push(this);
        for (const c of this.children) if (c instanceof FakeNode) c.findAll(pred, out);
        return out;
      }
      fullText() {
        if (this.tagName === '#text') return this.textContent;
        return this.textContent + this.children.map((c) => (c instanceof FakeNode ? c.fullText() : String(c))).join('');
      }
    }
    globalThis.Node = FakeNode;
    globalThis.document = {
      createElement: (tag) => new FakeNode(tag),
      createElementNS: (_ns, tag) => new FakeNode(tag),
      createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = String(t); return n; },
    };

    const { progressView } = await import('../src/ui/progress.js');
    const { app, actions } = await createTestApp();

    await actions.addManualRecord({
      exerciseId: 'ex_weighted_pull_up',
      metric: 'max_reps',
      reps: 27,
      date: '2026-05-15',
      note: 'Pull-Up 27',
    });

    const ctx = {
      app,
      actions,
      get store() { return app.snapshot().store; },
      progressUi: {
        goalForm: null,
        manualRecordForm: null,
        activeTab: 'all',
        compareMode: 'month',
        compareMonthA: '2026-09',
        compareMonthB: '2026-10',
        compareToday: '2026-11-04',
      },
      rerender: () => {},
    };

    const tree = progressView(ctx, []);
    const prSec = tree.findAll((n) => n.getAttribute('data-section') === 'personal-records');
    assert.equal(prSec.length, 1);

    const editBtns = tree.findAll((n) => n.getAttribute('data-edit-record') !== null);
    const delBtns = tree.findAll((n) => n.getAttribute('data-delete-record') !== null);
    assert.equal(editBtns.length, 1);
    assert.equal(delBtns.length, 1);
  });

  it('renders Weekly and Monthly Comparisons UI section with partial and future period badges and banners', async () => {
    class FakeNode {
      constructor(tag) {
        this.tagName = tag;
        this.className = '';
        this.textContent = '';
        this.attrs = {};
        this.children = [];
        this.listeners = {};
      }
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
      getAttribute(k) { return this.attrs[k] ?? null; }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      append(...nodes) { this.children.push(...nodes); }
      findAll(pred, out = []) {
        if (pred(this)) out.push(this);
        for (const c of this.children) if (c instanceof FakeNode) c.findAll(pred, out);
        return out;
      }
      fullText() {
        if (this.tagName === '#text') return this.textContent;
        return this.textContent + this.children.map((c) => (c instanceof FakeNode ? c.fullText() : String(c))).join('');
      }
    }
    globalThis.Node = FakeNode;
    globalThis.document = {
      createElement: (tag) => new FakeNode(tag),
      createElementNS: (_ns, tag) => new FakeNode(tag),
      createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = String(t); return n; },
    };

    const { progressView } = await import('../src/ui/progress.js');
    const { app, actions } = await createTestApp();

    const ctx = {
      app,
      actions,
      get store() { return app.snapshot().store; },
      progressUi: {
        goalForm: null,
        manualRecordForm: null,
        activeTab: 'all',
        compareMode: 'month',
        compareMonthA: '2026-11', // Partial month when today is 2026-11-04
        compareMonthB: '2026-12', // Future month when today is 2026-11-04
        compareToday: '2026-11-04',
      },
      rerender: () => {},
    };

    const tree = progressView(ctx, []);
    const cmpSec = tree.findAll((n) => n.getAttribute('data-section') === 'comparisons');
    assert.equal(cmpSec.length, 1);

    // Period A (2026-11) is partial
    const partialBannerA = tree.findAll((n) => n.getAttribute('data-partial-banner') === 'A');
    assert.equal(partialBannerA.length, 1);
    assert.match(partialBannerA[0].fullText(), /טרם הסתיימה/);

    // Period B (2026-12) is future
    const futureBannerB = tree.findAll((n) => n.getAttribute('data-future-banner') === 'B');
    assert.equal(futureBannerB.length, 1);
    assert.match(futureBannerB[0].fullText(), /עתידית וטרם החלה/);
  });
});
