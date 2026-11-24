// Manual records vs calculated records (Step 2b.7, §1.5). Comparison happens only on an exact
// metric key: exercise + metric + load basis + unit (kg after conversion) + N. A manual record
// with repsText counts only as max_load. e1RM values and assumed-bodyweight values are never
// compared and never PRs. A manual pull-up record stores the ADDED load; its total is derived only
// when its own bodyweight is measured. time_for_distance is handled by tenk.js and compareTimeForDistanceRecords.
import { toKg } from './units.js';
import { bodyweightBasis, bodyweightKg } from './bodyweight.js';
import { exerciseRecords } from './records.js';
import { distanceResults } from './tenk.js';

const COMPARED = ['max_load', 'actual_1rm', 'load_for_min_reps', 'max_reps', 'best_duration', 'max_distance'];
const STANDARD_DISTANCES_M = [1000, 2000, 3000, 5000, 10000, 15000, 21097.5, 42195];
const round1 = (x) => Math.round(x * 10) / 10;

/** Exact comparison key. */
export function metricKey({ exerciseId, metric, loadBasis = null, unit, minReps = null }) {
  return [exerciseId, metric, loadBasis ?? '-', unit, minReps ?? '-'].join('|');
}

/** Keys (with values) a manual record can be compared under. */
export function manualRecordKeys(rec) {
  if (!COMPARED.includes(rec.metric)) return [];
  const out = [];
  const load = rec.load === null ? null : toKg(rec.load, rec.loadUnit);
  if (['max_load', 'actual_1rm', 'load_for_min_reps'].includes(rec.metric)) {
    const minReps = rec.metric === 'load_for_min_reps' ? rec.reps : null;
    out.push({ key: metricKey({ exerciseId: rec.exerciseId, metric: rec.metric, loadBasis: rec.loadBasis, unit: 'kg', minReps }), value: load });
    if (rec.metric === 'actual_1rm' && rec.loadBasis === 'added' && bodyweightBasis(rec.bodyweight) === 'measured') {
      out.push({ key: metricKey({ exerciseId: rec.exerciseId, metric: 'actual_1rm', loadBasis: 'total_with_bodyweight', unit: 'kg' }), value: load + bodyweightKg(rec.bodyweight) });
    }
  } else if (rec.metric === 'max_reps') out.push({ key: metricKey({ exerciseId: rec.exerciseId, metric: 'max_reps', unit: 'reps' }), value: rec.reps });
  else if (rec.metric === 'best_duration') out.push({ key: metricKey({ exerciseId: rec.exerciseId, metric: 'best_duration', unit: 'sec' }), value: rec.durationSec });
  else if (rec.metric === 'max_distance') out.push({ key: metricKey({ exerciseId: rec.exerciseId, metric: 'max_distance', unit: 'm' }), value: rec.distanceM });
  return out;
}

/**
 * Rows of records for one exercise. Matching keys are listed together and the higher value is
 * marked; non-matching keys are separate rows. Only official calculated results take part.
 */
