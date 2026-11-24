// Exact time-for-distance results, e.g. 10K (Step 2b.8, D19–D24, T1–T15). Derived, never stored.
// Sources (resultSource), each only at EXACTLY the distance (0.1 m rounding, no tolerance, D19):
//   manual          a ManualRecord time_for_distance with that distanceM (its own timeBasis);
//   activity_split  a usable split (V1–V5) at that distance on a completed set;
//   activity_exact  a completed set whose distanceM equals it (basis = set.durationBasis).
// Never: a longer run's total, interpolation between splits, subtraction between splits, pace.
// Results are grouped by time basis (elapsed / moving / unknown) and never ranked across groups.
import { usableSplits } from './splits.js';

const round1 = (x) => Math.round(x * 10) / 10;
const groupOf = (basis) => (basis === 'elapsed' || basis === 'moving' ? basis : 'unknown');

/** @returns {{ elapsed: object[], moving: object[], unknown: object[] }} each sorted fastest first */
export function distanceResults(store, { exerciseId, distanceM }) {
  const D = round1(distanceM);
  const groups = { elapsed: [], moving: [], unknown: [] };
  const add = (r) => groups[groupOf(r.timeBasis)].push(r);
  for (const rec of store.manualRecords) {
    if (rec.exerciseId !== exerciseId || rec.metric !== 'time_for_distance' || rec.distanceM === null || round1(rec.distanceM) !== D || rec.durationSec === null) continue;
    add({ resultSource: 'manual', durationSec: rec.durationSec, timeBasis: rec.timeBasis, date: rec.date, ref: { recordId: rec.id }, relatedSetRef: rec.relatedSetRef });
  }
  for (const s of store.sessions) {
    for (const p of s.performances) {
      if (p.exerciseId !== exerciseId || p.measurement.type !== 'distance_duration') continue;
      for (const set of p.sets) {
        if (!set.completed) continue;
        const ref = { sessionId: s.id, performanceId: p.id, setId: set.id };
        for (const split of usableSplits(set).usable) {
          if (round1(split.distanceM) === D) add({ resultSource: 'activity_split', durationSec: split.timeSec, timeBasis: split.timeBasis, date: s.date, ref });
        }
        if (set.distanceM !== null && round1(set.distanceM) === D && set.durationSec !== null) {
          add({ resultSource: 'activity_exact', durationSec: set.durationSec, timeBasis: set.durationBasis ?? null, date: s.date, ref });
        }
      }
    }
  }
  const dk = (d) => d ?? '9999-99-99';
  for (const g of Object.values(groups)) g.sort((a, b) => a.durationSec - b.durationSec || (dk(a.date) < dk(b.date) ? -1 : dk(a.date) > dk(b.date) ? 1 : 0));
  return groups;
}

export const tenKResults = (store, exerciseId = 'ex_run') => distanceResults(store, { exerciseId, distanceM: 10000 });
