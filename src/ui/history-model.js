// Step 2d.5 — History: pure read models over the snapshot store (list and workout details).
// Nothing is computed beyond display: values are shown as stored; pace is the display-only pace of
// derive/units (never used for records); splits are shown with core's usability rules.
import { displayPacePerKm, formatDuration } from '../derive/units.js';
import { usableSplits } from '../derive/splits.js';
import { uncopyablePerformances } from '../core/active-session.js';
import { setText, setFields } from './workout-model.js';
import { formatNumber } from './format.js';
import { IMPORT_KIND_LABELS } from './flow-model.js';

export const ORIGIN_LABELS = Object.freeze({ app: null, v1_migration: 'מיובא מהאפליקציה הקודמת', v1_late_import: 'ייבוא נוסף מהאפליקציה הקודמת', csv_import: 'מיובא מ-Garmin' });
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

const isUnresolved = (store, p) => p.measurement.type === 'unresolved' || store.exercises.find((e) => e.id === p.exerciseId)?.measurement.type === 'unresolved';
const hasData = (x) => ['load', 'reps', 'durationSec', 'distanceM'].some((f) => x[f] !== null && x[f] !== undefined);
const titleOf = (s) => s.templateNameSnapshot ?? null;

/** Newest first: by date (sessions without a date last), then by start / creation time. */
export function compareSessions(a, b) {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  const ka = a.startedAt ?? a.createdAt ?? '';
  const kb = b.startedAt ?? b.createdAt ?? '';
  return ka === kb ? (a.id < b.id ? 1 : -1) : ka < kb ? 1 : -1;
}

export const monthLabel = (date) => (typeof date === 'string' ? `${HE_MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}` : 'ללא תאריך');

/**
 * The history list (all saved sessions, newest first). Rows are light: built for long histories.
 * @returns {{ total:number, rows: {id, date, month, title, exercises:string[], exerciseCount, sets, origin, originLabel, recovered, unresolved}[] }}
 */
export function historyList(store, { limit = Infinity } = {}) {
  const exName = new Map(store.exercises.map((e) => [e.id, e.name]));
  const sorted = [...store.sessions].sort(compareSessions);
  const rows = sorted.slice(0, limit).map((s) => {
    const perfs = [...s.performances].sort((a, b) => a.order - b.order);
    return {
      id: s.id,
      date: s.date,
      month: monthLabel(s.date),
      title: titleOf(s),
      exercises: perfs.map((p) => p.nameSnapshot ?? exName.get(p.exerciseId) ?? p.exerciseId),
      exerciseCount: perfs.length,
      sets: perfs.reduce((n, p) => n + p.sets.filter((x) => x.completed && hasData(x)).length, 0),
      origin: s.origin,
      originLabel: ORIGIN_LABELS[s.origin] ?? null,
      recovered: s.recovery !== null && s.recovery !== undefined,
      unresolved: perfs.filter((p) => isUnresolved(store, p)).length,
    };
  });
  return { total: sorted.length, rows };
}

function splitRows(set) {
  const { usable, rejected } = usableSplits(set);
  const all = [...usable.map((s) => ({ s, ok: true })), ...rejected.map((r) => ({ s: r.split, ok: false }))].sort((a, b) => a.s.distanceM - b.s.distanceM);
  return all.map(({ s, ok }) => ({ text: `${formatNumber(s.distanceM / 1000)} ק״מ · ${formatDuration(s.timeSec)}`, usable: ok }));
}

/** Everything the detail screen shows for one saved session; null when it does not exist. */
export function sessionDetail(store, sessionId) {
  const s = store.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const exName = new Map(store.exercises.map((e) => [e.id, e.name]));
  const entry = s.provenance?.importId ? store.meta.importLog.find((e) => e.importId === s.provenance.importId) : null;
  const a = store.activeSession;
  return {
    id: s.id,
    date: s.date,
    title: titleOf(s),
    note: s.note,
    origin: s.origin,
    originLabel: ORIGIN_LABELS[s.origin] ?? null,
    importText: entry ? `${IMPORT_KIND_LABELS[entry.kind] ?? entry.kind} · ${entry.at.slice(0, 10)}` : null,
    recovery: s.recovery ?? null,
    warnings: s.warnings ?? [],
    performances: [...s.performances].sort((x, y) => x.order - y.order).map((p) => {
      const unresolved = isUnresolved(store, p);
      return {
        id: p.id,
        order: p.order,
        name: p.nameSnapshot ?? exName.get(p.exerciseId) ?? p.exerciseId,
        type: p.measurement.type,
        unresolved,
        labels: unresolved ? [] : setFields(p.measurement).map((f) => f.label),
        note: p.note,
        sets: [...p.sets].sort((x, y) => x.order - y.order).map((x) => ({
          id: x.id,
          order: x.order,
          completed: x.completed,
          text: unresolved ? null : setText(x, p.measurement),
          pace: p.measurement.type === 'distance_duration' ? displayPacePerKm(x.durationSec, x.distanceM) : null,
          basis: x.durationBasis ?? null,
          splits: splitRows(x),
          source: x.sourceRaw !== undefined && x.sourceRaw !== null ? x.sourceRaw : null,
          warnings: x.warnings ?? [],
        })),
      };
    }),
    editable: !a,
    activeIsThis: a?.mode === 'edit' && a.editsSessionId === s.id,
    uncopyable: uncopyablePerformances(store, s.id).length,
  };
}
