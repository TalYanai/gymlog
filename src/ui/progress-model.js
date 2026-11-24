// Step 2d.6 — Progress, Personal Records & Period Comparisons: pure read models over saved sessions,
// built only from the derive layer (records, comparison with manual records, exact-distance results,
// goal status, and weekly/monthly period comparisons). No trend lines, no extrapolation, no percentages:
// values are shown as recorded, grouped where they are not comparable.
import { compareRecords, compareTimeForDistanceRecords } from '../derive/compare.js';
import { exerciseRecords } from '../derive/records.js';
import { distanceResults } from '../derive/tenk.js';
import { goalStatus } from '../derive/goals.js';
import { toKg } from '../derive/units.js';
import { availableWeeks, availableMonths, comparePeriods } from '../derive/period-compare.js';
import { goalMetricsFor } from '../core/goals.js';
import { formatNumber, formatSeconds, formatDate } from './format.js';

export const METRIC_LABELS = Object.freeze({
  max_load: 'משקל מרבי', actual_1rm: '1RM בפועל', load_for_min_reps: 'משקל מרבי לחזרות', e1rm: '1RM משוער (הערכה בלבד)',
  max_reps: 'מקסימום חזרות', best_duration: 'זמן ארוך ביותר', max_distance: 'מרחק ארוך ביותר', time_for_distance: 'זמן למרחק',
});
export const BASIS_LABELS = Object.freeze({ total: '', per_hand: 'לכל יד', per_side: 'לכל צד', implement: 'לכלי', added: 'תוספת משקל', total_with_bodyweight: 'כולל משקל גוף' });
const TIME_BASIS_LABELS = { elapsed: 'זמן כולל', moving: 'זמן תנועה', unknown: 'בסיס זמן לא ידוע' };

const isUnresolvedPerf = (store, p) => p.measurement.type === 'unresolved' || store.exercises.find((e) => e.id === p.exerciseId)?.measurement.type === 'unresolved';

export function exerciseSelectorLabel(ex) {
  if (!ex) return '';
  if (ex.id === 'ex_weighted_pull_up') return 'Weighted Pull-Up / Pull-Up (מתח)';
  if (ex.id === 'ex_weighted_dips') return 'Weighted Dips (מקבילים)';
  if (ex.id === 'ex_ring_dip' || ex.name?.toLowerCase() === 'ring dip') return 'Ring Dip (טבעות)';
  if (Array.isArray(ex.aliases) && ex.aliases.length > 0) return `${ex.name} (${ex.aliases.join(', ')})`;
  return ex.name;
}

/** Every completed set with data of an exercise in saved sessions: [{ session, perf, set }]. */
function completed(store, exerciseId) {
  const out = [];
  for (const s of store.sessions) for (const p of s.performances) {
    if (p.exerciseId !== exerciseId || isUnresolvedPerf(store, p)) continue;
    for (const set of p.sets) if (set.completed && ['load', 'reps', 'durationSec', 'distanceM'].some((f) => set[f] !== null)) out.push({ session: s, perf: p, set });
  }
  return out;
}

/** Exercises with completed history, most recently trained first. */
export function progressExercises(store) {
  const byEx = new Map();
  for (const s of store.sessions) for (const p of s.performances) {
    if (isUnresolvedPerf(store, p) || !p.sets.some((x) => x.completed) || p.exerciseId === 'ex_hiit') continue; // HIIT is a workout type (duration only), not an exercise to track
    const cur = byEx.get(p.exerciseId) ?? { sessions: new Set(), lastDate: null };
    cur.sessions.add(s.id);
    if (s.date && (!cur.lastDate || s.date > cur.lastDate)) cur.lastDate = s.date;
    byEx.set(p.exerciseId, cur);
  }
  return [...byEx].map(([id, v]) => {
    const ex = store.exercises.find((e) => e.id === id);
    return { id, name: ex?.name ?? id, type: ex?.measurement.type ?? null, sessions: v.sessions.size, lastDate: v.lastDate };
  }).sort((a, b) => ((b.lastDate ?? '') > (a.lastDate ?? '') ? 1 : (b.lastDate ?? '') < (a.lastDate ?? '') ? -1 : a.name.localeCompare(b.name)));
}

/** "82.5 ק״ג לכל יד", "12 חזרות", "25:30", "5 ק״מ". */
export function valueText(metric, value, { loadBasis = null, reps = null, repsText = null, minReps = null, load = null } = {}) {
  if (value === null || value === undefined) return '—';
  if (['max_load', 'actual_1rm', 'load_for_min_reps', 'e1rm'].includes(metric)) {
    const basis = BASIS_LABELS[loadBasis] ? ` (${BASIS_LABELS[loadBasis]})` : '';
    const r = metric === 'max_load' && reps !== null
      ? ` × ${reps}`
      : metric === 'max_load' && repsText
        ? ` × ${repsText}`
        : metric === 'load_for_min_reps' && minReps
          ? ` × ${minReps}+ חזרות`
          : '';
    return `${formatNumber(Math.round(value * 10) / 10)} ק״ג${r}${basis}`;
  }
  if (metric === 'max_reps') {
    if (loadBasis && load !== null && load !== undefined) {
      const basis = BASIS_LABELS[loadBasis] ? ` ${BASIS_LABELS[loadBasis]}` : '';
      return `${value} חזרות (${formatNumber(Math.round(load * 10) / 10)} ק״ג${basis})`;
    }
    return `${value} חזרות (משקל גוף ללא תוספת משקל)`;
  }
  if (metric === 'best_duration' || metric === 'time_for_distance') return formatSeconds(value);
  if (metric === 'max_distance') return `${formatNumber(Math.round((value / 1000) * 100) / 100)} ק״מ`;
  return String(value);
}

