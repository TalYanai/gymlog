// The curated records list: only saved data, labelled when it is an estimate; run times only from splits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainRecordsModel, runSplitRecords } from '../src/ui/progress-model.js';

const M = { weight_reps: { type: 'weight_reps', loadBasis: 'total', loadUnit: 'kg' }, plus: { type: 'bodyweight_plus_load', loadBasis: 'added', loadUnit: 'kg' }, run: { type: 'distance_duration', loadBasis: null, loadUnit: null } };
const ex = (id, name, m) => ({ id, name, isCustom: false, measurement: m });
const perf = (exerciseId, m, sets) => ({ id: `p_${exerciseId}_${sets[0].id}`, exerciseId, measurement: m, sets });
const set = (id, load, reps, extra = {}) => ({ id, completed: true, load, reps, ...extra });
const lap = (n, km, time) => ({ row: n, cells: { Laps: String(n), 'Distance km': String(km), Time: time } });
const store = (sessions, manualRecords = []) => ({
  exercises: [ex('ex_bench_press', 'Bench Press', M.weight_reps), ex('ex_weighted_pull_up', 'Weighted Pull-Up', M.plus), ex('ex_deadlift', 'Deadlift', M.weight_reps), ex('ex_run', 'Run', M.run)],
  sessions, manualRecords, goals: [], templates: [], quarantine: [],
});
const row = (rows, id) => rows.find((r) => r.id === id);

test('strength records come only from what was recorded: sets (even a 1-rep set) are never records, nothing is estimated', () => {
  const st = store([{ id: 's1', date: '2026-07-01', performances: [perf('ex_bench_press', M.weight_reps, [set('a', 110, 1), set('b', 60, 11)]), perf('ex_weighted_pull_up', M.plus, [set('c', 34, 4), set('d', null, 15)])] }]);
  const r = mainRecordsModel(st);
  for (const id of ['bench:1rm', 'bench:reps60', 'pullup:1rm', 'pullup:bw', 'ringdip:bw', 'deadlift:1rm']) { assert.equal(row(r, id).value, null, id); assert.equal(row(r, id).kind, 'empty'); }
});

test('a manual record fills its row and is labelled; a lower one never replaces a higher one', () => {
  const st = store([], [
    { id: 'm1', exerciseId: 'ex_deadlift', metric: 'actual_1rm', load: 160, loadUnit: 'kg', loadBasis: 'total', reps: 1, date: null },
    { id: 'm2', exerciseId: 'ex_deadlift', metric: 'actual_1rm', load: 150, loadUnit: 'kg', loadBasis: 'total', reps: 1, date: '2026-01-01' },
    { id: 'm3', exerciseId: 'ex_bench_press', metric: 'max_reps', load: 60, loadUnit: 'kg', loadBasis: 'total', reps: 12, date: '2026-02-01' },
    { id: 'm4', exerciseId: 'ex_bench_press', metric: 'max_reps', load: 70, loadUnit: 'kg', loadBasis: 'total', reps: 15, date: '2026-02-01' },
    { id: 'm6', exerciseId: 'ex_bench_press', metric: 'max_load', load: 105, loadUnit: 'kg', loadBasis: 'total', reps: 1, date: '2026-11-10' },
    { id: 'm7', exerciseId: 'ex_bench_press', metric: 'max_load', load: 120, loadUnit: 'kg', loadBasis: 'total', reps: 5, date: '2026-11-10' },
    { id: 'm5', exerciseId: 'ex_weighted_pull_up', metric: 'actual_1rm', load: 40, loadUnit: 'kg', loadBasis: 'added', reps: 1, date: null },
  ]);
  const r = mainRecordsModel(st);
  assert.match(row(r, 'deadlift:1rm').value, /160/); assert.equal(row(r, 'deadlift:1rm').note, 'ידני');
  assert.equal(row(r, 'bench:reps60').value, '12 חזרות'); // only the 60 kg record counts for that row
  assert.match(row(r, 'pullup:1rm').value, /^\+40/);
  assert.match(row(r, 'bench:1rm').value, /105/); // a recorded 1-rep max load is a 1RM; a heavier multi-rep record is not
});

test('run: 1 km = fastest exact 1.00 km split; 5 km = consecutive full-km splits; no scaling, no 10 km invented', () => {
  const laps = [lap(1, 1.0, '5:00.0'), lap(2, 1.0, '4:50.0'), lap(3, 0.23, '2:00.0'), lap(4, 1.0, '4:40.0'), lap(5, 1.0, '4:41.0'), lap(6, 1.0, '4:42.0'), lap(7, 1.0, '4:43.0'), lap(8, 1.0, '4:44.0')];
  const run = { id: 'r1', date: '2026-08-01', performances: [perf('ex_run', M.run, [set('x', null, null, { distanceM: 6230, durationSec: 1900, sourceRaw: { rows: [{ row: 0, cells: { Laps: 'Summary', 'Distance km': '6.23', Time: '31:40' } }, ...laps] } })])] };
  const r = runSplitRecords(store([run]));
  assert.equal(r.find((x) => x.km === 1).sec, 280);
  assert.equal(r.find((x) => x.km === 5).sec, 280 + 281 + 282 + 283 + 284); // laps 4-8: 23:30, not including the 0.23 km recovery
  assert.equal(r.find((x) => x.km === 10).sec, null);
});

test('run saved without splits counts only when its total distance is the distance', () => {
  const mk = (id, m, s) => ({ id, date: '2026-08-02', performances: [perf('ex_run', M.run, [set('x', null, null, { distanceM: m, durationSec: s })])] });
  const r = runSplitRecords(store([mk('a', 5000, 1500), mk('b', 5360, 1400)]));
  assert.equal(r.find((x) => x.km === 5).sec, 1500);
  assert.equal(r.find((x) => x.km === 5).source, 'activity');
});
