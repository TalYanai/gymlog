// Step 2d.1 — pure models for the startup, migration, import, recovery and error screens of the
// approved 2a design (S0–S9, R, E), mapped onto the 2c gate states (decision G5: the 2c mechanism is
// authoritative). Everything here is pure and tested in Node; screens.js draws it.
//
// Decisions used (2a + 2d decisions):
//   S0  any host other than the production hosts is a preview build: logging allowed, import and restore blocked.
//   S2  iPhone/iPad in a browser tab (not standalone) blocks import and restore, with no "continue
//       anyway" (G2: import/restore happen in the installed app, available since 2e). Desktop at the production host is
//       allowed with a warning that the data stays in this browser.
//   R   no "start from scratch" (G4); logging disabled; exports first.
//   S7  personal data (gymlog-personal.json) is Step 2f: not offered here.
import { isProductionHost, isLocalDevHost } from './config.js';
import { WARNING_CODES } from '../schema/constants.js';

// ---- environment (S0 / S2) --------------------------------------------------------------------------
/**
 * @param {{hostname:string, userAgent?:string, platform?:string, maxTouchPoints?:number, standalone?:boolean}} e
 * @returns {{mode:'production'|'local'|'preview', localDev:boolean, preview:boolean, ios:boolean, standalone:boolean, dataTransfer:'allowed'|'preview'|'install', desktopWarning:boolean}}
 */
export function detectEnvironment({ hostname, userAgent = '', platform = '', maxTouchPoints = 0, standalone = false }) {
  const prod = isProductionHost(hostname);
  const localDev = !prod && isLocalDevHost(hostname);
  const preview = !prod && !localDev;
  const mode = prod ? 'production' : localDev ? 'local' : 'preview';
  // iPadOS reports itself as a Mac; touch points tell them apart.
  const ios = /\b(iPhone|iPad|iPod)\b/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const dataTransfer = preview ? 'preview' : ios && !standalone && !localDev ? 'install' : 'allowed';
  return Object.freeze({ mode, localDev, preview, ios, standalone: !!standalone, dataTransfer, desktopWarning: !preview && !ios });
}

// ---- which screen ------------------------------------------------------------------------------------
/** UI flows that can run on top of the open app (anything else is ignored there). */
export const OPEN_FLOWS = Object.freeze(['report', 'late', 'restore', 'verify', 'prev', 'csv', 'personal']);
/**
 * @param {object} a
 * @param {object} a.state  app.getState()
 * @param {object|null} a.store  the snapshot store (open gate) or null
 * @param {object|null} a.flow   the UI flow in progress ({ kind }) or null
 * @returns {string} screen id
 */
export function screenFor({ state, store, flow }) {
  if (state.busy || state.gate === 'busy') return 'busy';
  switch (state.gate) {
    case 'inspectionFailed': return 'inspectionFailed';
    case 'recovery': return flow?.kind === 'restore' ? 'restore' : 'recovery';
    case 'cleanupPending': return 'cleanupPending';
    case 'verificationIncomplete': return 'verificationIncomplete';
    case 'absent':
      if (flow?.kind === 'import' || flow?.kind === 'restore') return flow.kind;
      return 'welcome';
    case 'open': {
      if (flow && OPEN_FLOWS.includes(flow.kind)) return flow.kind;
      const unseen = unseenReport(store);
      if (unseen) return 'report';
      return 'app';
    }
    default: return 'inspectionFailed';
  }
}

/** The first verified import-log entry whose report was not seen yet (2a R2: it opens automatically). */
export function unseenReport(store) {
  if (!store) return null;
  return store.meta.importLog.find((e) => e.status === 'verified' && e.reportSeenAt === null) ?? null;
}