export function metricDetailLabel(metric, { loadBasis = null, minReps = null, distanceM = null, timeBasis = null } = {}) {
  const basisSuffix = BASIS_LABELS[loadBasis] ? ` · ${BASIS_LABELS[loadBasis]}` : '';
  if (metric === 'max_load') return `משקל מרבי${basisSuffix}`;
  if (metric === 'actual_1rm') return `1RM בפועל (חזרה אחת)${basisSuffix}`;
  if (metric === 'load_for_min_reps') return `משקל מרבי ל-${minReps ?? 2}+ חזרות (חזרות עם משקל)${basisSuffix}`;
  if (metric === 'max_reps') {
    if (loadBasis) return `מקסימום חזרות עם משקל${basisSuffix}`;
    return 'מקסימום חזרות (משקל גוף — ללא תוספת משקל)';
  }
  if (metric === 'best_duration') return 'זמן ארוך ביותר';
  if (metric === 'max_distance') return 'מרחק מרבי';
  if (metric === 'time_for_distance') {
    const distTxt = distanceM ? `${formatNumber(Math.round((distanceM / 1000) * 100) / 100)} ק״מ` : 'מרחק';
    const tbTxt = timeBasis ? TIME_BASIS_LABELS[timeBasis] ?? timeBasis : TIME_BASIS_LABELS.unknown;
    return `הזמן המהיר ביותר ל-${distTxt} (${tbTxt})`;
  }
  return METRIC_LABELS[metric] ?? metric;
}

/** The best completed set of one session for the timeline (as recorded; not a computed score). */
function bestOfSession(type, sets) {
  const by = (f, g = null) => [...sets].sort((a, b) => (b[f] ?? -1) - (a[f] ?? -1) || (g ? (b[g] ?? -1) - (a[g] ?? -1) : 0))[0];
  if (['weight_reps', 'bodyweight_plus_load'].includes(type)) return by('load', 'reps');
  if (type === 'bodyweight_reps') return by('reps');
  if (type === 'duration') return by('durationSec');
  if (['distance_duration', 'load_distance'].includes(type)) return by('distanceM', 'load');
  return sets[0];
}

/**
 * Progress of one exercise: records (official, with manual records compared on exact keys),
 * estimates labelled as such, and a per-session timeline grouped by load basis / unit (not compared
 * across groups). insufficient: fewer than two dated sessions — no comparison is meaningful yet.
 */
export function exerciseProgress(store, exerciseId) {
  const ex = store.exercises.find((e) => e.id === exerciseId);
  if (!ex) return null;
  const goalNs = store.goals.filter((g) => g.exerciseId === exerciseId && g.metric === 'load_for_min_reps').map((g) => g.target.reps);
  const rows = compareRecords(store, exerciseId, { minReps: goalNs }).map((r) => {
    const c = r.calculated;
    const metric = r.key.split('|')[1];
    const [, , basis, , n] = r.key.split('|');
    const cleanBasis = basis === '-' ? null : basis;
    const minReps = n === '-' ? null : Number(n);
    return {
      key: r.key,
      metric,
      loadBasis: cleanBasis,
      minReps,
      label: metricDetailLabel(metric, { loadBasis: cleanBasis, minReps }),
      calculated: c ? { text: valueText(metric, c.value, { loadBasis: c.loadBasis, reps: c.reps, minReps: c.minReps, load: c.load }), date: c.date, value: c.value } : null,
      manual: r.manual.map((m) => ({
        id: m.id,
        text: valueText(metric, m.value, { loadBasis: cleanBasis, reps: m.reps, repsText: m.repsText, minReps }),
        date: m.date,
        source: m.source,
        note: m.note ?? null,
        value: m.value,
      })),
      higher: r.higher,
    };
  });
  const recs = exerciseRecords(store, exerciseId);
  const sets = completed(store, exerciseId);
  const sessions = new Map();
  for (const x of sets) {
    const key = `${x.session.id}`;
    if (!sessions.has(key)) sessions.set(key, { session: x.session, perf: x.perf, sets: [] });
    sessions.get(key).sets.push(x.set);
  }
  const groups = new Map();
  for (const { session, perf, sets: ss } of sessions.values()) {
    const m = perf.measurement;
    const gk = [m.type, m.loadBasis ?? '-', m.loadUnit ?? '-'].join('|');
    if (!groups.has(gk)) groups.set(gk, { type: m.type, loadBasis: m.loadBasis, loadUnit: m.loadUnit, points: [] });
    const b = bestOfSession(m.type, ss);
    groups.get(gk).points.push({ date: session.date, sessionId: session.id, sets: ss.length, best: { load: b.load, reps: b.reps, durationSec: b.durationSec, distanceM: b.distanceM, loadKg: b.load === null ? null : toKg(b.load, m.loadUnit) } });
  }
  const dk = (d) => d ?? '0000';
  for (const g of groups.values()) g.points.sort((a, b) => (dk(a.date) < dk(b.date) ? -1 : dk(a.date) > dk(b.date) ? 1 : 0));
  const datedSessions = [...sessions.values()].filter((v) => v.session.date !== null).length;
  return {
    id: ex.id,
    name: ex.name,
    displayLabel: exerciseSelectorLabel(ex),
    type: ex.measurement.type,
    records: rows,
    estimates: recs.estimates.map((r) => ({ text: valueText('e1rm', r.value, { loadBasis: r.loadBasis }), date: r.date, reps: r.reps })),
    assumed: recs.assumed.map((r) => ({ label: METRIC_LABELS[r.metric], text: valueText(r.metric, r.value, { loadBasis: r.loadBasis, reps: r.reps }), date: r.date })),
    timeline: [...groups.values()],
    sessions: sessions.size,
    insufficient: datedSessions < 2,
    mixedGroups: groups.size > 1,
  };
}

/** Exact-distance results (e.g. 10K): grouped by time basis, never ranked across groups. */
export function distanceModel(store, { exerciseId = 'ex_run', distanceM = 10000 } = {}) {
  const r = distanceResults(store, { exerciseId, distanceM });
  return Object.entries(r).filter(([, list]) => list.length).map(([basis, list]) => ({
    basis, label: TIME_BASIS_LABELS[basis], best: list[0], results: list.map((x) => ({ text: formatSeconds(x.durationSec), date: x.date, source: x.resultSource })),
  }));
}

