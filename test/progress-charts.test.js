// Key weight charts: built only from saved, dated sessions; no card without enough real points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyChartsModel, KEY_CHART_MIN_POINTS } from '../src/ui/progress-model.js';

const mkStore = (sessions) => ({
  exercises: [
    { id: 'ex_bench_press', name: 'Bench Press', isCustom: false, measurement: { type: 'weight_reps', loadBasis: 'total', loadUnit: 'kg' } },
    { id: 'ex_run', name: 'Run', isCustom: false, measurement: { type: 'distance_duration', loadBasis: null, loadUnit: null } },
  ],
  sessions, goals: [], manualRecords: [], templates: [], quarantine: [],
});
const sess = (id, date, load, exerciseId = 'ex_bench_press') => ({
  id, date, performances: [{ id: `p_${id}`, exerciseId, measurement: { type: 'weight_reps', loadBasis: 'total', loadUnit: 'kg' }, sets: [{ completed: true, load, reps: 5 }] }],
});

test('no card below the minimum number of dated sessions, and nothing is invented', () => {
  const two = mkStore([sess('a', '2026-06-01', 60), sess('b', '2026-06-08', 65)]);
  assert.equal(KEY_CHART_MIN_POINTS, 3);
  assert.deepEqual(keyChartsModel(two), []);
});

test('cards use only saved points; last and best come from them', () => {
  const st = mkStore([sess('a', '2026-06-01', 60), sess('b', '2026-06-08', 80), sess('c', '2026-06-15', 70), sess('x', null, 200)]);
  const [c] = keyChartsModel(st);
  assert.equal(c.id, 'ex_bench_press');
  assert.equal(c.count, 3); // the undated session is not plotted
  assert.deepEqual(c.series.points.map((p) => p.value), [60, 80, 70]);
  assert.equal(c.last.value, 70);
  assert.equal(c.top.value, 80);
});
