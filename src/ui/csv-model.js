// Step 2f — pure models for the Garmin CSV import screen (decisions, options, missing items in Hebrew).
// The import rules live in src/import (not reachable from the UI, UI-S2): the analysis carries the
// constants the screen needs, and the facade's previewGarminCsv reports what is still missing.
import { BASIS_LABELS } from './progress-model.js';

export const ACTIVITY_KIND_LABELS = Object.freeze({ sets: 'כוח', rounds: 'HIIT (סבבים)', run: 'ריצה' });
export const ACTIVITY_STATUS_LABELS = Object.freeze({
  new: 'חדשה', empty: 'ריקה (ללא תרגיל וערכים)', same_date: 'יש כבר אימון באותו תאריך', already: 'כבר יובאה — תדלג',
});
export const UNRESOLVED_CHOICE = 'unresolved';
export const IGNORE_CHOICE = 'ignore';

/** Exercises a Garmin name (or row) may be mapped to: active, resolved, of a fitting type. */
export function targetOptions(store, analysis, { run = false } = {}) {
  const types = run ? analysis.constants.runTypes : analysis.constants.rowTypes;
  return store.exercises
    .filter((e) => !e.archived && e.mergedInto === null && types.includes(e.measurement.type))
    .map((e) => ({ id: e.id, name: e.name, group: e.group ?? '', type: e.measurement.type }))
    .sort((a, b) => a.group.localeCompare(b.group, 'he') || a.name.localeCompare(b.name));
}

/** How Garmin's weight is read for an exercise: its own basis, or unknown. */
export function loadChoices(exercise) {
  const b = exercise.measurement.loadBasis;
  const basis = b === 'added' ? 'משקל נוסף (על משקל הגוף)' : b === 'total' ? 'המשקל הכולל' : `המשקל ${BASIS_LABELS[b] ?? b}`;
  return [
    { value: 'basis', label: `המשקל ב-Garmin הוא ${basis}` },
    { value: 'unknown', label: 'לא ידוע — לשמור רק את הערך המקורי' },
  ];
}

/** How Garmin's weight is read for a newly accepted custom Garmin exercise (`new:<name>`). */
export function newLoadChoices() {
  return [
    { value: 'total', label: 'המשקל הכולל (מוט / מכונה / שני הצדדים יחד)' },
    { value: 'per_hand', label: 'משקל לכל יד' },
    { value: 'per_side', label: 'משקל לכל צד' },
    { value: 'implement', label: 'משקל לכלי' },
    { value: 'added', label: 'משקל נוסף (על משקל הגוף)' },
    { value: 'unknown', label: 'לא ידוע — לשמור רק את הערך המקורי' },
  ];
}

/** The exercises whose load meaning must be confirmed (from the missing list). */
export const loadDecisionsNeeded = (missing) => missing.filter((m) => m.kind === 'load').map((m) => m.ref);

const MISSING_TEXT = {
  dates: () => 'אשר שהתאריכים נכונים',
  unit: () => 'אשר את יחידת המשקל',
  mixed_units: (r) => `בקובץ יש כמה יחידות משקל (${r}) — לא ניתן לייבא אותו כך`,
  run_time: () => 'בחר איזה זמן לרשום לריצות',
  name: (r) => `בחר תרגיל עבור "${r}"`,
  load: (r, store) => `בחר איך לקרוא את המשקל של ${typeof r === 'string' && r.startsWith('new:') ? r.slice(4) : store.exercises.find((e) => e.id === r)?.name ?? r}`,
  activity: (r) => `בחר מה לעשות בפעילות ${r}`,
  invalid_target: (r) => `התרגיל שנבחר לשורה ${r} אינו מתאים`,
};
/** Missing decisions as Hebrew lines (first-seen order). */
export const missingText = (missing, store) => missing.map((m) => (MISSING_TEXT[m.kind]?.(m.ref, store) ?? m.kind));

/** The name a row shows in the per-row list. */
export const itemLabel = (it) => (it.run ? `ריצה · ${it.distanceKm ?? '—'} ק״מ · ${it.laps} הקפות` : `${it.name || '(ללא שם)'}${it.reps !== null ? ` · ${it.reps} חזרות` : ''}${it.weightRaw ? ` · ${it.weightRaw}` : ''}`);

/** The default target of an item, before a row override (null = unresolved, 'ignore' = ignored, undefined = undecided). */
export function nameTarget(it, decisions, analysis) {
  if (it.name === analysis.constants.choose || it.name === '' || it.roundOnly) {
    const key = it.roundOnly ? 'Round' : it.name;
    if (Object.hasOwn(decisions.names, key) && decisions.names[key] === IGNORE_CHOICE) return IGNORE_CHOICE;
    return null;
  }
  const key = it.run ? analysis.constants.runName : it.name;
  if (!Object.hasOwn(decisions.names, key)) return undefined;
  return decisions.names[key] === UNRESOLVED_CHOICE ? null : decisions.names[key];
}

/** Sets a decision immutably: path like ['names', 'Curl'] → value; value undefined removes the key. */
export function setDecision(decisions, path, value) {
  const next = structuredClone(decisions);
  if (path.length === 1) {
    if (value === undefined) delete next[path[0]];
    else next[path[0]] = value;
    return next;
  }
  const [group, key] = path;
  next[group] = { ...next[group] };
  if (value === undefined) delete next[group][key];
  else next[group][key] = value;
  return next;
}