/** Goals with their status (values only, no percentages). */
export function goalsModel(store, { archived = false } = {}) {
  const exName = new Map(store.exercises.map((e) => [e.id, e.name]));
  return store.goals.filter((g) => g.archived === archived).map((g) => {
    const st = goalStatus(store, g);
    const t = g.target;
    const targetText = {
      actual_1rm: () => `1RM ${formatNumber(t.load)} ${t.loadUnit === 'lb' ? 'lb' : 'ק״ג'}${BASIS_LABELS[t.loadBasis] ? ` ${BASIS_LABELS[t.loadBasis]}` : ''}`,
      load_for_min_reps: () => `${formatNumber(t.load)} ${t.loadUnit === 'lb' ? 'lb' : 'ק״ג'} × ${t.reps}${BASIS_LABELS[t.loadBasis] ? ` ${BASIS_LABELS[t.loadBasis]}` : ''}`,
      max_distance: () => `${formatNumber(t.distanceM / 1000)} ק״מ`,
      time_for_distance: () => `${formatNumber(t.distanceM / 1000)} ק״מ ב-${formatSeconds(t.durationSec)} (${TIME_BASIS_LABELS[t.timeBasis]})`,
    }[g.metric]();
    const current = {
      actual_1rm: () => (st.currentKg === null ? 'אין עדיין 1RM בפועל' : `הטוב ביותר: ${formatNumber(Math.round(st.currentKg * 10) / 10)} ק״ג`),
      load_for_min_reps: () => (st.mostRepsAtLoad === null ? 'עדיין לא הורם המשקל הזה' : `במשקל הזה: עד ${st.mostRepsAtLoad} חזרות`),
      max_distance: () => (st.longestM === null ? 'אין עדיין מרחק' : `הארוך ביותר: ${formatNumber(st.longestM / 1000)} ק״מ`),
      time_for_distance: () => (st.bestExact ? `הטוב ביותר במרחק המדויק: ${formatSeconds(st.bestExact.durationSec)}` : 'אין עדיין תוצאה במרחק המדויק עם אותו בסיס זמן'),
    }[g.metric]();
    return {
      id: g.id, exerciseId: g.exerciseId, exercise: exName.get(g.exerciseId) ?? g.exerciseId, metric: g.metric, targetText, deadline: g.deadline, source: g.source,
      achieved: st.achieved, achievedText: st.achieved ? (st.dateUnknown ? 'הושג (תאריך לא ידוע)' : `הושג ב-${formatDate(st.achievedAt)}`) : null,
      current, notCounted: st.notCounted?.length ?? 0,
    };
  });
}

/** Goal form: metrics that fit an exercise, and the target fields each needs. */
export const goalFormFor = (type) => goalMetricsFor(type).map((m) => ({
  metric: m,
  label: { actual_1rm: '1RM בפועל', load_for_min_reps: 'משקל × מספר חזרות מינימלי', max_distance: 'מרחק', time_for_distance: 'זמן למרחק' }[m],
  fields: { actual_1rm: ['load'], load_for_min_reps: ['load', 'reps'], max_distance: ['distanceKm'], time_for_distance: ['distanceKm', 'duration', 'timeBasis'] }[m],
}));

// ---- charts (final UI pass) -------------------------------------------------------------------------------
/** The goals page covers only these exercises; goals of other exercises are kept, not shown. */
export const GOAL_EXERCISES = Object.freeze(['ex_bench_press', 'ex_weighted_pull_up', 'ex_run']);

/** Metrics a chart can show for a measurement type: [{ id, label }], first = default. */
export function chartMetrics(type) {
  return {
    weight_reps: [{ id: 'load', label: 'משקל' }, { id: 'reps', label: 'חזרות' }],
    bodyweight_plus_load: [{ id: 'load', label: 'משקל נוסף' }, { id: 'reps', label: 'חזרות' }],
    bodyweight_reps: [{ id: 'reps', label: 'חזרות' }],
    duration: [{ id: 'durationSec', label: 'זמן' }],
    distance_duration: [{ id: 'distanceM', label: 'מרחק' }, { id: 'durationSec', label: 'זמן' }],
    load_distance: [{ id: 'load', label: 'משקל' }, { id: 'distanceM', label: 'מרחק' }],
  }[type] ?? [];
}

/** Text of one chart value. */
export function chartValueText(metric, v, loadUnit = null) {
  if (metric === 'load') return `${formatNumber(Math.round(v * 10) / 10)} ${loadUnit === 'lb' ? 'lb' : 'ק״ג'}`;
  if (metric === 'reps') return `${v} חזרות`;
  if (metric === 'durationSec') return formatSeconds(v);
  if (metric === 'distanceM') return v >= 1000 ? `${formatNumber(Math.round(v / 10) / 100)} ק״מ` : `${formatNumber(v)} מ׳`;
  return String(v);
}

/**
 * The points of one comparable group (same measurement type, load basis and unit) for one metric: the
 * best completed set of each dated session, as recorded. Sessions without a date or without a value for
 * the metric are counted, never plotted. line: a connecting line is only drawn from 3 points.
 */
export function chartSeries(group, metric) {
  const pts = [];
  let undated = 0;
  let noValue = 0;
  for (const x of group.points) {
    const v = x.best[metric];
    if (v === null || v === undefined) { noValue += 1; continue; }
    if (!x.date) { undated += 1; continue; }
    pts.push({ date: x.date, value: v, sessionId: x.sessionId, text: chartValueText(metric, v, group.loadUnit) });
  }
  pts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { metric, points: pts, undated, noValue, line: pts.length >= 3, enough: pts.length >= 2 };
}

