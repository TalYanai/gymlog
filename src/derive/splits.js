// Split usability (Step 2b.8, V1–V5). A split is a cumulative point { distanceM, timeSec, timeBasis }.
//   V1 one basis per set (else ALL splits rejected) · V2 strictly increasing distance and
//   non-decreasing time (else ALL rejected) · V3 not beyond the set's distance (offending splits
//   rejected) · V4 time vs the set's duration only when split.timeBasis === set.durationBasis,
//   both known and durationSec known · V5 no comparison across bases.
// Rejected splits are never used to derive anything (their source data stays in sourceRaw).
const round1 = (x) => Math.round(x * 10) / 10;

/** @returns {{ usable: object[], rejected: {split:object, rule:'V1'|'V2'|'V3'|'V4'}[] }} */
export function usableSplits(set) {
  const list = Array.isArray(set?.splits) ? set.splits : [];
  if (list.length === 0) return { usable: [], rejected: [] };
  if (new Set(list.map((s) => s.timeBasis)).size > 1) return { usable: [], rejected: list.map((split) => ({ split, rule: 'V1' })) };
  for (let i = 1; i < list.length; i++) {
    if (!(list[i].distanceM > list[i - 1].distanceM) || list[i].timeSec < list[i - 1].timeSec) return { usable: [], rejected: list.map((split) => ({ split, rule: 'V2' })) };
  }
  const usable = [];
  const rejected = [];
  for (const split of list) {
    if (set.distanceM !== null && round1(split.distanceM) > round1(set.distanceM)) rejected.push({ split, rule: 'V3' });
    else if (set.durationSec !== null && set.durationBasis !== null && split.timeBasis !== null && split.timeBasis === set.durationBasis && split.timeSec > set.durationSec) rejected.push({ split, rule: 'V4' });
    else usable.push(split);
  }
  return { usable, rejected };
}
