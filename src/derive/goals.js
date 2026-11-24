// Goal achievement and progress (Step 2b.8, §1.6, D15, D19, D20). Values only, no percentages; every
// threshold comes from goal.target. Manual records never prove a time_for_distance goal (D20).
//
// time_for_distance (D = target.distanceM, T = target.durationSec, basis = target.timeBasis):
//   A: a completed set with distanceM ≥ D, durationBasis === basis and durationSec ≤ T (run totals);
//   B: a usable split at exactly D with timeBasis === basis and timeSec ≤ T, on a completed set
//      (independent of the set's totals except through V3/V4).
//   achievedAt = the earliest dated evidence; undated evidence counts only when nothing is dated.
// actual_1rm: an official actual 1RM (calculated, or a comparable manual record) ≥ target.load.
// load_for_min_reps: a completed set with load ≥ target.load and reps ≥ target.reps (calculated only).
// max_distance: a completed set with distanceM ≥ target.distanceM.
import { usableSplits } from './splits.js';
import { distanceResults } from './tenk.js';
import { toKg } from './units.js';
import { exerciseRecords, recordCandidates } from './records.js';
import { manualRecordKeys, metricKey } from './compare.js';

const round1 = (x) => Math.round(x * 10) / 10;
const byDate = (a, b) => ((a.date ?? '9999-99-99') < (b.date ?? '9999-99-99') ? -1 : (a.date ?? '9999-99-99') > (b.date ?? '9999-99-99') ? 1 : 0);

function completedSets(store, exerciseId, fn) {
  for (const s of store.sessions) for (const p of s.performances) {
    if (p.exerciseId !== exerciseId || p.measurement.type === 'unresolved') continue;
    for (const set of p.sets) if (set.completed) fn(set, p, s);
  }
}

function achievement(evidence) {
  const sorted = [...evidence].sort(byDate);
  const first = sorted.find((e) => e.date !== null) ?? sorted[0] ?? null;
  return { achieved: sorted.length > 0, achievedAt: first?.date ?? null, dateUnknown: !!first && first.date === null, evidence: sorted };
}

function timeForDistance(store, g) {
  const { distanceM, durationSec: T, timeBasis } = g.target;
  const D = round1(distanceM);
  const evidence = [];
  const notCounted = [];
  completedSets(store, g.exerciseId, (set, p, s) => {
    if (p.measurement.type !== 'distance_duration') return;
    const ref = { sessionId: s.id, performanceId: p.id, setId: set.id };
    if (set.distanceM !== null && round1(set.distanceM) >= D && set.durationSec !== null && set.durationSec <= T) {
      if (set.durationBasis === timeBasis) evidence.push({ condition: 'A', date: s.date, distanceM: set.distanceM, durationSec: set.durationSec, ref });
      else notCounted.push({ condition: 'A', reason: set.durationBasis === null ? 'basis_unknown' : 'other_basis', timeBasis: set.durationBasis, date: s.date, distanceM: set.distanceM, durationSec: set.durationSec, ref });
    }
    for (const split of usableSplits(set).usable) {
      if (round1(split.distanceM) !== D || split.timeSec > T) continue;
      if (split.timeBasis === timeBasis) evidence.push({ condition: 'B', date: s.date, timeSec: split.timeSec, ref });
      else notCounted.push({ condition: 'B', reason: split.timeBasis === null ? 'basis_unknown' : 'other_basis', timeBasis: split.timeBasis, date: s.date, timeSec: split.timeSec, ref });
    }
  });
  const results = distanceResults(store, { exerciseId: g.exerciseId, distanceM });
  const group = timeBasis === 'elapsed' || timeBasis === 'moving' ? timeBasis : 'unknown';
  return { ...achievement(evidence), bestExact: results[group][0] ?? null, notCounted, otherGroups: Object.fromEntries(Object.entries(results).filter(([k]) => k !== group)) };
}

// Official actual results only: measured bodyweight for totals; assumed or unknown bodyweight never
// achieves a goal (D3a). Uses the same candidates as the records view.
function actual1rm(store, g) {
  const t = g.target;
  const targetKg = toKg(t.load, t.loadUnit);
  const evidence = [];
  for (const r of recordCandidates(store, g.exerciseId, [])) {
    if (r.metric !== 'actual_1rm' || r.loadBasis !== t.loadBasis || r.bodyweightBasis === 'assumed' || r.bodyweightBasis === 'none') continue;
    if (r.value >= targetKg) evidence.push({ source: 'calculated', date: r.date, valueKg: r.value, ref: r.ref });
  }
  const key = metricKey({ exerciseId: g.exerciseId, metric: 'actual_1rm', loadBasis: t.loadBasis, unit: 'kg' });
  for (const rec of store.manualRecords) {
    if (rec.exerciseId !== g.exerciseId) continue;
    for (const k of manualRecordKeys(rec)) if (k.key === key && k.value !== null && k.value >= targetKg) evidence.push({ source: 'manual', date: rec.date, valueKg: k.value, ref: { recordId: rec.id } });
  }
  const current = exerciseRecords(store, g.exerciseId).official.find((r) => r.metric === 'actual_1rm' && r.loadBasis === t.loadBasis) ?? null;
  return { ...achievement(evidence), currentKg: current?.value ?? null, targetKg };
}

function loadForMinReps(store, g) {
  const t = g.target;
  const targetKg = toKg(t.load, t.loadUnit);
  const evidence = [];
  let mostRepsAtLoad = null;
  for (const r of recordCandidates(store, g.exerciseId, [])) {
    if (r.metric !== 'max_load' || r.loadBasis !== t.loadBasis || r.reps === null || r.value < targetKg) continue;
    mostRepsAtLoad = Math.max(mostRepsAtLoad ?? 0, r.reps);
    if (r.reps >= t.reps) evidence.push({ date: r.date, valueKg: r.value, reps: r.reps, ref: r.ref });
  }
  return { ...achievement(evidence), mostRepsAtLoad, targetKg, targetReps: t.reps };
}

function maxDistance(store, g) {
  const D = round1(g.target.distanceM);
  const evidence = [];
  let longest = null;
  completedSets(store, g.exerciseId, (set, p, s) => {
    if (set.distanceM === null) return;
    longest = Math.max(longest ?? 0, set.distanceM);
    if (round1(set.distanceM) >= D) evidence.push({ date: s.date, distanceM: set.distanceM, ref: { sessionId: s.id, performanceId: p.id, setId: set.id } });
  });
  return { ...achievement(evidence), longestM: longest, targetM: g.target.distanceM };
}

const RULES = { time_for_distance: timeForDistance, actual_1rm: actual1rm, load_for_min_reps: loadForMinReps, max_distance: maxDistance };

/** @returns { goalId, metric, achieved, achievedAt, dateUnknown, evidence, …metric-specific progress values } */
export function goalStatus(store, goal) {
  const rule = RULES[goal.metric];
  if (!rule) throw new RangeError(`unknown goal metric ${goal.metric}`);
  return { goalId: goal.id, metric: goal.metric, ...rule(store, goal) };
}