/**
 * Weight-over-time cards for the main exercises: Bench Press and Weighted Pull-Up first, then the other
 * weighted exercises with the most history. Only saved, dated sessions; one comparable group per exercise
 * (the one with the most points); an exercise needs at least 3 plotted sessions to get a card.
 */
export const KEY_CHART_MIN_POINTS = 3;
export function keyChartsModel(store, { max = 4 } = {}) {
  const lead = ['ex_bench_press', 'ex_weighted_pull_up'];
  const cards = [];
  for (const e of progressExercises(store)) {
    if (!['weight_reps', 'bodyweight_plus_load'].includes(e.type)) continue;
    const p = exerciseProgress(store, e.id);
    let best = null;
    for (const g of p?.timeline ?? []) {
      if (!['weight_reps', 'bodyweight_plus_load'].includes(g.type)) continue;
      const series = chartSeries(g, 'load');
      if (series.points.length >= KEY_CHART_MIN_POINTS && (!best || series.points.length > best.series.points.length)) best = { g, series };
    }
    if (!best) continue;
    const pts = best.series.points;
    const top = pts.reduce((a, b) => (b.value > a.value ? b : a));
    cards.push({ id: e.id, name: e.name, type: best.g.type, loadBasis: best.g.loadBasis, loadUnit: best.g.loadUnit, series: best.series, count: pts.length, last: pts.at(-1), top });
  }
  const rank = (c) => { const i = lead.indexOf(c.id); return i === -1 ? lead.length + 1 / (c.count + 1) : i; };
  return cards.sort((a, b) => rank(a) - rank(b)).slice(0, max);
}

// ---- Main records (curated list) --------------------------------------------------------------------------
const parseClock = (t) => {
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(t ?? '').trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};

/** The laps (splits) saved with an imported run: [{ km, sec }]; the activity summary row is not a lap. */
function lapsOf(set) {
  const rows = set?.sourceRaw?.rows;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const c = r?.cells ?? {};
    if (String(c.Laps ?? '').trim() === 'Summary' || c.Laps === undefined) continue;
    const km = Number(String(c['Distance km']).replace(',', '.'));
    const sec = parseClock(c.Time);
    if (Number.isFinite(km) && sec !== null) out.push({ km, sec });
  }
  return out;
}

const RUN_TARGETS = Object.freeze([{ km: 1, label: '1 ק״מ' }, { km: 5, label: '5 ק״מ' }, { km: 10, label: '10 ק״מ' }]);
const FULL_KM_SPLIT_MIN = 0.95; // a steady-run split: shorter laps are recoveries / walking and never form a record

/**
 * Fastest time over 1, 5 and 10 km, from the saved splits of runs:
 *  - 1 km: the fastest single split of exactly 1.00 km;
 *  - 5 / 10 km: the fastest stretch of consecutive full-km splits that adds up to the distance (±0.02 km);
 *  - a run saved without splits counts only when its total distance is that distance (±0.01 km).
 * Times are as recorded (never scaled). Returns [{ km, label, sec|null, date, source }].
 */
export function runSplitRecords(store, exerciseId = 'ex_run') {
  const best = new Map(RUN_TARGETS.map((t) => [t.km, null]));
  const offer = (km, sec, date, sessionId, source) => {
    const cur = best.get(km);
    if (!cur || sec < cur.sec || (sec === cur.sec && (date ?? '9') < (cur.date ?? '9'))) best.set(km, { sec, date, sessionId, source });
  };
  for (const ses of store.sessions) {
    if (!ses.date) continue;
    for (const p of ses.performances) {
      if (p.exerciseId !== exerciseId || p.measurement?.type === 'unresolved') continue;
      for (const set of p.sets) {
        if (!set.completed || hasUnreliable(set)) continue;
        const laps = lapsOf(set);
        if (laps.length) {
          for (const l of laps) if (Math.abs(l.km - 1) < 0.005) offer(1, l.sec, ses.date, ses.id, 'split');
          for (const t of RUN_TARGETS.filter((x) => x.km > 1)) {
            for (let i = 0; i < laps.length; i += 1) {
              let km = 0;
              let sec = 0;
              for (let j = i; j < laps.length && laps[j].km >= FULL_KM_SPLIT_MIN; j += 1) {
                km += laps[j].km; sec += laps[j].sec;
                if (Math.abs(km - t.km) <= 0.02) { offer(t.km, sec, ses.date, ses.id, 'split'); break; }
                if (km > t.km + 0.02) break;
              }
            }
          }
        } else if (set.distanceM && set.durationSec) {
          for (const t of RUN_TARGETS) if (Math.abs(set.distanceM - t.km * 1000) <= 10) offer(t.km, set.durationSec, ses.date, ses.id, 'activity');
        }
      }
    }
  }
  return RUN_TARGETS.map((t) => ({ km: t.km, label: t.label, ...(best.get(t.km) ?? { sec: null, date: null, sessionId: null, source: null }) }));
}

const hasUnreliable = (set) => Array.isArray(set?.warnings) && set.warnings.some((w) => ['CSV_LOAD_SEMANTICS_UNRESOLVED', 'CSV_NO_LOAD', 'CSV_ZERO_REPS', 'V1_UNVERIFIED'].includes(w));


/**
 * The records Tal follows. Strength records are only what he recorded himself (manual records) — a set in a
 * workout is never a record, and nothing is estimated; a record he has not entered stays empty:
 *  Bench: 1RM, max reps at 60 kg · Weighted Pull-Up: 1RM, max bodyweight reps · Ring Dip: bodyweight reps ·
 *  Deadlift: 1RM.  Run (1 / 5 / 10 km) comes from the saved splits of his runs.
 * Rows: { id, group, label, value|null, note|null, date|null, kind: 'manual'|'split'|'activity'|'empty' }.
 */
