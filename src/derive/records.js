// Records (Step 2b.7, §1.5 / D3 / D4 / D11). Derived from saved sessions, never stored.
// Only completed sets with non-null fields, in performances whose snapshot isn't unresolved
// and without unresolved/unreliable import warnings.
//
// - max_load: max load, any reps.          - actual_1rm: max load where reps === 1.
// - load_for_min_reps (N ≥ 2): max load where reps ≥ N.
// - e1rm (kind 'e1rm', never a PR, never compared): max load × (1 + reps/30) for 2 ≤ reps ≤ 10 only.
// - bodyweight_plus_load (added load): max_load / actual_1rm / ≥N on the added load, no bodyweight needed.
//   Unweighted sets (load === null or 0, without unresolved load warnings) on bodyweight_plus_load count
//   towards bodyweight-only max_reps (loadBasis: null), kept strictly separate from weighted sets (loadBasis: 'added').
//   Total variants need the session bodyweight: total actual 1RM = bw + load (1 rep); total e1RM =
//   (bw + load)(1 + r/30) and added e1RM = total − bw (2–10 reps). bodyweightBasis 'measured' is
//   official; 'assumed' results go to the separate assumed section (D3a); 'none' → not computed.
// - max_reps (bodyweight_reps with loadBasis: null; weighted sets with loadBasis: m.loadBasis),
//   best_duration (duration), max_distance (types with distance).
// Loads are compared in kg (converted at calculation time); ties keep higher secondary metric (load/reps) then earliest dated set.
import { E1RM_MIN_REPS, E1RM_MAX_REPS, LOAD_FOR_MIN_REPS_MIN, ALLOWED_SET_FIELDS } from '../schema/constants.js';
import { toKg } from './units.js';
import { bodyweightBasis, bodyweightKg } from './bodyweight.js';

export const epley = (load, reps) => load * (1 + reps / 30);
const dateKey = (d) => d ?? '9999-99-99';

export const UNRELIABLE_SET_WARNINGS = Object.freeze([
  'CSV_LOAD_SEMANTICS_UNRESOLVED',
  'CSV_NO_LOAD',
  'CSV_ZERO_REPS',
  'V1_UNVERIFIED',
]);

export function hasUnreliableSetWarning(set) {
  return Array.isArray(set?.warnings) && set.warnings.some((w) => UNRELIABLE_SET_WARNINGS.includes(w));
}