export function compareRecords(store, exerciseId, { minReps = [] } = {}) {
  const rows = new Map();
  const row = (key) => {
    if (!rows.has(key)) rows.set(key, { key, calculated: null, manual: [], higher: null });
    return rows.get(key);
  };
  const recs = store.manualRecords.filter((r) => r.exerciseId === exerciseId);
  const ns = [...new Set([...minReps, ...recs.filter((r) => r.metric === 'load_for_min_reps').map((r) => r.reps)])].filter((n) => Number.isSafeInteger(n) && n >= 2);
  for (const r of exerciseRecords(store, exerciseId, { minReps: ns }).official) {
    if (!COMPARED.includes(r.metric) || r.bodyweightBasis === 'assumed') continue;
    row(metricKey({ exerciseId, metric: r.metric, loadBasis: r.loadBasis, unit: r.unit, minReps: r.minReps ?? null })).calculated = r;
  }
  for (const rec of recs) {
    for (const k of manualRecordKeys(rec)) {
      if (k.value !== null) {
        row(k.key).manual.push({
          id: rec.id,
          value: k.value,
          date: rec.date,
          source: rec.source,
          note: rec.note ?? null,
          reps: rec.reps ?? null,
          repsText: rec.repsText ?? null,
          load: rec.load ?? null,
          loadUnit: rec.loadUnit ?? null,
          loadBasis: rec.loadBasis ?? null,
          metric: rec.metric,
        });
      }
    }
  }
  for (const r of rows.values()) {
    const bestManual = Math.max(...r.manual.map((m) => m.value), -Infinity);
    const calc = r.calculated?.value ?? -Infinity;
    r.higher = calc === -Infinity && bestManual === -Infinity ? null : calc > bestManual ? 'calculated' : bestManual > calc ? 'manual' : 'equal';
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * Compares fastest time_for_distance records on distance_duration exercises per exact distance and timeBasis.
 * Lower durationSec is better (faster). Moving and elapsed time bases are never mixed.
 */
export function compareTimeForDistanceRecords(store, exerciseId) {
  const ex = (store.exercises ?? []).find((e) => e.id === exerciseId);
  if (!ex || ex.measurement?.type !== 'distance_duration') return [];

  const distCounts = new Map();
  for (const s of store.sessions ?? []) {
    for (const p of s.performances ?? []) {
      if (p.exerciseId !== exerciseId || p.measurement?.type !== 'distance_duration') continue;
      for (const set of p.sets ?? []) {
        if (!set.completed || set.distanceM === null || set.durationSec === null || set.distanceM <= 0 || set.durationSec <= 0) continue;
        const d = round1(set.distanceM);
        distCounts.set(d, (distCounts.get(d) ?? 0) + 1);
      }
    }
  }

  const candidateDistances = new Set();
  for (const [d, count] of distCounts) {
    if (STANDARD_DISTANCES_M.includes(d) || count >= 2 || distCounts.size <= 5) candidateDistances.add(d);
  }
  for (const rec of store.manualRecords ?? []) {
    if (rec.exerciseId === exerciseId && rec.metric === 'time_for_distance' && rec.distanceM !== null && rec.distanceM > 0) {
      candidateDistances.add(round1(rec.distanceM));
    }
  }
  for (const g of store.goals ?? []) {
    if (!g.archived && g.exerciseId === exerciseId && g.metric === 'time_for_distance' && g.target?.distanceM > 0) {
      candidateDistances.add(round1(g.target.distanceM));
    }
  }

  const out = [];
  for (const d of [...candidateDistances].sort((a, b) => a - b)) {
    const res = distanceResults(store, { exerciseId, distanceM: d });
    for (const basis of ['moving', 'elapsed']) {
      const group = res[basis] ?? [];
      const calcBest = group.find((item) => item.resultSource !== 'manual') ?? null;
      const manualItems = group
        .filter((item) => item.resultSource === 'manual')
        .map((item) => {
          const full = store.manualRecords.find((r) => r.id === item.ref?.recordId);
          return {
            id: item.ref?.recordId,
            value: item.durationSec,
            durationSec: item.durationSec,
            distanceM: d,
            timeBasis: basis,
            date: item.date,
            source: full?.source ?? 'manual',
            note: full?.note ?? null,
            metric: 'time_for_distance',
          };
        });
      if (!calcBest && manualItems.length === 0) continue;
      const bestManual = manualItems.reduce((b, m) => (!b || m.value < b.value ? m : b), null);
      const calcVal = calcBest ? calcBest.durationSec : Infinity;
      const manVal = bestManual ? bestManual.value : Infinity;
      const higher = calcVal < manVal ? 'calculated' : manVal < calcVal ? 'manual' : 'equal';
      out.push({
        key: `${exerciseId}|time_for_distance|${basis}|sec|${d}`,
        metric: 'time_for_distance',
        distanceM: d,
        timeBasis: basis,
        unit: 'sec',
        calculated: calcBest
          ? { value: calcBest.durationSec, durationSec: calcBest.durationSec, distanceM: d, timeBasis: basis, date: calcBest.date }
          : null,
        manual: bestManual,
        manualAll: manualItems,
        higher,
      });
    }
    const uncompManual = (res.unknown ?? [])
      .filter((item) => item.resultSource === 'manual')
      .map((item) => {
        const full = store.manualRecords.find((r) => r.id === item.ref?.recordId);
        return {
          id: item.ref?.recordId,
          value: item.durationSec,
          durationSec: item.durationSec,
          distanceM: d,
          timeBasis: null,
          date: item.date,
          source: full?.source ?? 'manual',
          note: full?.note ?? null,
          metric: 'time_for_distance',
        };
      });
    if (uncompManual.length > 0) {
      const bestManual = uncompManual.reduce((b, m) => (!b || m.value < b.value ? m : b), null);
      out.push({
        key: `${exerciseId}|time_for_distance|-|sec|${d}`,
        metric: 'time_for_distance',
        distanceM: d,
        timeBasis: null,
        unit: 'sec',
        calculated: null,
        manual: bestManual,
        manualAll: uncompManual,
        higher: 'manual',
      });
    }
  }
  return out;
}
