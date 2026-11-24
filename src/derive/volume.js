// Volume (Step 2b.7, D5): load × reps × volumeFactor, only for weight_reps performances whose
// snapshot has a non-null volumeFactor, on completed sets where load and reps are both non-null.
// Always reported with coverage { counted, total } (total = completed sets in the scope).
import { toKg } from './units.js';

export function performanceVolume(perf) {
  const completed = perf.sets.filter((s) => s.completed);
  const m = perf.measurement;
  if (m.type !== 'weight_reps' || m.volumeFactor === null) return { volumeKg: null, counted: 0, total: completed.length };
  let sum = 0;
  let counted = 0;
  for (const s of completed) {
    if (s.load === null || s.reps === null) continue;
    sum += toKg(s.load, m.loadUnit) * s.reps * m.volumeFactor;
    counted++;
  }
  return { volumeKg: counted ? sum : null, counted, total: completed.length };
}

export function sessionVolume(session) {
  let volumeKg = 0;
  let counted = 0;
  let total = 0;
  for (const p of session.performances) {
    const v = performanceVolume(p);
    if (v.volumeKg !== null) volumeKg += v.volumeKg;
    counted += v.counted;
    total += v.total;
  }
  return { volumeKg: counted ? volumeKg : null, counted, total };
}