/** Every candidate result of one exercise (not reduced to the best yet). Used by goals.js. */
export function recordCandidates(store, exerciseId, minReps = []) {
  const out = [];
  for (const s of store.sessions) {
    const bwBasis = bodyweightBasis(s.bodyweight);
    const bw = bodyweightKg(s.bodyweight);
    for (const p of s.performances) {
      if (p.exerciseId !== exerciseId || p.measurement.type === 'unresolved') continue;
      const m = p.measurement;
      const allowed = ALLOWED_SET_FIELDS[m.type] ?? [];
      for (const set of p.sets) {
        if (!set.completed || hasUnreliableSetWarning(set)) continue;
        const ref = { sessionId: s.id, performanceId: p.id, setId: set.id };
        const base = { ref, date: s.date, loadBasis: m.loadBasis };
        const push = (r) => out.push({ ...base, ...r });
        if (allowed.includes('load') && set.load !== null && set.load > 0) {
          const validReps = !allowed.includes('reps') || set.reps === null || set.reps >= 1;
          if (validReps) {
            const kg = toKg(set.load, m.loadUnit);
            push({ metric: 'max_load', kind: 'actual', bodyweightBasis: null, value: kg, unit: 'kg', reps: set.reps });
            if (set.reps === 1) push({ metric: 'actual_1rm', kind: 'actual', bodyweightBasis: null, value: kg, unit: 'kg', reps: 1 });
            for (const n of minReps) if (set.reps !== null && set.reps >= n) push({ metric: 'load_for_min_reps', minReps: n, kind: 'actual', bodyweightBasis: null, value: kg, unit: 'kg', reps: set.reps });
            if (set.reps !== null && set.reps >= 1) {
              push({ metric: 'max_reps', kind: 'actual', loadBasis: m.loadBasis, bodyweightBasis: null, value: set.reps, unit: 'reps', load: kg, reps: set.reps });
            }
            const inRange = set.reps !== null && set.reps >= E1RM_MIN_REPS && set.reps <= E1RM_MAX_REPS;
            if (m.type === 'bodyweight_plus_load') {
              if (bw !== null) {
                if (set.reps === 1) push({ metric: 'actual_1rm', kind: 'actual', loadBasis: 'total_with_bodyweight', bodyweightBasis: bwBasis, value: bw + kg, unit: 'kg', reps: 1 });
                if (inRange) {
                  const total = epley(bw + kg, set.reps);
                  push({ metric: 'e1rm', kind: 'e1rm', loadBasis: 'total_with_bodyweight', bodyweightBasis: bwBasis, value: total, unit: 'kg', reps: set.reps });
                  push({ metric: 'e1rm', kind: 'e1rm', loadBasis: 'added', bodyweightBasis: bwBasis, value: total - bw, unit: 'kg', reps: set.reps });
                }
              }
            } else if (inRange) push({ metric: 'e1rm', kind: 'e1rm', bodyweightBasis: null, value: epley(kg, set.reps), unit: 'kg', reps: set.reps });
          }
        }
        if (m.type === 'bodyweight_reps' && set.reps !== null && set.reps >= 1) {
          push({ metric: 'max_reps', kind: 'actual', loadBasis: null, bodyweightBasis: null, value: set.reps, unit: 'reps', load: null, reps: set.reps });
        }
        if (m.type === 'bodyweight_plus_load' && (set.load === null || set.load === 0) && set.reps !== null && set.reps >= 1) {
          push({ metric: 'max_reps', kind: 'actual', loadBasis: null, bodyweightBasis: null, value: set.reps, unit: 'reps', load: null, reps: set.reps });
        }
        if (m.type === 'duration' && set.durationSec !== null && set.durationSec > 0) {
          push({ metric: 'best_duration', kind: 'actual', loadBasis: null, bodyweightBasis: null, value: set.durationSec, unit: 'sec' });
        }
        if (allowed.includes('distanceM') && set.distanceM !== null && set.distanceM > 0) {
          push({ metric: 'max_distance', kind: 'actual', loadBasis: null, bodyweightBasis: null, value: set.distanceM, unit: 'm' });
        }
      }
    }
  }
  return out;
}

export const resultKey = (r) => [r.metric, r.kind, r.loadBasis ?? '-', r.bodyweightBasis ?? '-', r.minReps ?? '-'].join('|');

function isBetterAtEqualValue(r, cur) {
  const rLoad = r.load ?? 0;
  const curLoad = cur.load ?? 0;
  if (rLoad !== curLoad) return rLoad > curLoad;
  const rReps = r.reps ?? 0;
  const curReps = cur.reps ?? 0;
  if (rReps !== curReps) return rReps > curReps;
  return dateKey(r.date) < dateKey(cur.date);
}

/**
 * Best result per metric variant of one exercise.
 * @param {{minReps?: number[]}} [opts]  the N values for load_for_min_reps (each an integer ≥ 2)
 * @returns {{ official: object[], assumed: object[], estimates: object[] }}
 *   official: actual results that need no bodyweight or use measured bodyweight (may be PRs);
 *   assumed: results that use an assumed bodyweight (separate section, never PRs);
 *   estimates: Epley e1RM values (labeled estimates, never PRs, never compared).
 */
export function exerciseRecords(store, exerciseId, { minReps = [] } = {}) {
  for (const n of minReps) if (!Number.isSafeInteger(n) || n < LOAD_FOR_MIN_REPS_MIN) throw new RangeError('minReps values must be integers ≥ 2');
  const best = new Map();
  for (const r of recordCandidates(store, exerciseId, minReps)) {
    if (r.bodyweightBasis === 'none') continue;
    const k = resultKey(r);
    const cur = best.get(k);
    if (!cur || r.value > cur.value || (r.value === cur.value && isBetterAtEqualValue(r, cur))) best.set(k, r);
  }
  const all = [...best.values()].sort((a, b) => (resultKey(a) < resultKey(b) ? -1 : 1));
  return {
    official: all.filter((r) => r.kind === 'actual' && r.bodyweightBasis !== 'assumed'),
    assumed: all.filter((r) => r.bodyweightBasis === 'assumed'),
    estimates: all.filter((r) => r.kind === 'e1rm' && r.bodyweightBasis !== 'assumed'),
  };
}