export function mainRecordsModel(store) {
  const rows = [];
  const find = (id) => store.exercises.find((e) => e.id === id && e.measurement.type !== 'unresolved') ?? null;
  const kgText = (v) => `${formatNumber(Math.round(v * 10) / 10)} ק״ג`;
  const manual = (ex) => (ex ? (store.manualRecords ?? []).filter((m) => m.exerciseId === ex.id) : []);
  const push = (id, group, label, best, text) => rows.push(best
    ? { id, group, label, value: text(best), note: 'ידני', date: best.date ?? null, kind: 'manual' }
    : { id, group, label, value: null, note: null, date: null, kind: 'empty' });
  const top = (list, key) => list.reduce((a, b) => (!a || key(b) > key(a) ? b : a), null);
  const oneRm = (id, group, ex, { added = false } = {}) => {
    const list = manual(ex).filter((m) => (m.metric === 'actual_1rm' || (m.metric === 'max_load' && m.reps === 1)) && m.load > 0 && (!added || m.loadBasis === 'added'));
    push(`${id}:1rm`, group, '1RM', top(list, (m) => toKg(m.load, m.loadUnit ?? 'kg')), (m) => `${added ? '+' : ''}${kgText(toKg(m.load, m.loadUnit ?? 'kg'))}`);
  };
  const reps = (id, group, ex, label, pred) => {
    const list = manual(ex).filter((m) => m.metric === 'max_reps' && m.reps > 0 && pred(m));
    push(id, group, label, top(list, (m) => m.reps), (m) => `${m.reps} חזרות`);
  };
  const bench = find('ex_bench_press');
  oneRm('bench', 'Bench Press', bench);
  reps('bench:reps60', 'Bench Press', bench, 'חזרות ב-60 ק״ג', (m) => m.load === 60);
  const pull = find('ex_weighted_pull_up');
  oneRm('pullup', 'Weighted Pull-Up', pull, { added: true });
  reps('pullup:bw', 'Weighted Pull-Up', pull, 'חזרות משקל גוף', (m) => (m.loadBasis ?? null) === null && !m.load);
  const ring = store.exercises.find((e) => /ring\s*dip/i.test(e.name) && !e.archived && e.measurement.type !== 'unresolved') ?? null;
  reps('ringdip:bw', 'Ring Dip', ring, 'חזרות משקל גוף', (m) => (m.loadBasis ?? null) === null && !m.load);
  oneRm('deadlift', 'Deadlift', find('ex_deadlift'));
  for (const r of runSplitRecords(store)) {
    rows.push({ id: `run:${r.km}`, group: 'Run', label: r.label, value: r.sec === null ? null : formatSeconds(Math.round(r.sec)), note: r.source === 'activity' ? 'ללא ספליטים' : null, date: r.date, kind: r.source ?? 'empty', sessionId: r.sessionId ?? null });
  }
  return rows;
}

// ---- Personal Records (PR) View Model ---------------------------------------------------------------------

/** Active exercises selectable for manual PRs, prioritizing trained exercises first. */
export function manualRecordExercises(store) {
  const trainedCounts = new Map();
  for (const s of store.sessions ?? []) {
    for (const p of s.performances ?? []) {
      if (isUnresolvedPerf(store, p)) continue;
      trainedCounts.set(p.exerciseId, (trainedCounts.get(p.exerciseId) ?? 0) + 1);
    }
  }
  return (store.exercises ?? [])
    .filter((e) => !e.archived && e.mergedInto === null && !['unresolved', 'note'].includes(e.measurement?.type))
    .map((e) => ({
      id: e.id,
      name: e.name,
      displayLabel: exerciseSelectorLabel(e),
      group: e.group,
      type: e.measurement.type,
      loadBasis: e.measurement.loadBasis,
      loadUnit: e.measurement.loadUnit,
      trainedSessions: trainedCounts.get(e.id) ?? 0,
    }))
    .sort((a, b) => (b.trainedSessions !== a.trainedSessions ? b.trainedSessions - a.trainedSessions : a.name.localeCompare(b.name)));
}

/** Measurement options supported for a manual record on a given exercise. */
export function manualRecordMetricOptions(ex) {
  const type = ex?.measurement?.type;
  if (type === 'bodyweight_plus_load') {
    return [
      { metric: 'max_reps', label: 'מקסימום חזרות (משקל גוף — ללא תוספת משקל)', fields: ['reps'], requiresLoad: false },
      { metric: 'load_for_min_reps', label: 'שיא משקל לחזרות (תוספת משקל + חזרות)', fields: ['load', 'reps'], requiresLoad: true },
      { metric: 'max_load', label: 'משקל מרבי (תוספת משקל)', fields: ['load', 'repsOptional'], requiresLoad: true },
      { metric: 'actual_1rm', label: '1RM בפועל · חזרה אחת (תוספת משקל)', fields: ['load'], requiresLoad: true },
    ];
  }
  if (type === 'bodyweight_reps') {
    return [
      { metric: 'max_reps', label: 'מקסימום חזרות (משקל גוף — ללא משקל)', fields: ['reps'], requiresLoad: false },
    ];
  }
  if (type === 'weight_reps') {
    return [
      { metric: 'max_load', label: 'משקל מרבי', fields: ['load', 'repsOptional'], requiresLoad: true },
      { metric: 'load_for_min_reps', label: 'שיא משקל לחזרות (משקל + חזרות)', fields: ['load', 'reps'], requiresLoad: true },
      { metric: 'actual_1rm', label: '1RM בפועל (חזרה אחת)', fields: ['load'], requiresLoad: true },
      { metric: 'max_reps', label: 'מקסימום חזרות (ללא משקל)', fields: ['reps'], requiresLoad: false },
    ];
  }
  if (type === 'distance_duration') {
    return [
      { metric: 'max_distance', label: 'מרחק מרבי', fields: ['distanceKm'], requiresLoad: false },
      { metric: 'time_for_distance', label: 'הזמן המהיר ביותר למרחק', fields: ['distanceKm', 'duration', 'timeBasis'], requiresLoad: false },
    ];
  }
  if (type === 'duration') {
    return [
      { metric: 'best_duration', label: 'הזמן הארוך ביותר', fields: ['duration'], requiresLoad: false },
    ];
  }
  if (type === 'load_distance') {
    return [
      { metric: 'max_load', label: 'משקל מרבי', fields: ['load'], requiresLoad: true },
      { metric: 'max_distance', label: 'מרחק מרבי', fields: ['distanceKm'], requiresLoad: false },
    ];
  }
  return [];
}