// ---- file routing (2a R1 §1.1, F1/F2) ----------------------------------------------------------------
/** Identifies a chosen file only to route it and word messages; the facade validates everything. */
export function sniffFile(text) {
  let root;
  try {
    root = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { kind: 'not-json' };
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return { kind: 'unknown' };
  if (Object.prototype.hasOwnProperty.call(root, 'format')) {
    if (root.format === 'gymlog-backup') {
      const sessions = Array.isArray(root.data?.sessions) ? root.data.sessions.length : null;
      return { kind: 'gymlog-backup', exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : null, sessions, unsavedState: root.unsavedState === true };
    }
    if (root.format === 'gymlog-import-package') return { kind: 'import-package' };
    return { kind: 'unknown' };
  }
  if (Array.isArray(root.workouts)) return { kind: 'v1', workouts: root.workouts.length };
  return { kind: 'unknown' };
}

// ---- S4: which check failed --------------------------------------------------------------------------
export const CHECK_STEPS = Object.freeze(['read', 'structure', 'build', 'reconcile']);
const STEP_OF_CODE = {
  SOURCE_EMPTY: 'read', SOURCE_ENCODING_INVALID: 'read', RESULT_INVALID: 'read',
  SOURCE_NOT_JSON: 'structure', FILE_UNKNOWN: 'structure', V1_ROOT_INVALID: 'structure',
  SEED_INVALID: 'build', SEED_DEPENDENCY_MISSING: 'build',
  RECONCILIATION_FAILED: 'reconcile',
};
/** For a failed preview: { failedStep, steps: [{ id, state: 'ok'|'failed'|'skipped' }] }. */
export function checkSteps(result) {
  if (result.ok) return { failedStep: null, steps: CHECK_STEPS.map((id) => ({ id, state: 'ok' })) };
  const failed = STEP_OF_CODE[result.code] ?? (result.errors ? 'build' : 'structure');
  const at = CHECK_STEPS.indexOf(failed);
  return { failedStep: failed, steps: CHECK_STEPS.map((id, i) => ({ id, state: i < at ? 'ok' : i === at ? 'failed' : 'skipped' })) };
}

// ---- reports (S5 / S6) ------------------------------------------------------------------------------
export const WARNING_LABELS = Object.freeze({
  V1_ZERO_AS_NULL: 'אפס בגרסה הישנה נשמר כ"לא הוזן"',
  V1_ADDED_LOAD_ZERO: 'משקל נוסף 0 נשמר כ"לא הוזן"',
  V1_UNKNOWN_EXERCISE: 'תרגיל לא מזוהה',
  V1_CUSTOM_TYPE: 'סוג תרגיל מותאם הומר',
  V1_CUSTOM_COLLIDES: 'תרגיל מותאם בשם של תרגיל קיים',
  V1_DUP_ID: 'מזהה אימון כפול בקובץ',
  V1_BAD_DATE: 'תאריך לא תקין',
  V1_BAD_VALUE: 'ערך לא תקין',
  V1_NOTE_SET: 'הערה ברמת סט',
  V1_DRAFT: 'אימון פתוח מהגרסה הישנה',
  V1_DRAFT_EDIT_MISSING: 'אימון פתוח שעורך אימון שאינו קיים',
  V1_TEMPLATE_NAME: 'שם תבנית',
  V1_BODYWEIGHT_UNKNOWN: 'משקל גוף לא ידוע',
  V1_BW_SETTING_AMBIGUOUS: 'משקל גוף מהגרסה הישנה לא אושר',
  V1_LABEL_MISMATCH: 'תווית שדה שונה מהצפוי',
  V1_VOLUME_CHANGED: 'חישוב הנפח השתנה',
  V1_DURATION_BASIS_UNKNOWN: 'ריצות ללא בסיס זמן',
  V1_LEGACY_ID_CONFLICT: 'אימון קיים עם תוכן שונה',
  SPLIT_MIXED_BASIS: 'פיצולים בבסיסי זמן שונים',
  SPLIT_ORDER_INVALID: 'פיצולים בסדר שגוי',
  SPLIT_BEYOND_DISTANCE: 'פיצול מעבר למרחק',
  SPLIT_BEYOND_DURATION: 'פיצול מעבר לזמן',
  ID_COLLISION_RESOLVED: 'מזהה חלופי ניתן לאימון',
  ID_COLLISION_UNRESOLVED: 'אימון הועבר להסגר בגלל התנגשות מזהים',
  RESTORE_INCOMPLETE: 'שחזור חלקי',
  SOURCE_IDENTITY_MISMATCH: 'זהות המקור אינה תואמת',
  V1_SOURCE_LITERAL_NORMALIZED: 'ערך מקור נורמל',
  SOURCE_SNAPSHOT_UNAVAILABLE: 'קובץ המקור אינו שמור במכשיר',
  IMPORT_CANDIDATE_UNPROVEN: 'הנתונים אושרו ללא הוכחה מלאה',
  V1_STRUCTURE_UNVERIFIED: 'מבנה קובץ שלא אומת מול הגרסה הישנה',
  // Step 2f (Garmin CSV)
  CSV_ACTIVITY_ALREADY_IMPORTED: 'פעילות שכבר יובאה — דולגה',
  CSV_ACTIVITY_SET_ASIDE: 'פעילות הועברה להסגר לפי בחירתך',
  CSV_UNKNOWN_EXERCISE: 'תרגיל לא מזוהה (הערכים נשמרו כמקור)',
  CSV_LOAD_SEMANTICS_UNRESOLVED: 'משמעות המשקל לא אושרה — המשקל נשמר כמקור בלבד',
  CSV_NO_LOAD: 'אין משקל בשורה',
  CSV_LOAD_NOT_RECORDED: 'לתרגיל אין שדה משקל — המשקל נשמר כמקור בלבד',
  CSV_ZERO_REPS: '0 חזרות — הסט לא סומן כבוצע',
  CSV_VALUE_MISSING: 'ערך חסר בשורה — הסט לא סומן כבוצע',
  CSV_TIME_ROUNDED: 'זמן עוגל לשנייה שלמה',
  CSV_SAME_DATE_AS_EXISTING: 'יש כבר אימון באותו תאריך',
  CSV_ACTIVITY_NOT_CONTIGUOUS: 'שורות הפעילות אינן רצופות בקובץ',
  PERSONAL_ITEM_CONFIRMED: 'פריט אושר',
  PERSONAL_ITEM_EDITED: 'פריט נערך ואושר',
  PERSONAL_ITEM_SKIPPED: 'פריט הושמט',
  PERSONAL_ITEM_ALREADY_PRESENT: 'פריט כבר קיים — דולג',
  PERSONAL_ITEM_INVALID: 'פריט לא תקין — לא יובא',
});
export const warningLabel = (code) => WARNING_LABELS[code] ?? code;
/** Every known warning code has a label (tested). */
export const UNLABELED_WARNINGS = WARNING_CODES.filter((c) => !WARNING_LABELS[c]);

/** Warnings grouped by code, in first-seen order: [{ code, label, count, refs }]. */
export function groupWarnings(warnings = []) {
  const groups = new Map();
  for (const w of warnings) {
    const g = groups.get(w.code) ?? { code: w.code, label: warningLabel(w.code), count: 0, refs: [] };
    g.count += 1;
    if (w.ref !== null && w.ref !== undefined) g.refs.push(w.ref);
    groups.set(w.code, g);
  }
  return [...groups.values()];
}

export const IMPORT_KIND_LABELS = Object.freeze({
  v1_migration: 'ייבוא מהאפליקציה הקודמת',
  v1_late_import: 'ייבוא נוסף מהאפליקציה הקודמת',
  backup_restore: 'שחזור מגיבוי',
  personal_seed: 'נתונים אישיים',
  csv_import: 'ייבוא CSV',
});

/** S6 sections for one import-log entry. */
export function reportModel(store, importId) {
  const entry = store.meta.importLog.find((e) => e.importId === importId);
  if (!entry) return null;
  const exById = new Map(store.exercises.map((e) => [e.id, e]));
  return {
    entry,
    kindLabel: IMPORT_KIND_LABELS[entry.kind] ?? entry.kind,
    counts: entry.counts ?? null,
    warnings: groupWarnings(entry.warnings),
    unresolved: (entry.unresolvedExercises ?? []).map((id) => ({ id, name: exById.get(id)?.name ?? id })),
    calculationChanges: entry.calculationChanges ?? [],
    quarantine: store.quarantine.filter((q) => q.importId === importId),
  };
}

// ---- S8 verification checklist (2a R2, R7 / revision §6) ---------------------------------------------
export const CHECK_LABELS = Object.freeze({
  countsMatch: 'מספר האימונים זהה לאפליקציה הישנה',
  spotChecked: 'פתחתי 3 אימונים והשוויתי לישנה',
  recordsReviewed: 'בדקתי שיאים ויעדים',
  unresolvedReviewed: 'עברתי על התרגילים הלא מזוהים',
  realWorkoutLogged: 'תיעדתי אימון אמיתי אחד באפליקציה החדשה',
});
export function checklistModel(store) {
  const ob = store.meta.onboarding;
  const items = Object.keys(CHECK_LABELS).map((k) => ({ key: k, label: CHECK_LABELS[k], done: ob.checks[k] === true }));
  const backupCurrent = store.settings.lastBackupAt !== null && store.settings.lastBackupRevision === store.meta.dataRevision;
  return { items, backupCurrent, verified: ob.userVerifiedAt !== null, canVerify: items.every((i) => i.done) && backupCurrent && ob.userVerifiedAt === null };
}
/** The "complete verification" banner: after a v1 migration, until userVerifiedAt is set. */
export const needsVerification = (store) => !!store && store.meta.onboarding.userVerifiedAt === null && store.meta.importLog.some((e) => e.kind === 'v1_migration' && e.status === 'verified');

// ---- S9 late import -----------------------------------------------------------------------------------
export const LATE_CLASS_LABELS = Object.freeze({
  new: 'חדש', identical: 'כבר קיים (זהה) — ידלג', conflict: 'קיים עם תוכן שונה', dup: 'מזהה כפול בקובץ', noid: 'ללא מזהה', collision: 'התנגשות מזהים',
});
export const LATE_ACTION_LABELS = Object.freeze({
  import: 'ייבא', skip: 'דלג', quarantine: 'העבר להסגר', keep_existing: 'השאר את הקיים', import_alt: 'ייבא כאימון נפרד',
});
/** The selection sent to applyLateImport: index → action, only where the user changed the default. */
export function lateSelection(items, choices) {
  const sel = {};
  for (const it of items) {
    const c = choices[it.index];
    if (c !== undefined && c !== it.defaultAction && it.options.includes(c)) sel[it.index] = c;
  }
  return sel;
}
export function lateCounts(items, choices) {
  const action = (it) => choices[it.index] ?? it.defaultAction;
  return {
    import: items.filter((it) => ['import', 'import_alt'].includes(action(it))).length,
    quarantine: items.filter((it) => action(it) === 'quarantine').length,
    identical: items.filter((it) => it.cls === 'identical').length,
  };
}

// ---- restore requirements (2a R1 §1.4–1.6, revision 2 "C": a proven export) --------------------------
/**
 * What a restore needs before restoreBackup can be called.
 * @param {{gate:string, prevCopy:object|null}} state app.getState()
 */
export function restoreRequirements(state) {
  const replacing = state.gate === 'open' || state.gate === 'recovery';
  return {
    replacing,
    proofKind: state.gate === 'open' ? 'backup' : state.gate === 'recovery' ? 'raw' : null,
    prevCopyFirst: replacing && !!state.prevCopy,
    overwriteInvalid: state.gate === 'recovery',
    orphanAck: (state.orphanLegacy ?? []).length > 0,
  };
}

// ---- messages ----------------------------------------------------------------------------------------
const MESSAGES = {
  SOURCE_EMPTY: 'הקובץ ריק.',
  SOURCE_ENCODING_INVALID: 'הקובץ אינו טקסט UTF-8 תקין.',
  SOURCE_NOT_JSON: 'הקובץ אינו קובץ גיבוי תקין (JSON פגום או קטוע). ייצא שוב מהאפליקציה הישנה.',
  FILE_UNKNOWN: 'סוג הקובץ לא מזוהה.',
  V1_ROOT_INVALID: 'מבנה הקובץ אינו תואם לאפליקציה הקודמת.',
  RECONCILIATION_FAILED: 'שגיאה פנימית בהמרה. לא נשמר דבר.',
  RESULT_INVALID: 'הנתונים אינם תקינים. לא נשמר דבר.',
  ALREADY_IMPORTED: 'הקובץ הזה כבר יובא.',
  PERSONAL_FORMAT_UNKNOWN: 'זה אינו קובץ נתונים אישיים (gymlog-personal.json).',
  PERSONAL_VERSION_UNSUPPORTED: 'גרסת קובץ הנתונים האישיים אינה נתמכת.',
  PERSONAL_ITEM_INVALID: 'פריט שנערך אינו תקין. לא נשמר דבר.',
  PERSONAL_IMPORT_INVALID: 'הייבוא נדחה בבדיקת השמירה. לא נשמר דבר.',
  CSV_UNREADABLE: 'קובץ ה-CSV פגום (מרכאות לא סגורות).',
  CSV_EMPTY: 'קובץ ה-CSV ריק.',
  CSV_UNSUPPORTED: 'זה אינו קובץ unified_workouts.csv מ-Garmin (עמודות חסרות).',
  CSV_ROWS_INVALID: 'יש בקובץ שורות שלא ניתן לקרוא בוודאות. לא יובא דבר.',
  DECISIONS_INCOMPLETE: 'חסרות החלטות לפני הייבוא.',
  RECONCILE_FAILED: 'לא כל שורות הקובץ נמצאו בתוצאה. לא יובא דבר.',
  CSV_IMPORT_INVALID: 'הייבוא נדחה בבדיקת השמירה. לא נשמר דבר.',
  PLAN_INVALID: 'התצוגה המקדימה אינה בתוקף עוד (הנתונים במכשיר השתנו או שכבר נעשה בה שימוש). בחר את הקובץ שוב.',
  WRITES_BUSY: 'פעולה אחרת עדיין רצה. נסה שוב בעוד רגע.',
  WRITES_NOT_ALLOWED: 'הפעולה אינה זמינה במצב הנוכחי.',
  UNSAVED_STATE: 'יש שינויים שלא נשמרו. שמור או ייצא אותם קודם.',
  EXTERNAL_CHANGE: 'הנתונים השתנו בחלון אחר. טען מחדש.',
  EXPORT_NOT_PROVEN: 'הקובץ שנבחר אינו הייצוא של הנתונים הנוכחיים. בחר את הקובץ שייצאת זה עתה.',
  PREV_COPY_PRESENT: 'קיים עותק קודם משחזור. טפל בו קודם.',
  ORPHAN_LEGACY_PRESENT: 'קיימים במכשיר קבצי מקור מייבוא שלא הושלם. אשר שהם יישמרו.',
  CONFIRMATION_REQUIRED: 'נדרש אישור.',
  BACKUP_REQUIRED: 'נדרש גיבוי של הנתונים הנוכחיים.',
  BACKUP_INTEGRITY: 'הגיבוי פגום או נערך.',
  LEGACY_KEY_CONFLICT: 'קובץ מקור שונה כבר שמור תחת אותו מזהה. לא נשמר דבר.',
  SOURCE_MISMATCH: 'הקובץ שנבחר אינו קובץ המקור של הייבוא.',
  PROOF_PRESENT: 'ייבוא אחר בתהליך בחלון אחר.',
  STORE_EXISTS: 'נתונים נוצרו בחלון אחר.',
  STORAGE_WRITE_FAILED: 'השמירה במכשיר נכשלה (ייתכן שהאחסון מלא). לא נשמר דבר.',
  STORAGE_READ_FAILED: 'הקריאה מהאחסון נכשלה.',
  EXPORT_UNAVAILABLE_BUSY: 'הייצוא אינו זמין בזמן שפעולה רצה.',
  NOT_FOUND: 'לא נמצא.',
  WORKFLOW_FAILED: 'הפעולה נכשלה.',
};
export function messageFor(r) {
  if (!r || r.ok) return '';
  const base = MESSAGES[r.code] ?? `הפעולה נכשלה (${r.code}).`;
  return r.stage ? `${base} (שלב: ${r.stage})` : base;
}
