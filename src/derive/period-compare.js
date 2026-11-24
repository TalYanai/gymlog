// Weekly (Sunday–Saturday) and Monthly (1st–last calendar day) workout comparisons.
// Pure derivation module: never mutates the store, never combines incompatible workout types or
// measurement units, never treats missing data as zero, and clearly marks partial periods.
import { ALLOWED_SET_FIELDS } from '../schema/constants.js';
import { toKg } from './units.js';
import { sessionVolume } from './volume.js';
import { hasUnreliableSetWarning } from './records.js';
import { manualRecordKeys, metricKey } from './compare.js';

const MS_PER_DAY = 86400000;
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

export function isLeapYear(year) {
  return Number.isSafeInteger(year) && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0);
}

export function daysInMonth(year, month1to12) {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month1to12) || month1to12 < 1 || month1to12 > 12) {
    throw new RangeError(`Invalid year/month: ${year}-${month1to12}`);
  }
  if (month1to12 === 2) return isLeapYear(year) ? 29 : 28;
  if (month1to12 === 4 || month1to12 === 6 || month1to12 === 9 || month1to12 === 11) return 30;
  return 31;
}

export function parseIsoDateUtc(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function formatIsoDateUtc(dt) {
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(dateStr, deltaDays) {
  const dt = parseIsoDateUtc(dateStr);
  if (!dt) throw new RangeError(`Invalid ISO date: ${dateStr}`);
  return formatIsoDateUtc(new Date(dt.getTime() + deltaDays * MS_PER_DAY));
}

export function daysBetweenInclusive(startDate, endDate) {
  const a = parseIsoDateUtc(startDate);
  const b = parseIsoDateUtc(endDate);
  if (!a || !b || b.getTime() < a.getTime()) return 0;
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY) + 1;
}

/**
 * Computes the Sunday (day 0) through Saturday (day 6) week bounds containing `dateStr`.
 */
export function weekBoundsOf(dateStr) {
  const dt = parseIsoDateUtc(dateStr);
  if (!dt) throw new RangeError(`Invalid date for weekBoundsOf: ${dateStr}`);
  const dow = dt.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const startDate = formatIsoDateUtc(new Date(dt.getTime() - dow * MS_PER_DAY));
  const endDate = addDaysIso(startDate, 6);
  return {
    mode: 'week',
    key: startDate,
    startDate,
    endDate,
    totalDays: 7,
  };
}

/**
 * Computes the 1st through the actual last calendar day (28/29/30/31) of the month `YYYY-MM` (or `YYYY-MM-DD`).
 */
export function monthBoundsOf(monthOrDateStr) {
  if (typeof monthOrDateStr !== 'string') throw new RangeError(`Invalid month: ${monthOrDateStr}`);
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(monthOrDateStr.trim());
  if (!m) throw new RangeError(`Invalid month: ${monthOrDateStr}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const lastDay = daysInMonth(year, month);
  const key = `${m[1]}-${m[2]}`;
  const startDate = `${key}-01`;
  const endDate = `${key}-${String(lastDay).padStart(2, '0')}`;
  return {
    mode: 'month',
    key,
    year,
    month,
    startDate,
    endDate,
    totalDays: lastDay,
  };
}

/**
 * Resolves whether a period is partial relative to `today` (YYYY-MM-DD) and computes actual included dates.
 * A period where `today < bounds.startDate` is a future period (isFuture: true, isPartial: false).
 * A period where `today >= bounds.startDate && today < bounds.endDate` is in progress (isPartial: true, isFuture: false).
 * A period where `today >= bounds.endDate` has fully elapsed (isPartial: false, isFuture: false).
 */
export function resolvePeriodBounds(bounds, today = new Date().toISOString().slice(0, 10)) {
  const todayStr = typeof today === 'string' && parseIsoDateUtc(today) ? today.trim() : new Date().toISOString().slice(0, 10);
  if (todayStr < bounds.startDate) {
    return {
      ...bounds,
      isPartial: false,
      isFuture: true,
      actualStartDate: null,
      actualEndDate: null,
      elapsedDays: 0,
    };
  }
  if (todayStr <= bounds.endDate) {
    const isPartial = todayStr < bounds.endDate;
    const actualEndDate = isPartial ? todayStr : bounds.endDate;
    return {
      ...bounds,
      isPartial,
      isFuture: false,
      actualStartDate: bounds.startDate,
      actualEndDate,
      elapsedDays: daysBetweenInclusive(bounds.startDate, actualEndDate),
    };
  }
  return {
    ...bounds,
    isPartial: false,
    isFuture: false,
    actualStartDate: bounds.startDate,
    actualEndDate: bounds.endDate,
    elapsedDays: bounds.totalDays,
  };
}

/**
 * Lists all selectable weeks from the earliest session date (or 12 weeks prior to `today`) through `today`'s week,
 * plus any custom week keys passed in `includeKeys`, sorted newest first.
 */
export function availableWeeks(store, { today = new Date().toISOString().slice(0, 10), includeKeys = [] } = {}) {
  const todayWeek = weekBoundsOf(today);
  const datedSessions = (store.sessions ?? []).filter((s) => s.date && parseIsoDateUtc(s.date));
  let minDate = addDaysIso(todayWeek.startDate, -7 * 12);
  let maxDate = todayWeek.startDate;
  for (const s of datedSessions) {
    if (s.date < minDate) minDate = s.date;
    if (s.date > maxDate) maxDate = s.date;
  }
  for (const k of includeKeys) {
    if (k && parseIsoDateUtc(k)) {
      if (k < minDate) minDate = k;
      if (k > maxDate) maxDate = k;
    }
  }

  const firstWeek = weekBoundsOf(minDate);
  const lastWeek = weekBoundsOf(maxDate);
  const counts = new Map();
  for (const s of datedSessions) {
    const wk = weekBoundsOf(s.date).key;
    counts.set(wk, (counts.get(wk) ?? 0) + 1);
  }

  const out = [];
  let cur = lastWeek.startDate;
  while (cur >= firstWeek.startDate) {
    const resolved = resolvePeriodBounds(weekBoundsOf(cur), today);
    out.push({
      ...resolved,
      workoutCount: counts.get(resolved.key) ?? 0,
    });
    cur = addDaysIso(cur, -7);
  }
  return out;
}

/**
 * Lists all selectable months from the earliest session month (or 6 months prior to `today`) through `today`'s month,
 * plus any custom month keys passed in `includeKeys`, sorted newest first.
 */
export function availableMonths(store, { today = new Date().toISOString().slice(0, 10), includeKeys = [] } = {}) {
  const todayMonth = monthBoundsOf(today);
  const datedSessions = (store.sessions ?? []).filter((s) => s.date && parseIsoDateUtc(s.date));

  const shiftMonth = (y, m, delta) => {
    const total = y * 12 + (m - 1) + delta;
    return { year: Math.floor(total / 12), month: (total % 12) + 1 };
  };
  const fmtYm = ({ year, month }) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

  let minYm = fmtYm(shiftMonth(todayMonth.year, todayMonth.month, -6));
  let maxYm = todayMonth.key;
  for (const s of datedSessions) {
    const ym = s.date.slice(0, 7);
    if (ym < minYm) minYm = ym;
    if (ym > maxYm) maxYm = ym;
  }
  for (const k of includeKeys) {
    if (typeof k === 'string' && /^\d{4}-\d{2}/.test(k)) {
      const ym = k.slice(0, 7);
      if (ym < minYm) minYm = ym;
      if (ym > maxYm) maxYm = ym;
    }
  }

  const counts = new Map();
  for (const s of datedSessions) {
    const ym = s.date.slice(0, 7);
    counts.set(ym, (counts.get(ym) ?? 0) + 1);
  }

  const [minY, minM] = minYm.split('-').map(Number);
  const [maxY, maxM] = maxYm.split('-').map(Number);
  const out = [];
  let curY = maxY;
  let curM = maxM;
  while (curY > minY || (curY === minY && curM >= minM)) {
    const ym = fmtYm({ year: curY, month: curM });
    const resolved = resolvePeriodBounds(monthBoundsOf(ym), today);
    out.push({
      ...resolved,
      workoutCount: counts.get(ym) ?? 0,
    });
    const prev = shiftMonth(curY, curM, -1);
    curY = prev.year;
    curM = prev.month;
  }
  return out;
}

/**
 * Computes new personal records achieved during `[startDate, actualEndDate]`.
 * Evaluates saved workout sessions and dated manual records chronologically up through `actualEndDate`.
 */
export function newRecordsInPeriod(store, { startDate, actualEndDate, isFuture = false }) {
  if (isFuture || !actualEndDate || !startDate) return [];
  const exById = new Map((store.exercises ?? []).map((e) => [e.id, e]));
  // Track running bests before startDate: key -> { value, lowerIsBetter, date, reps, load }
  const priorBest = new Map();
  const periodBest = new Map();

  const isBetter = (val, curVal, lowerIsBetter) => (lowerIsBetter ? val < curVal : val > curVal);

  const registerCandidate = (inPeriod, entry) => {
    const { key, value, lowerIsBetter = false } = entry;
    const prev = priorBest.get(key);
    if (!inPeriod) {
      if (!prev || isBetter(value, prev.value, lowerIsBetter)) {
        priorBest.set(key, entry);
      }
      return;
    }
    const baseline = periodBest.get(key) ?? prev;
    if (!baseline || isBetter(value, baseline.value, lowerIsBetter)) {
      periodBest.set(key, {
        ...entry,
        previousBest: prev ? prev.value : null,
        isFirstRecord: !prev,
      });
    }
  };

  // 1. Seed manual records dated before startDate, and collect manual records dated within the period
  for (const rec of store.manualRecords ?? []) {
    if (!rec.date || rec.date > actualEndDate) continue;
    const ex = exById.get(rec.exerciseId);
    if (!ex || ex.archived || ex.mergedInto !== null) continue;
    const inPeriod = rec.date >= startDate && rec.date <= actualEndDate;
    for (const k of manualRecordKeys(rec)) {
      if (k.value === null) continue;
      const p = k.key.split('|');
      registerCandidate(inPeriod, {
        key: k.key,
        exerciseId: rec.exerciseId,
        exerciseName: ex.name,
        metric: p[1],
        loadBasis: p[2] === '-' ? null : p[2],
        unit: p[3],
        minReps: p[4] === '-' ? null : Number(p[4]),
        value: k.value,
        reps: rec.reps ?? null,
        load: rec.load === null ? null : toKg(rec.load, rec.loadUnit),
        date: rec.date,
        source: 'manual',
        lowerIsBetter: false,
      });
    }
    if (rec.metric === 'time_for_distance' && rec.distanceM > 0 && rec.durationSec > 0 && (rec.timeBasis === 'moving' || rec.timeBasis === 'elapsed')) {
      const d = round1(rec.distanceM);
      const tKey = `${rec.exerciseId}|time_for_distance|${rec.timeBasis}|sec|${d}`;
      registerCandidate(inPeriod, {
        key: tKey,
        exerciseId: rec.exerciseId,
        exerciseName: ex.name,
        metric: 'time_for_distance',
        loadBasis: rec.timeBasis,
        unit: 'sec',
        distanceM: d,
        value: rec.durationSec,
        date: rec.date,
        source: 'manual',
        lowerIsBetter: true,
      });
    }
  }

  // 2. Sort valid dated sessions up to actualEndDate chronologically
  const sessions = (store.sessions ?? [])
    .filter((s) => s.date && s.date <= actualEndDate)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.startedAt ?? '') < (b.startedAt ?? '') ? -1 : 1));

  for (const s of sessions) {
    const inPeriod = s.date >= startDate && s.date <= actualEndDate;
    for (const p of s.performances ?? []) {
      if (p.measurement?.type === 'unresolved') continue;
      const ex = exById.get(p.exerciseId);
      if (!ex || ex.archived || ex.mergedInto !== null) continue;
      const m = p.measurement;
      const allowed = ALLOWED_SET_FIELDS[m.type] ?? [];
      for (const set of p.sets ?? []) {
        if (!set.completed || hasUnreliableSetWarning(set)) continue;
        if (allowed.includes('load') && set.load !== null && set.load > 0) {
          const validReps = !allowed.includes('reps') || set.reps === null || set.reps >= 1;
          if (validReps) {
            const kg = toKg(set.load, m.loadUnit);
            registerCandidate(inPeriod, {
              key: metricKey({ exerciseId: ex.id, metric: 'max_load', loadBasis: m.loadBasis, unit: 'kg' }),
              exerciseId: ex.id,
              exerciseName: ex.name,
              metric: 'max_load',
              loadBasis: m.loadBasis,
              unit: 'kg',
              value: kg,
              reps: set.reps ?? null,
              load: kg,
              date: s.date,
              source: 'workout',
              lowerIsBetter: false,
            });
            if (set.reps !== null && set.reps >= 1) {
              registerCandidate(inPeriod, {
                key: metricKey({ exerciseId: ex.id, metric: 'max_reps', loadBasis: m.loadBasis, unit: 'reps' }),
                exerciseId: ex.id,
                exerciseName: ex.name,
                metric: 'max_reps',
                loadBasis: m.loadBasis,
                unit: 'reps',
                value: set.reps,
                reps: set.reps,
                load: kg,
                date: s.date,
                source: 'workout',
                lowerIsBetter: false,
              });
            }
          }
        }
        if ((m.type === 'bodyweight_reps' || (m.type === 'bodyweight_plus_load' && (set.load === null || set.load === 0))) && set.reps !== null && set.reps >= 1) {
          registerCandidate(inPeriod, {
            key: metricKey({ exerciseId: ex.id, metric: 'max_reps', loadBasis: null, unit: 'reps' }),
            exerciseId: ex.id,
            exerciseName: ex.name,
            metric: 'max_reps',
            loadBasis: null,
            unit: 'reps',
            value: set.reps,
            reps: set.reps,
            load: null,
            date: s.date,
            source: 'workout',
            lowerIsBetter: false,
          });
        }
        if (m.type === 'duration' && set.durationSec !== null && set.durationSec > 0) {
          registerCandidate(inPeriod, {
            key: metricKey({ exerciseId: ex.id, metric: 'best_duration', loadBasis: null, unit: 'sec' }),
            exerciseId: ex.id,
            exerciseName: ex.name,
            metric: 'best_duration',
            loadBasis: null,
            unit: 'sec',
            value: set.durationSec,
            date: s.date,
            source: 'workout',
            lowerIsBetter: false,
          });
        }
        if (allowed.includes('distanceM') && set.distanceM !== null && set.distanceM > 0) {
          registerCandidate(inPeriod, {
            key: metricKey({ exerciseId: ex.id, metric: 'max_distance', loadBasis: null, unit: 'm' }),
            exerciseId: ex.id,
            exerciseName: ex.name,
            metric: 'max_distance',
            loadBasis: null,
            unit: 'm',
            value: set.distanceM,
            date: s.date,
            source: 'workout',
            lowerIsBetter: false,
          });
        }
      }
    }
  }

  return [...periodBest.values()].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.key < b.key ? -1 : 1));
}

/**
 * Summarizes one weekly or monthly period accurately without inventing or combining incompatible metrics.
 */
export function summarizePeriod(store, periodKeyOrBounds, { mode = 'week', today = new Date().toISOString().slice(0, 10) } = {}) {
  const baseBounds =
    typeof periodKeyOrBounds === 'object' && periodKeyOrBounds !== null
      ? periodKeyOrBounds
      : mode === 'month'
        ? monthBoundsOf(periodKeyOrBounds)
        : weekBoundsOf(periodKeyOrBounds);
  const bounds = resolvePeriodBounds(baseBounds, today);
  const exById = new Map((store.exercises ?? []).map((e) => [e.id, e]));

  const sessions = bounds.isFuture || !bounds.actualEndDate
    ? []
    : (store.sessions ?? []).filter((s) => s.date && s.date >= bounds.startDate && s.date <= bounds.actualEndDate);
  const workoutCount = sessions.length;
  const activeDates = new Set(sessions.map((s) => s.date));
  const activeDays = activeDates.size;
  const workoutsPerWeek = bounds.elapsedDays > 0 ? round2((workoutCount / bounds.elapsedDays) * 7) : null;

  let strengthSessionCount = 0;
  let cardioSessionCount = 0;
  let countedVolumeSets = 0;
  let totalCompletedSets = 0;
  let totalVolumeKg = 0;

  // Group exercise stats by (exerciseId | effectiveMeasurementType | loadBasis)
  const exGroups = new Map();
  const ensureExGroup = (ex, effType, loadBasis) => {
    const compKey = `${ex.id}|${effType}|${loadBasis ?? '-'}`;
    if (!exGroups.has(compKey)) {
      exGroups.set(compKey, {
        compKey,
        exerciseId: ex.id,
        exerciseName: ex.name,
        measurementType: effType,
        loadBasis: loadBasis ?? null,
        sessionIds: new Set(),
        setCount: 0,
        maxLoadKg: null,
        repsAtMaxLoad: null,
        maxReps: null,
        loadAtMaxRepsKg: null,
        totalReps: null,
        totalDistanceM: null,
        maxDistanceM: null,
        maxDurationSec: null,
        bestMovingPaceSecPerKm: null,
        bestElapsedPaceSecPerKm: null,
      });
    }
    return exGroups.get(compKey);
  };

  for (const s of sessions) {
    const vol = sessionVolume(s);
    countedVolumeSets += vol.counted;
    totalCompletedSets += vol.total;
    if (vol.counted > 0 && vol.volumeKg !== null) {
      totalVolumeKg = round2(totalVolumeKg + vol.volumeKg);
    }

    let hasStrength = false;
    let hasCardio = false;
    for (const p of s.performances ?? []) {
      const m = p.measurement;
      if (!m || m.type === 'unresolved') continue;
      if (['weight_reps', 'bodyweight_plus_load', 'bodyweight_reps', 'load_distance'].includes(m.type)) hasStrength = true;
      if (m.type === 'distance_duration') hasCardio = true;

      const ex = exById.get(p.exerciseId);
      if (!ex || ex.archived || ex.mergedInto !== null) continue;

      for (const set of p.sets ?? []) {
        if (!set.completed || hasUnreliableSetWarning(set)) continue;

        if (m.type === 'weight_reps' || (m.type === 'bodyweight_plus_load' && set.load !== null && set.load > 0)) {
          if (set.load === null || set.load <= 0 || (set.reps !== null && set.reps <= 0)) continue;
          const g = ensureExGroup(ex, m.type, m.loadBasis);
          g.sessionIds.add(s.id);
          g.setCount += 1;
          const kg = toKg(set.load, m.loadUnit);
          if (g.maxLoadKg === null || kg > g.maxLoadKg || (kg === g.maxLoadKg && (set.reps ?? 0) > (g.repsAtMaxLoad ?? 0))) {
            g.maxLoadKg = kg;
            g.repsAtMaxLoad = set.reps ?? null;
          }
          if (set.reps !== null && set.reps >= 1) {
            g.totalReps = (g.totalReps ?? 0) + set.reps;
            if (g.maxReps === null || set.reps > g.maxReps || (set.reps === g.maxReps && kg > (g.loadAtMaxRepsKg ?? 0))) {
              g.maxReps = set.reps;
              g.loadAtMaxRepsKg = kg;
            }
          }
        } else if (m.type === 'bodyweight_reps' || (m.type === 'bodyweight_plus_load' && (set.load === null || set.load === 0))) {
          if (set.reps === null || set.reps < 1) continue;
          const g = ensureExGroup(ex, 'bodyweight_reps', null);
          g.sessionIds.add(s.id);
          g.setCount += 1;
          g.totalReps = (g.totalReps ?? 0) + set.reps;
          if (g.maxReps === null || set.reps > g.maxReps) {
            g.maxReps = set.reps;
          }
        } else if (m.type === 'distance_duration') {
          if (set.distanceM === null || set.distanceM <= 0) continue;
          const g = ensureExGroup(ex, 'distance_duration', null);
          g.sessionIds.add(s.id);
          g.setCount += 1;
          g.totalDistanceM = round1((g.totalDistanceM ?? 0) + set.distanceM);
          if (g.maxDistanceM === null || set.distanceM > g.maxDistanceM) {
            g.maxDistanceM = round1(set.distanceM);
          }
          if (set.durationSec !== null && set.durationSec > 0) {
            const pace = Math.round(set.durationSec / (set.distanceM / 1000));
            if (set.durationBasis === 'moving') {
              if (g.bestMovingPaceSecPerKm === null || pace < g.bestMovingPaceSecPerKm) g.bestMovingPaceSecPerKm = pace;
            } else if (set.durationBasis === 'elapsed') {
              if (g.bestElapsedPaceSecPerKm === null || pace < g.bestElapsedPaceSecPerKm) g.bestElapsedPaceSecPerKm = pace;
            }
          }
        } else if (m.type === 'duration') {
          if (set.durationSec === null || set.durationSec <= 0) continue;
          const g = ensureExGroup(ex, 'duration', null);
          g.sessionIds.add(s.id);
          g.setCount += 1;
          if (g.maxDurationSec === null || set.durationSec > g.maxDurationSec) {
            g.maxDurationSec = set.durationSec;
          }
        } else if (m.type === 'load_distance') {
          if (set.load === null || set.load <= 0 || set.distanceM === null || set.distanceM <= 0) continue;
          const g = ensureExGroup(ex, 'load_distance', m.loadBasis);
          g.sessionIds.add(s.id);
          g.setCount += 1;
          const kg = toKg(set.load, m.loadUnit);
          if (g.maxLoadKg === null || kg > g.maxLoadKg) g.maxLoadKg = kg;
          if (g.maxDistanceM === null || set.distanceM > g.maxDistanceM) g.maxDistanceM = round1(set.distanceM);
        }
      }
    }
    if (hasStrength) strengthSessionCount += 1;
    if (hasCardio) cardioSessionCount += 1;
  }

  const exercises = [...exGroups.values()]
    .map((g) => {
      const { sessionIds, ...rest } = g;
      return { ...rest, sessionCount: sessionIds.size };
    })
    .sort((a, b) => (b.sessionCount !== a.sessionCount ? b.sessionCount - a.sessionCount : b.setCount - a.setCount));

  const newRecords = workoutCount > 0 || (store.manualRecords ?? []).some((r) => r.date && r.date >= bounds.startDate && r.date <= bounds.actualEndDate)
    ? newRecordsInPeriod(store, bounds)
    : [];

  return {
    ...bounds,
    isEmpty: workoutCount === 0,
    workoutCount,
    activeDays,
    workoutsPerWeek,
    strengthSessionCount,
    cardioSessionCount,
    volume: {
      // Never treat missing comparable volume data as 0
      volumeKg: countedVolumeSets > 0 ? totalVolumeKg : null,
      countedSets: countedVolumeSets,
      totalCompletedSets,
    },
    exercises,
    newRecords,
  };
}

/**
 * Compares two user-selected weekly or monthly periods (`periodA` and `periodB`).
 * Only compares measurements with identical `(exerciseId, measurementType, loadBasis)`.
 * Never treats missing data as zero.
 */
export function comparePeriods(store, { mode = 'week', periodA, periodB, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (mode !== 'week' && mode !== 'month') throw new RangeError(`Invalid comparison mode: ${mode}`);
  const summaryA = summarizePeriod(store, periodA, { mode, today });
  const summaryB = summarizePeriod(store, periodB, { mode, today });

  const volComparable = summaryA.volume.volumeKg !== null && summaryB.volume.volumeKg !== null;
  const volumeComparison = {
    comparable: volComparable,
    volumeKgA: summaryA.volume.volumeKg,
    volumeKgB: summaryB.volume.volumeKg,
    deltaKg: volComparable ? round2(summaryB.volume.volumeKg - summaryA.volume.volumeKg) : null,
  };

  const mapA = new Map(summaryA.exercises.map((e) => [e.compKey, e]));
  const mapB = new Map(summaryB.exercises.map((e) => [e.compKey, e]));
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

  const exerciseComparisons = [];
  for (const compKey of allKeys) {
    const a = mapA.get(compKey) ?? null;
    const b = mapB.get(compKey) ?? null;
    const ref = b ?? a;
    const comparable = a !== null && b !== null;
    exerciseComparisons.push({
      compKey,
      exerciseId: ref.exerciseId,
      exerciseName: ref.exerciseName,
      measurementType: ref.measurementType,
      loadBasis: ref.loadBasis,
      comparable,
      periodA: a,
      periodB: b,
      deltas: {
        loadDeltaKg: comparable && a.maxLoadKg !== null && b.maxLoadKg !== null ? round2(b.maxLoadKg - a.maxLoadKg) : null,
        repsAtMaxLoadDelta: comparable && a.repsAtMaxLoad !== null && b.repsAtMaxLoad !== null ? b.repsAtMaxLoad - a.repsAtMaxLoad : null,
        maxRepsDelta: comparable && a.maxReps !== null && b.maxReps !== null ? b.maxReps - a.maxReps : null,
        totalRepsDelta: comparable && a.totalReps !== null && b.totalReps !== null ? b.totalReps - a.totalReps : null,
        maxDistanceDeltaM: comparable && a.maxDistanceM !== null && b.maxDistanceM !== null ? round1(b.maxDistanceM - a.maxDistanceM) : null,
        totalDistanceDeltaM: comparable && a.totalDistanceM !== null && b.totalDistanceM !== null ? round1(b.totalDistanceM - a.totalDistanceM) : null,
        maxDurationDeltaSec: comparable && a.maxDurationSec !== null && b.maxDurationSec !== null ? b.maxDurationSec - a.maxDurationSec : null,
      },
    });
  }

  exerciseComparisons.sort((x, y) => {
    if (x.comparable !== y.comparable) return x.comparable ? -1 : 1;
    const totSessionsX = (x.periodA?.sessionCount ?? 0) + (x.periodB?.sessionCount ?? 0);
    const totSessionsY = (y.periodA?.sessionCount ?? 0) + (y.periodB?.sessionCount ?? 0);
    if (totSessionsY !== totSessionsX) return totSessionsY - totSessionsX;
    return x.exerciseName < y.exerciseName ? -1 : 1;
  });

  return {
    mode,
    today,
    periodA: summaryA,
    periodB: summaryB,
    workoutDelta: summaryB.workoutCount - summaryA.workoutCount,
    activeDaysDelta: summaryB.activeDays - summaryA.activeDays,
    volumeComparison,
    exerciseComparisons,
  };
}