/**
 * Builds the Personal Records section model grouped by exercise and measurement type.
 * Preserves both automatic workout-derived records and manual records when both exist.
 */
export function personalRecordsModel(store, { filterExerciseId = null } = {}) {
  const activeExercises = manualRecordExercises(store);
  const groups = [];

  for (const exInfo of activeExercises) {
    if (filterExerciseId && exInfo.id !== filterExerciseId) continue;
    const goalNs = (store.goals ?? []).filter((g) => g.exerciseId === exInfo.id && g.metric === 'load_for_min_reps').map((g) => g.target.reps);
    const stdRows = compareRecords(store, exInfo.id, { minReps: goalNs });
    const timeRows = compareTimeForDistanceRecords(store, exInfo.id);

    const recordItems = [];

    for (const r of stdRows) {
      const [, metric, rawBasis, unit, rawN] = r.key.split('|');
      const loadBasis = rawBasis === '-' ? null : rawBasis;
      const minReps = rawN === '-' ? null : Number(rawN);
      const calc = r.calculated
        ? {
            value: r.calculated.value,
            text: valueText(metric, r.calculated.value, {
              loadBasis: r.calculated.loadBasis ?? loadBasis,
              reps: r.calculated.reps ?? null,
              minReps: r.calculated.minReps ?? minReps,
              load: r.calculated.load ?? null,
            }),
            date: r.calculated.date ?? null,
            reps: r.calculated.reps ?? null,
            load: r.calculated.load ?? null,
            sourceLabel: 'אוטומטי (אימון)',
          }
        : null;

      const manualList = r.manual
        .slice()
        .sort((a, b) => b.value - a.value)
        .map((m) => ({
          id: m.id,
          value: m.value,
          text: valueText(metric, m.value, {
            loadBasis,
            reps: m.reps,
            repsText: m.repsText,
            minReps,
          }),
          date: m.date ?? null,
          note: m.note ?? null,
          source: m.source,
          sourceLabel: m.source === 'personal_seed' ? 'ידני (ייבוא אישי)' : 'ידני',
        }));

      const bestManual = manualList[0] ?? null;
      const best =
        r.higher === 'calculated' && calc
          ? { text: calc.text, date: calc.date, sourceKind: 'calculated', sourceLabel: 'אוטומטי (אימון)', note: null }
          : r.higher === 'manual' && bestManual
            ? { text: bestManual.text, date: bestManual.date, sourceKind: 'manual', sourceLabel: bestManual.sourceLabel, note: bestManual.note }
            : calc && bestManual
              ? { text: calc.text, date: calc.date ?? bestManual.date, sourceKind: 'equal', sourceLabel: 'אוטומטי + ידני (זהה)', note: bestManual.note }
              : null;

      if (!best) continue;
      recordItems.push({
        key: r.key,
        metric,
        unit,
        loadBasis,
        minReps,
        label: metricDetailLabel(metric, { loadBasis, minReps }),
        higher: r.higher,
        best,
        calculated: calc,
        manual: bestManual,
        manualList,
        coexists: calc !== null && manualList.length > 0,
      });
    }

    for (const tr of timeRows) {
      const calc = tr.calculated
        ? {
            value: tr.calculated.durationSec,
            text: formatSeconds(tr.calculated.durationSec),
            date: tr.calculated.date ?? null,
            sourceLabel: 'אוטומטי (אימון)',
          }
        : null;
      const manualList = (tr.manualAll ?? []).map((m) => ({
        id: m.id,
        value: m.durationSec,
        text: formatSeconds(m.durationSec),
        date: m.date ?? null,
        note: m.note ?? null,
        source: m.source,
        sourceLabel: m.source === 'personal_seed' ? 'ידני (ייבוא אישי)' : 'ידני',
      }));
      const bestManual = manualList[0] ?? null;
      const best =
        tr.higher === 'calculated' && calc
          ? { text: calc.text, date: calc.date, sourceKind: 'calculated', sourceLabel: 'אוטומטי (אימון)', note: null }
          : tr.higher === 'manual' && bestManual
            ? { text: bestManual.text, date: bestManual.date, sourceKind: 'manual', sourceLabel: bestManual.sourceLabel, note: bestManual.note }
            : calc && bestManual
              ? { text: calc.text, date: calc.date ?? bestManual.date, sourceKind: 'equal', sourceLabel: 'אוטומטי + ידני (זהה)', note: bestManual.note }
              : null;
      if (!best) continue;
      recordItems.push({
        key: tr.key,
        metric: 'time_for_distance',
        unit: 'sec',
        loadBasis: tr.timeBasis,
        distanceM: tr.distanceM,
        timeBasis: tr.timeBasis,
        label: metricDetailLabel('time_for_distance', { distanceM: tr.distanceM, timeBasis: tr.timeBasis }),
        higher: tr.higher,
        best,
        calculated: calc,
        manual: bestManual,
        manualList,
        coexists: calc !== null && manualList.length > 0,
      });
    }

    if (recordItems.length > 0) {
      groups.push({
        exerciseId: exInfo.id,
        exerciseName: exInfo.name,
        displayLabel: exInfo.displayLabel,
        group: exInfo.group,
        type: exInfo.type,
        records: recordItems,
      });
    }
  }

  return {
    groups,
    exercises: activeExercises,
    totalRecordCount: groups.reduce((acc, g) => acc + g.records.length, 0),
    manualRecordCount: (store.manualRecords ?? []).length,
  };
}

// ---- Weekly and Monthly Period Comparisons View Model -----------------------------------------------------

const HEBREW_MONTH_NAMES = Object.freeze([
  '', 'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
]);

export function formatPeriodLabel(period) {
  if (!period) return '';
  const statusTag = period.isFuture ? ' · תקופה עתידית' : period.isPartial ? ' · תקופה חלקית' : '';
  if (period.mode === 'month') {
    const mName = HEBREW_MONTH_NAMES[period.month] ?? String(period.month);
    return `${mName} ${period.year} (${formatDate(period.startDate)} – ${formatDate(period.endDate)})${statusTag}`;
  }
  return `שבוע א׳–ש׳: ${formatDate(period.startDate)} – ${formatDate(period.endDate)}${statusTag}`;
}

export function formatDeltaNumber(delta, suffix = '') {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'לא ניתן להשוואה';
  if (delta === 0) return `ללא שינוי (0${suffix})`;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatNumber(delta)}${suffix}`;
}

export function periodComparisonModel(store, { mode = 'week', periodA = null, periodB = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const cleanMode = mode === 'month' ? 'month' : 'week';
  const includeKeys = [periodA, periodB].filter(Boolean);
  const options = cleanMode === 'month'
    ? availableMonths(store, { today, includeKeys })
    : availableWeeks(store, { today, includeKeys });

  // Choose sensible defaults if periodB or periodA is not yet set:
  // Default periodB = most recent period with workouts (or options[0]),
  // Default periodA = previous period with workouts (or options[1] ?? options[0]).
  const withWorkouts = options.filter((o) => o.workoutCount > 0);
  const defaultB = withWorkouts[0]?.key ?? options[0]?.key ?? today;
  const defaultA = withWorkouts[1]?.key ?? options.find((o) => o.key !== defaultB)?.key ?? defaultB;

  const selB = periodB && options.some((o) => o.key === periodB) ? periodB : periodB || defaultB;
  const selA = periodA && options.some((o) => o.key === periodA) ? periodA : periodA || defaultA;

  const cmp = comparePeriods(store, { mode: cleanMode, periodA: selA, periodB: selB, today });

  const decorateSummary = (p) => {
    let actualRangeText = '';
    let statusBadge = '';
    let frequencyText = '';
    let volumeText = '';

    if (p.isFuture) {
      actualRangeText = 'תקופה עתידית (טרם החלה)';
      statusBadge = 'תקופה עתידית (טרם החלה)';
      frequencyText = '0 אימונים (תקופה עתידית)';
      volumeText = 'אין נתונים (תקופה עתידית)';
    } else if (p.isPartial) {
      actualRangeText = `${formatDate(p.actualStartDate)} עד ${formatDate(p.actualEndDate)} (מתוך ${formatDate(p.startDate)} – ${formatDate(p.endDate)} · ${p.elapsedDays}/${p.totalDays} ימים)`;
      statusBadge = 'תקופה חלקית (טרם הסתיימה)';
      frequencyText = p.workoutCount === 0
        ? '0 אימונים בתקופה זו'
        : `${p.workoutCount} אימונים · ${p.activeDays}/${p.elapsedDays} ימים פעילים (${formatNumber(p.workoutsPerWeek)} אימונים לשבוע בממוצע)`;
      volumeText = p.volume.volumeKg !== null
        ? `${formatNumber(p.volume.volumeKg)} ק״ג (${p.volume.countedSets}/${p.volume.totalCompletedSets} סטים ברי-השוואה)`
        : p.workoutCount === 0
          ? 'אין אימונים בתקופה'
          : `אין נתוני נפח ברי-השוואה (0/${p.volume.totalCompletedSets} סטים)`;
    } else {
      actualRangeText = `${formatDate(p.startDate)} עד ${formatDate(p.endDate)} (${p.totalDays} ימים מלאים)`;
      statusBadge = 'תקופה מלאה';
      frequencyText = p.workoutCount === 0
        ? '0 אימונים בתקופה זו'
        : `${p.workoutCount} אימונים · ${p.activeDays}/${p.elapsedDays} ימים פעילים (${formatNumber(p.workoutsPerWeek)} אימונים לשבוע בממוצע)`;
      volumeText = p.volume.volumeKg !== null
        ? `${formatNumber(p.volume.volumeKg)} ק״ג (${p.volume.countedSets}/${p.volume.totalCompletedSets} סטים ברי-השוואה)`
        : p.workoutCount === 0
          ? 'אין אימונים בתקופה'
          : `אין נתוני נפח ברי-השוואה (0/${p.volume.totalCompletedSets} סטים)`;
    }

    return {
      ...p,
      title: formatPeriodLabel(p),
      actualRangeText,
      statusBadge,
      frequencyText,
      volumeText,
      newRecordsFormatted: p.newRecords.map((r) => ({
        ...r,
        metricLabel: metricDetailLabel(r.metric, { loadBasis: r.loadBasis, minReps: r.minReps, distanceM: r.distanceM, timeBasis: r.loadBasis }),
        valueText: valueText(r.metric, r.value, { loadBasis: r.loadBasis, reps: r.reps, minReps: r.minReps, load: r.load }),
        sourceLabel: r.source === 'manual' ? 'שיא ידני' : 'שיא אימון',
      })),
    };
  };

  const summaryA = decorateSummary(cmp.periodA);
  const summaryB = decorateSummary(cmp.periodB);

  const formatExSummary = (entry) => {
    if (!entry) return 'לא בוצע בתקופה זו';
    if (entry.measurementType === 'weight_reps' || entry.measurementType === 'bodyweight_plus_load') {
      const basis = BASIS_LABELS[entry.loadBasis] ? ` (${BASIS_LABELS[entry.loadBasis]})` : '';
      const loadPart = entry.maxLoadKg !== null
        ? `שיא תקופתי: ${formatNumber(entry.maxLoadKg)} ק״ג${entry.repsAtMaxLoad ? ` × ${entry.repsAtMaxLoad}` : ''}${basis}`
        : '';
      const repsPart = entry.maxReps !== null ? `מקס׳ חזרות: ${entry.maxReps}` : '';
      return [loadPart, repsPart, `${entry.sessionCount} אימונים (${entry.setCount} סטים)`].filter(Boolean).join(' · ');
    }
    if (entry.measurementType === 'bodyweight_reps') {
      return `מקס׳ חזרות (משקל גוף): ${entry.maxReps} · סה״כ: ${entry.totalReps} חזרות (${entry.sessionCount} אימונים, ${entry.setCount} סטים)`;
    }
    if (entry.measurementType === 'distance_duration') {
      const totKm = entry.totalDistanceM !== null ? `${formatNumber(Math.round((entry.totalDistanceM / 1000) * 100) / 100)} ק״מ סה״כ` : '';
      const maxKm = entry.maxDistanceM !== null ? `ארוכה ביותר: ${formatNumber(Math.round((entry.maxDistanceM / 1000) * 100) / 100)} ק״מ` : '';
      const pace = entry.bestMovingPaceSecPerKm !== null
        ? `קצב תנועה מיטבי: ${formatSeconds(entry.bestMovingPaceSecPerKm)}/ק״מ`
        : entry.bestElapsedPaceSecPerKm !== null
          ? `קצב כולל מיטבי: ${formatSeconds(entry.bestElapsedPaceSecPerKm)}/ק״מ`
          : '';
      return [totKm, maxKm, pace, `${entry.sessionCount} ריצות`].filter(Boolean).join(' · ');
    }
    if (entry.measurementType === 'duration') {
      return `זמן מרבי: ${formatSeconds(entry.maxDurationSec)} (${entry.sessionCount} אימונים)`;
    }
    if (entry.measurementType === 'load_distance') {
      return `${formatNumber(entry.maxLoadKg)} ק״ג · ${formatNumber(entry.maxDistanceM)} מ׳ (${entry.sessionCount} אימונים)`;
    }
    return `${entry.sessionCount} אימונים (${entry.setCount} סטים)`;
  };

  const formatExDelta = (exCmp) => {
    if (!exCmp.comparable) return 'בוצע רק באחת מהתקופות — אין השוואה ישירה';
    const d = exCmp.deltas;
    const parts = [];
    if (d.loadDeltaKg !== null) parts.push(`משקל מרבי: ${formatDeltaNumber(d.loadDeltaKg, ' ק״ג')}`);
    if (d.repsAtMaxLoadDelta !== null && d.loadDeltaKg === 0 && d.repsAtMaxLoadDelta !== 0) {
      parts.push(`חזרות במשקל המרבי: ${formatDeltaNumber(d.repsAtMaxLoadDelta, ' חזרות')}`);
    }
    if (d.maxRepsDelta !== null) parts.push(`מקסימום חזרות: ${formatDeltaNumber(d.maxRepsDelta, ' חזרות')}`);
    if (d.totalDistanceDeltaM !== null) parts.push(`מרחק מצטבר: ${formatDeltaNumber(Math.round((d.totalDistanceDeltaM / 1000) * 100) / 100, ' ק״מ')}`);
    if (d.maxDistanceDeltaM !== null) parts.push(`מרחק מרבי: ${formatDeltaNumber(Math.round((d.maxDistanceDeltaM / 1000) * 100) / 100, ' ק״מ')}`);
    if (d.maxDurationDeltaSec !== null) parts.push(`משך מרבי: ${formatDeltaNumber(d.maxDurationDeltaSec, ' שניות')}`);
    return parts.length > 0 ? parts.join(' · ') : 'ללא שינוי';
  };

  const measurementGroupLabel = (exCmp) => {
    if (exCmp.measurementType === 'bodyweight_reps') return 'חזרות משקל גוף (ללא משקל נוסף)';
    if (exCmp.measurementType === 'bodyweight_plus_load') return 'תוספת משקל (ק״ג + חזרות)';
    if (exCmp.measurementType === 'weight_reps') {
      const b = BASIS_LABELS[exCmp.loadBasis];
      return b ? `משקל וחזרות (${b})` : 'משקל וחזרות (משקל כולל)';
    }
    if (exCmp.measurementType === 'distance_duration') return 'מרחק וזמן';
    if (exCmp.measurementType === 'duration') return 'משך זמן';
    if (exCmp.measurementType === 'load_distance') return 'משקל ומרחק';
    return exCmp.measurementType;
  };

  return {
    mode: cleanMode,
    today,
    selectedA: summaryA.key,
    selectedB: summaryB.key,
    options: options.map((o) => ({
      key: o.key,
      label: `${formatPeriodLabel(o)} · ${o.workoutCount} אימונים`,
      isPartial: o.isPartial,
      workoutCount: o.workoutCount,
    })),
    periodA: summaryA,
    periodB: summaryB,
    workoutDelta: cmp.workoutDelta,
    workoutDeltaText: formatDeltaNumber(cmp.workoutDelta, ' אימונים'),
    activeDaysDelta: cmp.activeDaysDelta,
    activeDaysDeltaText: formatDeltaNumber(cmp.activeDaysDelta, ' ימים פעילים'),
    volumeComparison: {
      ...cmp.volumeComparison,
      deltaText: cmp.volumeComparison.comparable
        ? formatDeltaNumber(cmp.volumeComparison.deltaKg, ' ק״ג')
        : 'לא ניתן להשוות נפח (חסרים נתוני נפח ברי-השוואה באחת התקופות או בשתיהן)',
    },
    exerciseComparisons: cmp.exerciseComparisons.map((exCmp) => ({
      ...exCmp,
      groupLabel: measurementGroupLabel(exCmp),
      summaryAText: formatExSummary(exCmp.periodA),
      summaryBText: formatExSummary(exCmp.periodB),
      deltaText: formatExDelta(exCmp),
    })),
  };
}
