// Step 2d.1 — startup, migration, import, recovery and error screens (2a S0–S9, R, E) on top of the
// 2c gate (G5). Screens never write directly: every change is a facade call (workflows, bookkeeping,
// planImportV1 / importV1(planId), planLateImport / applyLateImport). The Store validates everything.
// Banner E itself is the status bar (status.js, Step 2d.0).
import { singleToWide, activityIdFromFileName } from '../import/garmin-single.js';
import { h, bdi } from './dom.js';
import { formatDate } from './format.js';
import { dateField, localTodayIso } from './date-field.js';
import { pickFile, deliverFile, messageBox, confirmBox, promptBox } from './io.js';
import {
  sniffFile, checkSteps, reportModel, checklistModel, needsVerification, groupWarnings, restoreRequirements,
  lateSelection, lateCounts, messageFor, LATE_CLASS_LABELS, LATE_ACTION_LABELS, IMPORT_KIND_LABELS, unseenReport,
} from './flow-model.js';
import { PRODUCTION_HOST } from './config.js';
import {
  ACTIVITY_KIND_LABELS, ACTIVITY_STATUS_LABELS, UNRESOLVED_CHOICE, IGNORE_CHOICE, targetOptions, loadChoices, newLoadChoices, loadDecisionsNeeded, missingText, itemLabel, nameTarget, setDecision,
} from './csv-model.js';

const PROD_URL = `https://${PRODUCTION_HOST}/`;
const btn = (label, onclick, { pri = false, danger = false, disabled = false, id = null } = {}) =>
  h('button', { type: 'button', class: [pri && 'pri', danger && 'danger'].filter(Boolean).join(' ') || null, disabled, 'data-id': id, onclick: disabled ? null : onclick }, label);
const card = (...children) => h('section', { class: 'card' }, ...children);
const note = (text, kind = 'info') => h('p', { class: `note note-${kind}` }, text);
const dateOf = (iso) => (typeof iso === 'string' ? formatDate(iso.slice(0, 10)) : '—');
const today = () => new Date().toISOString().slice(0, 10);

// ---- shared pieces ---------------------------------------------------------------------------------
/** S0: shown on every screen of a preview build; localDev shows a distinct local-development banner. */
export function previewBanner(env) {
  if (env.localDev) {
    return h('div', { class: 'banner banner-info', 'data-screen': 'local-dev' },
      h('strong', {}, '🛠 סביבת פיתוח מקומית (Local Dev)'),
      h('p', {}, 'הנתונים נשמרים במקור המקומי בלבד (localStorage נפרד לחלוטין מהייצור). ייבוא ושחזור פעילים לבדיקה מקומית.'));
  }
  if (!env.preview) return null;
  return h('div', { class: 'banner banner-warn', 'data-screen': 'S0' },
    h('strong', {}, '⚠️ גרסת תצוגה'),
    h('p', {}, 'זו אינה כתובת האפליקציה. נתונים שיישמרו כאן לא יופיעו באפליקציה. ייבוא ושחזור חסומים כאן.'),
    h('a', { class: 'button', href: PROD_URL }, `פתח את ${PRODUCTION_HOST}`));
}

/** S0 / S2 in place of an import or restore: no "continue anyway" (2a S2, decision G2). */
function transferBlocked(ctx, what) {
  if (ctx.env.dataTransfer === 'allowed') return null;
  if (ctx.env.dataTransfer === 'preview') {
    return card(h('h2', {}, `${what} חסום בגרסת תצוגה`), note('ייבוא ושחזור אפשריים רק בכתובת האפליקציה.', 'warn'), h('a', { class: 'button pri', href: PROD_URL }, `פתח את ${PRODUCTION_HOST}`));
  }
  return h('section', { class: 'card', 'data-screen': 'S2' },
    h('h2', {}, `לפני ה${what}: התקן את האפליקציה`),
    h('p', {}, 'באייפון, נתוני Safari ונתוני האפליקציה שבמסך הבית נפרדים. פעולה כאן לא תגיע לאפליקציה.'),
    h('ol', {}, h('li', {}, 'לחץ שיתוף ⬆️'), h('li', {}, '"הוסף למסך הבית"'), h('li', {}, 'פתח את GymLog מהאייקון החדש')),
    note('אחרי ההתקנה, בצע את הפעולה מתוך האפליקציה שבמסך הבית. כאן היא חסומה.', 'warn'));
}

const desktopWarning = (ctx) => (ctx.env.desktopWarning ? note('הנתונים יישמרו בדפדפן הזה בלבד ולא יגיעו לטלפון.', 'warn') : null);

/** Runs a facade call; shows its failure in Hebrew. Returns the result. */
async function run(ctx, promise) {
  ctx.rerender(); // a workflow takes the gate synchronously: show the busy overlay at once
  const r = await promise;
  if (!r.ok) await messageBox(messageFor(r));
  ctx.rerender();
  return r;
}

/** Creates a backup file, hands it to the user and records it (2a R7: the S8 condition). */
export async function saveBackup(ctx, { partial = false } = {}) {
  const b = await ctx.app.createBackup({ partial });
  if (!b.ok) {
    await messageBox(messageFor(b));
    return false;
  }
  const how = await deliverFile(b.fileName, b.json);
  if (how === 'cancelled' || how === 'failed') {
    await messageBox(how === 'failed' ? 'לא ניתן היה לשמור את הקובץ.' : 'הגיבוי לא נשמר.');
    return false;
  }
  if (how === 'copied') {
    await messageBox('הקובץ לא נשמר, אבל תוכנו הועתק ללוח. הדבק אותו בקובץ ושמור אותו. (גיבוי מהלוח אינו נרשם כגיבוי.)');
    return false;
  }
  if (!b.unsavedState && ctx.state.gate === 'open') {
    const rec = await ctx.app.recordBackup({ revision: b.revision, at: ctx.now(), complete: b.complete });
    if (!rec.ok) await messageBox(messageFor(rec));
  }
  if (!b.complete) await messageBox('הגיבוי נשמר, אבל אינו מלא: קובצי מקור חסרים במכשיר. גיבוי חלקי אינו מספיק לאימות.');
  ctx.rerender();
  return true;
}

/**
 * A backup file of the current data for a PROVEN export (restore, revert): not recorded, because
 * recording the backup changes settings.lastBackup* and the file would no longer match the data.
 */
async function exportForProof(ctx) {
  const b = await ctx.app.createBackup();
  if (!b.ok) {
    await messageBox(messageFor(b));
    return false;
  }
  const how = await deliverFile(b.fileName, b.json);
  return how === 'shared' || how === 'downloaded';
}

async function exportRaw(ctx) {
  const r = ctx.app.rawForExport();
  if (!r.ok) {
    await messageBox(messageFor(r));
    return false;
  }
  const how = await deliverFile(`gymlog-v2-raw-${today()}.json`, r.raw);
  return how === 'shared' || how === 'downloaded';
}

async function exportStoreJson(ctx) {
  const r = ctx.app.exportCurrentState();
  if (!r.ok) return messageBox(messageFor(r));
  return deliverFile(`gymlog-v2-state-${today()}.json`, r.json);
}

/** Exports of every source and previous-copy key that exists (screen R: a separate export per key). */
function keyExports(ctx) {
  const u = ctx.app.storageUsage();
  if (!u.ok) return [note(messageFor(u), 'warn')];
  const items = [];
  for (const k of u.keys) {
    if (k.key.startsWith('gymlog.legacy.')) {
      const sha = k.key.slice('gymlog.legacy.'.length);
      items.push(btn(`ייצא את קובץ המקור הישן ${sha.slice(0, 8)}`, async () => {
        const r = await ctx.app.exportLegacy(sha);
        if (!r.ok) return messageBox(messageFor(r));
        return deliverFile(`gymlog-source-${sha.slice(0, 8)}.json`, r.raw);
      }));
    }
    if (k.key === 'gymlog.v2.prev') {
      items.push(btn('ייצא את העותק הקודם', async () => {
        const r = await ctx.app.exportPrevCopy();
        if (!r.ok) return messageBox(messageFor(r));
        return deliverFile(`gymlog-previous-copy-${today()}.json`, r.raw);
      }));
    }
  }
  return items;
}

// ---- busy -------------------------------------------------------------------------------------------
export function busyScreen() {
  return h('div', { class: 'overlay', 'data-screen': 'busy', role: 'alert', 'aria-busy': 'true' }, h('p', {}, 'שומר…'), h('p', { class: 'hint' }, 'אל תסגור את האפליקציה.'));
}

// ---- S1 welcome -------------------------------------------------------------------------------------
export function welcomeScreen(ctx) {
  const orphan = ctx.state.orphanLegacy ?? [];
  const tokenInput = h('input', { type: 'password', class: 'in', dir: 'ltr', autocomplete: 'off', 'data-field': 'welcome-sync-token', placeholder: 'קוד סנכרון' });
  return h('div', { 'data-screen': 'S1' },
    h('h1', {}, 'GymLog'),
    h('p', {}, 'איך להתחיל?'),
    card(
      btn('ייבוא מהאפליקציה הקודמת', () => ctx.setFlow({ kind: 'import', step: 'choose' }), { pri: true, id: 'import' }),
      h('p', { class: 'hint' }, 'קובץ גיבוי מ"יומן אימונים"'),
      btn('שחזור מגיבוי של GymLog', () => ctx.setFlow({ kind: 'restore' }), { id: 'restore' }),
      btn('התחל מאפס', async () => {
        const ok = await confirmBox(`אפשר לייבא את הנתונים הישנים גם אחר כך, דרך "ייבוא נוסף".${orphan.length ? '\nקובצי מקור מייבוא קודם שלא הושלם יישמרו במכשיר.' : ''}`, { confirmLabel: 'התחל מאפס' });
        if (ok) await run(ctx, ctx.app.startFresh({ acknowledgeOrphanLegacy: orphan.length > 0 }));
      }, { id: 'fresh' }),
    ),
    ctx.sync ? card(
      h('h2', {}, 'חיבור להיסטוריה משותפת (סנכרון)'),
      h('p', { class: 'hint' }, 'הזן את קוד הסנכרון כדי להוריד את ההיסטוריה השמורה בשרת. הקוד נשמר רק בדפדפן הזה. בלי קוד המכשיר יישאר ריק.'),
      tokenInput,
      btn('חבר והורד היסטוריה', async () => {
        const input = tokenInput;
        const token = (input?.value ?? '').trim();
        if (!token) return messageBox('הזן את קוד הסנכרון.');
        const prev = ctx.sync.config.get();
        ctx.sync.config.set({ ...prev, token });
        const r = await run(ctx, ctx.app.startFresh({ acknowledgeOrphanLegacy: orphan.length > 0 }));
        if (!r.ok) { ctx.sync.config.set(prev); return; }
        await ctx.sync.engine.sync();
        ctx.rerender();
      }, { id: 'welcome-sync' }),
    ) : null,
    orphan.length ? note(`במכשיר שמורים ${orphan.length} קובצי מקור מייבוא שלא הושלם. הם לא יימחקו.`, 'info') : null,
    ctx.state.prevCopy ? note('קיים עותק קודם משחזור שלא הושלם. בחר שוב את קובץ הגיבוי.', 'warn') : null);
}

// ---- S3 / S4 / S5: first import ------------------------------------------------------------------------
const STEP_LABELS = { read: 'קריאת הקובץ', structure: 'בדיקת מבנה', build: 'בניית נתונים', reconcile: 'התאמה מלאה לקובץ המקורי' };

export function importScreen(ctx) {
  const f = ctx.flow;
  const blocked = transferBlocked(ctx, 'ייבוא');
  const back = btn('חזרה', () => ctx.setFlow(null));
  if (blocked) return h('div', { 'data-screen': 'S3' }, h('h1', {}, 'ייבוא מהאפליקציה הקודמת'), blocked, back);
  if (f.step === 'choose') {
    return h('div', { 'data-screen': 'S3' },
      h('h1', {}, 'ייבוא מהאפליקציה הקודמת'),
      card(h('p', {}, 'באפליקציה הישנה (מהאייקון במסך הבית): ייצוא ← "שמירת גיבוי (JSON)" ← Files'),
        btn('בחר קובץ gymlog-backup-….json', async () => {
          const file = await pickFile();
          if (!file) return;
          const kind = sniffFile(file.text);
          if (kind.kind === 'gymlog-backup') {
            await messageBox('זה גיבוי של GymLog. השתמש ב"שחזור מגיבוי".');
            return ctx.setFlow({ kind: 'restore' });
          }
          if (kind.kind === 'import-package') return messageBox('זו חבילת ייבוא. ייבוא חבילות יתווסף בשלב מאוחר יותר.');
          ctx.setFlow({ kind: 'import', step: 'checking', file: { name: file.name, size: file.size } });
          const plan = await ctx.app.planImportV1(file.bytes);
          ctx.setFlow({ kind: 'import', step: 'checked', file: { name: file.name, size: file.size }, plan });
        }, { pri: true, id: 'pick' })),
      desktopWarning(ctx), back);
  }
  if (f.step === 'checking') return h('div', { 'data-screen': 'S4' }, h('h1', {}, 'בודק…'), note('לא נשמר דבר בשלב הזה.'));
  // checked: S4 results, then S5 when everything passed
  const plan = f.plan;
  const steps = checkSteps(plan);
  const list = h('ul', { class: 'checks' }, ...steps.steps.map((s) => h('li', { class: `check-${s.state}` },
    `${s.state === 'ok' ? '✓' : s.state === 'failed' ? '✗' : '·'} ${STEP_LABELS[s.id]}${s.id === 'read' && f.file ? ` (${Math.max(1, Math.round(f.file.size / 1024))} KB)` : ''}${s.id === 'build' && s.state === 'ok' ? ` (${plan.summary.counts.sessions} אימונים · ${plan.summary.counts.sets} סטים)` : ''}`)));
  if (!plan.ok) {
    return h('div', { 'data-screen': 'S4' }, h('h1', {}, 'בדיקת הקובץ'), list,
      note(messageFor(plan), 'error'),
      plan.field ? note(`שדה: ${plan.field}`, 'error') : null,
      plan.errors?.length ? h('details', {}, h('summary', {}, 'פרטים טכניים'), h('pre', {}, plan.errors.slice(0, 20).map((e) => `${e.code} ${e.path}: ${e.message}`).join('\n'))) : null,
      note('לא נשמר דבר. האפליקציה הישנה לא השתנתה.'),
      btn('חזרה', () => ctx.setFlow({ kind: 'import', step: 'choose' }), { pri: true }));
  }
  const s = plan.summary;
  const rep = s.report;
  return h('div', { 'data-screen': 'S5' },
    h('h1', {}, 'מוכן לייבוא'), list,
    card(
      h('p', { class: 'big' }, `${s.counts.sessions} אימונים · ${s.counts.performances} תרגילים · ${s.counts.sets} סטים`),
      rep.warnings.length ? h('details', {}, h('summary', {}, `⚠️ ${rep.warnings.length} אזהרות`), warningsList(rep.warnings)) : h('p', {}, '✓ אין אזהרות'),
      rep.unresolvedExercises.length ? h('p', {}, `❓ ${rep.unresolvedExercises.length} תרגילים לא מזוהים`) : null,
      h('p', {}, `🗂 ${s.counts.quarantined} רשומות בהסגר`),
      s.activeSession ? h('p', {}, '⏳ אימון פתוח אחד יועבר כאימון פעיל') : null,
      h('p', { class: 'hint' }, `מזהה המקור: ${s.sourceSha256.slice(0, 16)}…`)),
    desktopWarning(ctx),
    h('div', { class: 'row' },
      btn('ייבא', async () => {
        const r = await run(ctx, ctx.app.importV1(plan.planId));
        ctx.setFlow(r.ok ? null : { kind: 'import', step: 'choose' });
      }, { pri: true, id: 'confirm-import' }),
      btn('ביטול', () => ctx.setFlow(null))));
}

function warningsList(warnings) {
  return h('ul', {}, ...groupWarnings(warnings).map((g) => h('li', {}, `${g.label} · ${g.count}`, g.refs.length ? h('details', {}, h('summary', {}, 'פירוט'), h('pre', {}, g.refs.join('\n'))) : null)));
}

// ---- S6 import report --------------------------------------------------------------------------------
export function reportScreen(ctx, importId) {
  const m = reportModel(ctx.store, importId);
  if (!m) return h('div', {}, note('הדוח לא נמצא.'), btn('חזרה', () => ctx.setFlow(null)));
  const e = m.entry;
  const close = async () => {
    if (e.reportSeenAt === null) {
      const r = await ctx.app.markImportReportSeen(e.importId, ctx.now());
      if (!r.ok) return messageBox(messageFor(r));
    }
    ctx.setFlow(ctx.flow?.returnTo ?? null);
  };
  const c = m.counts;
  return h('div', { 'data-screen': 'S6' },
    h('h1', {}, `דוח: ${m.kindLabel}`),
    h('p', { class: 'hint' }, `${dateOf(e.at)} · ${e.status === 'verified' ? 'אומת' : 'ממתין לאימות'}`),
    h('details', { open: true }, h('summary', {}, 'מספרים'),
      c ? h('p', {}, `${c.sessions} אימונים · ${c.performances} תרגילים · ${c.sets} סטים · ${c.quarantined} בהסגר`) : h('p', {}, '—')),
    h('details', {}, h('summary', {}, `אזהרות (${e.warnings.length})`), m.warnings.length ? warningsList(e.warnings) : h('p', {}, 'אין')),
    h('details', {}, h('summary', {}, `תרגילים לטיפול (${m.unresolved.length})`),
      m.unresolved.length ? h('ul', {}, ...m.unresolved.map((u) => h('li', {}, bdi(u.name)))) : h('p', {}, 'אין'),
      m.unresolved.length ? h('p', { class: 'hint' }, 'הטיפול בתרגילים לא מזוהים יתווסף במסכי הניהול.') : null),
    h('details', {}, h('summary', {}, 'מה השתנה בחישובים'),
      h('ul', {},
        h('li', {}, '1RM משוער אינו מחושב יותר מסטים של חזרה אחת.'),
        h('li', {}, 'נפח מחושב רק לתרגילים המאושרים.'),
        h('li', {}, 'יעד 10 ק״מ משתמש בזמן כולל ובתוצאות מדויקות בלבד.'),
        h('li', {}, 'One-Arm Row ו-Single-Arm Extension מסומנים לכל צד.'),
        ...m.calculationChanges.map((x) => h('li', {}, typeof x === 'string' ? x : JSON.stringify(x))))),
    h('details', {}, h('summary', {}, `רשומות בהסגר (${m.quarantine.length})`),
      ...m.quarantine.map((q) => h('details', {}, h('summary', {}, `${q.reason} · ${q.id}`), h('pre', {}, JSON.stringify(q.raw, null, 1))))),
    h('div', { class: 'row' },
      btn('שמור גיבוי של GymLog', () => saveBackup(ctx), { pri: true, id: 'backup' }),
      btn('סגור', close, { id: 'close-report' })),
    e.kind === 'v1_migration' ? h('p', { class: 'hint' }, 'אפשר לייבא את קובץ הנתונים האישיים (gymlog-personal.json) מניהול ← נתונים.') : null);
}

// ---- S8 verification checklist --------------------------------------------------------------------------
export function verifyScreen(ctx) {
  const m = checklistModel(ctx.store);
  const toggle = (key) => async (ev) => {
    const r = await ctx.app.updateOnboarding({ checks: { [key]: ev.target.checked } });
    if (!r.ok) await messageBox(messageFor(r));
    ctx.rerender();
  };
  return h('div', { 'data-screen': 'S8' },
    h('h1', {}, 'אימות לפני העברת האפליקציה הישנה'),
    m.verified ? note(`אומת ב-${dateOf(ctx.store.meta.onboarding.userVerifiedAt)}. אפשר להעביר את האפליקציה הישנה למצב קריאה בלבד.`, 'ok') : note('אל תתעד באפליקציה הישנה.', 'warn'),
    card(...m.items.map((i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: i.done, disabled: m.verified, onchange: toggle(i.key), 'data-check': i.key }), i.label)),
      h('div', { class: 'check' }, m.backupCurrent ? '✓' : '☐', ' שמרתי גיבוי של GymLog אחרי כל השינויים ', m.backupCurrent ? null : btn('שמור גיבוי', () => saveBackup(ctx), { id: 'backup' })),
      h('p', { class: 'hint' }, 'ודא שקובץ הגיבוי נמצא ב-Files או ב-iCloud.')),
    h('div', { class: 'row' },
      btn('אימתתי', async () => {
        const r = await ctx.app.updateOnboarding({ userVerifiedAt: ctx.now() });
        if (!r.ok) return messageBox(messageFor(r));
        await messageBox('האימות נרשם. עכשיו אפשר להעביר את האפליקציה הישנה למצב קריאה בלבד.');
        return ctx.setFlow(null);
      }, { pri: true, disabled: !m.canVerify, id: 'verified' }),
      btn('חזרה', () => ctx.setFlow(null))));
}

// ---- S9 additional import ---------------------------------------------------------------------------------
export function lateImportScreen(ctx) {
  const f = ctx.flow;
  const back = btn('חזרה', () => ctx.setFlow(null));
  const blocked = transferBlocked(ctx, 'ייבוא');
  if (blocked) return h('div', { 'data-screen': 'S9' }, h('h1', {}, 'ייבוא נוסף מהאפליקציה הקודמת'), blocked, back);
  if (!f.plan) {
    return h('div', { 'data-screen': 'S9' }, h('h1', {}, 'ייבוא נוסף מהאפליקציה הקודמת'),
      card(h('p', {}, 'בחר קובץ גיבוי מהאפליקציה הקודמת. דבר קיים לא יידרס.'),
        btn('בחר קובץ', async () => {
          const file = await pickFile();
          if (!file) return;
          const kind = sniffFile(file.text);
          if (kind.kind === 'gymlog-backup') return messageBox('זה גיבוי של GymLog. השתמש ב"שחזור מגיבוי".');
          const plan = await ctx.app.planLateImport(file.bytes);
          if (!plan.ok) {
            if (plan.code === 'ALREADY_IMPORTED') {
              const e = ctx.store.meta.importLog.find((x) => x.sourceSha256 === plan.sourceSha256);
              return messageBox(`הקובץ הזה כבר יובא ב-${dateOf(e?.at)}.`);
            }
            return messageBox(messageFor(plan));
          }
          return ctx.setFlow({ kind: 'late', plan, choices: {} });
        }, { pri: true, id: 'pick' })),
      desktopWarning(ctx), back);
  }
  const items = f.plan.summary.items;
  const counts = lateCounts(items, f.choices);
  const choose = (idx, action) => ctx.setFlow({ ...f, choices: { ...f.choices, [idx]: action } });
  return h('div', { 'data-screen': 'S9' }, h('h1', {}, 'ייבוא נוסף מהאפליקציה הקודמת'),
    card(...items.map((it) => h('div', { class: 'late-item' },
      h('p', {}, `${it.cls === 'new' ? '🆕' : it.cls === 'identical' ? '✓' : '⚠️'} ${formatDate(it.date)} · ${LATE_CLASS_LABELS[it.cls] ?? it.cls} · ${it.sets} סטים`),
      it.existingId ? h('p', { class: 'hint' }, `קיים: ${it.existingId}`) : null,
      it.options.length ? h('div', { class: 'row' }, ...it.options.map((o) => h('label', { class: 'radio' },
        h('input', { type: 'radio', name: `late-${it.index}`, checked: (f.choices[it.index] ?? it.defaultAction) === o, onchange: () => choose(it.index, o) }), LATE_ACTION_LABELS[o] ?? o))) : null))),
    f.plan.summary.warnings?.length ? h('details', {}, h('summary', {}, `⚠️ ${f.plan.summary.warnings.length} אזהרות`), warningsList(f.plan.summary.warnings)) : null,
    h('p', {}, `ייובאו ${counts.import} · להסגר ${counts.quarantine} · זהים ${counts.identical}`),
    h('div', { class: 'row' },
      btn('ייבא נבחרים', async () => {
        const r = await run(ctx, ctx.app.applyLateImport(f.plan.planId, lateSelection(items, f.choices)));
        if (r.ok && r.outcome === 'unchanged') await messageBox('לא נבחר דבר לייבוא. לא נשמר דבר.');
        ctx.setFlow(null);
      }, { pri: true, id: 'confirm-late' }),
      back));
}

// ---- 2f: Garmin CSV history import -------------------------------------------------------------------------
const select = (attrs, options, value) => h('select', { class: 'in', ...attrs },
  ...options.map((o) => h('option', { value: o.value, selected: o.value === value ? true : undefined, disabled: o.disabled ? true : undefined }, o.label)));

const SINGLE_MESSAGES = {
  SINGLE_BAD_DATE: 'תאריך לא תקין.', SINGLE_BAD_TITLE: 'חסר שם אימון.',
  SINGLE_BAD_ID: 'אי אפשר לזהות מספר פעילות משם הקובץ (activity_<מספר>.csv).',
  SINGLE_EMPTY: 'הקובץ ריק.', SINGLE_UNSUPPORTED: 'זה לא קובץ אימון בודד מ-Garmin (כוח או HIIT).',
};
let csvPreviewSeq = 0; // the latest preview request of the CSV screen

export function csvImportScreen(ctx) {
  const f = ctx.flow;
  const single = f.single === true;
  const title = h('h1', {}, single ? 'ייבוא אימון בודד (Garmin CSV)' : 'ייבוא היסטוריה מ-Garmin (CSV)');
  const back = btn('חזרה', () => ctx.setFlow(null), { id: 'csv-back' });
  const blocked = transferBlocked(ctx, 'ייבוא');
  if (blocked) return h('div', { 'data-screen': 'CSV' }, title, blocked, back);
  if (!f.plan && single) {
    const sd = (f.singleDraft ??= { date: localTodayIso(), title: '' });
    const dateCtl = dateField(sd);
    const inp = (field, type, val) => h('input', { class: 'in', type, value: val, 'data-field': `single-${field}`, oninput: (e) => { sd[field] = e.target.value; } });
    const titleInput = inp('title', 'text', sd.title);
    const regular = ctx.store.templates.filter((t) => !t.archived);
    const pickRegular = select({ 'data-field': 'single-template', 'aria-label': 'אימון קבוע', onchange: (e) => { const t = regular.find((x) => x.id === e.target.value); if (t) { sd.title = t.name; titleInput.value = t.name; } } },
      [{ value: '', label: 'בחר אימון קבוע…' }, ...regular.map((t) => ({ value: t.id, label: t.name }))], '');
    return h('div', { 'data-screen': 'CSV' }, title,
      card(h('p', {}, 'קובץ אימון בודד מ-Garmin לא כולל תאריך ושם. מלא אותם, ובחר את הקובץ (activity_<מספר>.csv). אותו אימון לא ייובא פעמיים.'),
        h('div', { class: 'field' }, h('span', {}, 'תאריך'), dateCtl.el),
        h('label', { class: 'field' }, h('span', {}, 'שם האימון'), pickRegular, titleInput),
        btn('בחר קובץ CSV', async () => {
          const dv = dateCtl.validate();
          if (!dv.ok) return;
          const file = await pickFile({ accept: '.csv,text/csv' });
          if (!file) return;
          const conv = singleToWide(file.bytes, { date: sd.date, title: sd.title, activityId: activityIdFromFileName(file.name) });
          if (!conv.ok) return messageBox(SINGLE_MESSAGES[conv.code] ?? conv.code);
          const plan = await ctx.app.planGarminCsv(new TextEncoder().encode(conv.csv), file.name);
          if (!plan.ok) return messageBox(messageFor(plan));
          return update({ kind: 'csv', single: true, plan, decisions: plan.defaults, preview: null });
        }, { pri: true, id: 'csv-pick' })),
      desktopWarning(ctx), back);
  }
  if (!f.plan) {
    return h('div', { 'data-screen': 'CSV' }, title,
      card(h('p', {}, 'בחר את הקובץ unified_workouts.csv. לפני הייבוא תראה כל פעילות ותחליט על כל תרגיל. דבר קיים לא יידרס, ופעילות שכבר יובאה תדלג.'),
        btn('בחר קובץ CSV', async () => {
          const file = await pickFile({ accept: '.csv,text/csv' });
          if (!file) return;
          const plan = await ctx.app.planGarminCsv(file.bytes, file.name);
          if (!plan.ok) {
            const rows = plan.problems?.length ? `\n${plan.problems.slice(0, 12).map((p) => `שורה ${p.row}: ${p.problem}`).join('\n')}` : '';
            const cols = plan.missingColumns?.length ? `\nעמודות חסרות: ${plan.missingColumns.join(', ')}` : '';
            return messageBox(`${messageFor(plan)}${rows}${cols}`);
          }
          return update({ kind: 'csv', plan, decisions: plan.defaults, preview: null });
        }, { pri: true, id: 'csv-pick' })),
      desktopWarning(ctx), back);
  }
  const { analysis } = f.plan;
  const d = f.decisions;
  const store = ctx.store;
  const pv = f.preview;
  const missing = pv?.missing ?? [];
  async function update(next) {
    const seq = ++csvPreviewSeq;
    ctx.setFlow(next);
    const p = await ctx.app.previewGarminCsv(next.plan.planId, next.decisions);
    if (seq !== csvPreviewSeq) return; // a newer change is in flight: its preview wins
    ctx.setFlow({ ...next, preview: p });
  }
  const decide = (path, value) => update({ ...f, decisions: setDecision(d, path, value) });
  const exOptions = (run) => [
    { value: '', label: '— בחר —', disabled: true },
    ...(run ? [] : [{ value: 'new', label: 'תרגיל חדש בשם Garmin (שם מקורי)' }]),
    { value: IGNORE_CHOICE, label: 'התעלם מתרגיל משני (ללא יצירת תרגיל)' },
    { value: UNRESOLVED_CHOICE, label: 'לא מזוהה — לשמור את הערכים כמקור' },
    ...targetOptions(store, analysis, { run }).map((o) => ({ value: o.id, label: `${o.group ? `${o.group} · ` : ''}${o.name}` })),
  ];
  const acts = analysis.activities;
  const live = acts.filter((a) => a.status !== 'already');

  const activitiesCard = card(h('h2', {}, `פעילויות בקובץ (${acts.length})`),
    ...acts.map((a) => h('div', { class: 'csv-act', 'data-activity': a.id },
      h('p', {}, h('strong', {}, `${formatDate(a.date)} · ${ACTIVITY_KIND_LABELS[a.kind]}`), ` · `, bdi(a.title), h('span', { class: 'hint' }, ` · שורות ${a.rowStart}–${a.rowEnd}`)),
      h('p', { class: `note note-${a.status === 'new' ? 'info' : 'warn'}` }, ACTIVITY_STATUS_LABELS[a.status]),
      a.status === 'already' ? null : h('div', { class: 'row' }, ...[['import', 'ייבא'], ['aside', 'העבר להסגר (נשמר, לא בהיסטוריה)']].map(([v, l]) => h('label', { class: 'radio' },
        h('input', { type: 'radio', name: `act-${a.id}`, checked: d.activities[a.id] === v, 'data-act': `${a.id}:${v}`, onchange: () => decide(['activities', a.id], v) }), l))),
      a.status === 'already' ? null : h('details', {}, h('summary', {}, `שורות (${a.items.length})`),
        h('ul', { class: 'csv-rows' }, ...a.items.map((it) => {
          const base = nameTarget(it, d, analysis);
          const baseName = base === null ? 'לא מזוהה' : base === IGNORE_CHOICE ? 'התעלם' : base === undefined ? 'לפי ההחלטה על השם' : base === 'new' ? 'תרגיל חדש בשם Garmin' : store.exercises.find((e) => e.id === base)?.name ?? base;
          const has = Object.hasOwn(d.rows, it.row);
          return h('li', {}, h('span', {}, `שורה ${it.row}: `, bdi(itemLabel(it))),
            select({ 'aria-label': `שורה ${it.row}`, 'data-row': it.row, onchange: (ev) => decide(['rows', it.row], ev.target.value === '' ? undefined : ev.target.value) },
              [{ value: '', label: `לפי השם (${baseName})` }, ...exOptions(it.run).slice(1)], has ? d.rows[it.row] : ''));
        }))))));

  const namesCard = card(h('h2', {}, 'התאמת תרגילים'),
    h('p', { class: 'hint' }, 'רק שם זהה בדיוק לתרגיל קיים מוצע מראש. לכל שם אחר של Garmin בחר: תרגיל קיים, קליטה כתרגיל חדש בשם המקורי של Garmin (בלי ניחוש ובלי החלפה), או שמירה כלא מזוהה. "Choose an Exercise" נשמר תמיד כלא מזוהה (אפשר לשייך שורה בודדת בפירוט הפעילות).'),
    ...analysis.names.map((n) => h('label', { class: 'field' }, h('span', {}, bdi(n.name), h('span', { class: 'hint' }, ` · ${n.rows} שורות`)),
      select({ 'data-name': n.name, onchange: (ev) => decide(['names', n.name], ev.target.value) }, exOptions(n.run), d.names[n.name] ?? ''))));

  const loadIds = [...new Set([...loadDecisionsNeeded(missing), ...Object.keys(d.load)])].filter((id) => id.startsWith('new:') || store.exercises.some((e) => e.id === id));
  const loadCard = loadIds.length ? card(h('h2', {}, 'משמעות המשקל'),
    h('p', { class: 'hint' }, 'Garmin רושם מספר אחד בעמודת המשקל. בחר מה הוא אומר לכל תרגיל. בלי בחירה המשקל לא יירשם.'),
    ...loadIds.map((id) => {
      if (id.startsWith('new:')) {
        const rawName = id.slice(4);
        return h('label', { class: 'field' }, h('span', {}, bdi(rawName), h('span', { class: 'hint' }, ' · תרגיל חדש (Garmin)')),
          select({ 'data-load': id, onchange: (ev) => decide(['load', id], ev.target.value) }, [{ value: '', label: '— בחר —', disabled: true }, ...newLoadChoices()], d.load[id] ?? ''));
      }
      const ex = store.exercises.find((e) => e.id === id);
      return h('label', { class: 'field' }, h('span', {}, bdi(ex.name)),
        select({ 'data-load': id, onchange: (ev) => decide(['load', id], ev.target.value) }, [{ value: '', label: '— בחר —', disabled: true }, ...loadChoices(ex)], d.load[id] ?? ''));
    })) : null;

  const dates = [...new Set(live.map((a) => `${formatDate(a.date)} (בקובץ: ${a.dateRaw})`))];
  const basicsCard = card(h('h2', {}, 'אישורים'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.datesConfirmed, 'data-confirm': 'dates', onchange: (ev) => decide(['datesConfirmed'], ev.target.checked) }), `התאריכים נכונים: ${dates.join(' · ')}`),
    analysis.units.length > 1 ? note(`בקובץ יש כמה יחידות משקל (${analysis.units.join(', ')}). לא ניתן לייבא אותו.`, 'warn')
      : analysis.units.length === 1
        ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.unit === analysis.units[0], 'data-confirm': 'unit', onchange: (ev) => decide(['unit'], ev.target.checked ? analysis.units[0] : null) }), `המשקלים בקובץ ב-${analysis.units[0] === 'kg' ? 'ק״ג' : 'lb'}`)
        : h('div', { class: 'row' }, ...['kg', 'lb'].map((u) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'csv-unit', checked: d.unit === u, onchange: () => decide(['unit'], u) }), u === 'kg' ? 'ק״ג' : 'lb'))),
    analysis.hasRuns ? h('div', {}, h('p', {}, 'זמן הריצה שיירשם:'),
      h('div', { class: 'row' }, ...[['moving', 'זמן תנועה (Moving Time)'], ['elapsed', 'זמן כולל (Time)']].map(([v, l]) => h('label', { class: 'radio' },
        h('input', { type: 'radio', name: 'csv-run', checked: d.runTimeBasis === v, 'data-run': v, onchange: () => decide(['runTimeBasis'], v) }), l))),
      h('p', { class: 'hint' }, 'ההקפות נשמרות כמקור, ואינן נרשמות כפיצולים.')) : null);

  const summary = !pv ? note('מחשב תצוגה מקדימה…')
    : !pv.ok ? note(messageFor(pv), 'warn')
      : !pv.complete ? card(h('h2', {}, `נשארו ${missing.length} החלטות`), h('ul', {}, ...missingText(missing, store).map((t) => h('li', {}, t))))
        : card(h('h2', {}, 'לפני הייבוא'),
          h('p', {}, `${pv.counts.sessions} אימונים · ${pv.counts.performances} תרגילים · ${pv.counts.sets} סטים · ${pv.counts.quarantined} פעילויות להסגר`),
          h('p', { class: 'hint' }, `כל ${pv.reconciliation.dataRows} השורות נמצאו: ${pv.reconciliation.imported} ייובאו · ${pv.reconciliation.ignored ? `${pv.reconciliation.ignored} הושמטו (תרגילים משניים) · ` : ''}${pv.reconciliation.setAside} להסגר · ${pv.reconciliation.alreadyImported} כבר יובאו.`),
          pv.newExercises?.length ? h('p', { 'data-new-exercises': String(pv.newExercises.length) }, `ייווצרו ${pv.newExercises.length} תרגילים חדשים בשם המקורי של Garmin: `, ...pv.newExercises.flatMap((n, i) => [i ? ', ' : '', bdi(n)])) : null,
          pv.unresolved.length ? note(`${pv.unresolved.length} תרגילים לא מזוהים יישמרו עם הערכים המקוריים, ולא ייכנסו לחישובים.`, 'warn') : null,
          pv.warnings.length ? h('details', {}, h('summary', {}, `אזהרות (${pv.warnings.length})`), warningsList(pv.warnings)) : null);

  return h('div', { 'data-screen': 'CSV' }, title,
    h('p', { class: 'hint' }, `${analysis.fileName} · ${analysis.dataRows} שורות נתונים`),
    activitiesCard, namesCard, loadCard, basicsCard, summary,
    h('div', { class: 'row' },
      btn('ייבא', async () => {
        const ok = await confirmBox(`לייבא ${pv.counts.sessions} אימונים מ-Garmin? פעולה זו נרשמת ביומן הייבוא.`, { confirmLabel: 'ייבא' });
        if (!ok) return;
        const r = await run(ctx, ctx.app.applyGarminCsv(f.plan.planId, d));
        if (!r.ok) {
          if (r.code === 'PLAN_INVALID') ctx.setFlow({ kind: 'csv' });
          return;
        }
        if (r.outcome === 'unchanged') {
          await messageBox('אין מה לייבא: כל הפעילויות כבר יובאו. לא נשמר דבר.');
          return ctx.setFlow(null);
        }
        return ctx.setFlow({ kind: 'report', importId: r.importId });
      }, { pri: true, id: 'csv-import', disabled: !(pv?.ok && pv.complete) }),
      back));
}

// ---- 2f: S7 personal data (gymlog-personal.json) — separate from the CSV import ---------------------------
const PERSONAL_KIND_LABELS = { goal: 'יעד', manual_record: 'שיא ידני', prefill: 'משקל התחלתי לתרגיל', bodyweight: 'משקל גוף' };
const PERSONAL_CHECK_LABELS = { ok: null, already: 'כבר קיים — ידלג', invalid: 'לא תקין — לא ייובא', shape: 'מבנה פגום — לא ייובא', duplicate_key: 'מפתח כפול — לא ייובא', exercise: 'תרגיל לא קיים — לא ייובא', metric: 'מדד לא מוכר — לא ייובא', value: 'ערך לא תקין — לא ייובא', timeBasis: 'חסר בסיס זמן — לא ייובא', id_taken: 'מזהה תפוס — לא ייובא' };

export function personalScreen(ctx) {
  const f = ctx.flow;
  const title = h('h1', {}, 'נתונים אישיים (gymlog-personal.json)');
  const back = btn('חזרה', () => ctx.setFlow(null), { id: 'ps-back' });
  const blocked = transferBlocked(ctx, 'ייבוא');
  if (blocked) return h('div', { 'data-screen': 'S7' }, title, blocked, back);
  if (!f.plan) {
    return h('div', { 'data-screen': 'S7' }, title,
      card(h('p', {}, 'בחר את קובץ הנתונים האישיים. כל פריט מסומן לבדיקה דורש החלטה שלך: אשר, ערוך או השמט.'),
        btn('בחר קובץ', async () => {
          const file = await pickFile();
          if (!file) return;
          const plan = await ctx.app.planPersonalSeed(file.bytes);
          if (!plan.ok) return messageBox(messageFor(plan));
          return ctx.setFlow({ kind: 'personal', plan, decisions: plan.defaults });
        }, { pri: true, id: 'ps-pick' })),
      back);
  }
  const { items, checks } = f.plan;
  const d = f.decisions;
  const exName = (id) => ctx.store.exercises.find((e) => e.id === id)?.name ?? id;
  const set = (key, v) => ctx.setFlow({ ...f, decisions: { ...d, [key]: v } });
  const open = items.filter((it) => checks[it.key] === 'ok' && !d[it.key]);
  return h('div', { 'data-screen': 'S7' }, title,
    h('p', { class: 'hint' }, `${items.length} פריטים`),
    card(...items.map((it) => {
      const c = checks[it.key];
      const v = d[it.key]?.action === 'edit' ? d[it.key].value : it.value;
      return h('div', { class: 'csv-act', 'data-item': it.key },
        h('p', {}, h('strong', {}, `${c === 'ok' && !d[it.key] ? '🔶' : c === 'ok' ? '✅' : '⚪'} ${PERSONAL_KIND_LABELS[it.kind] ?? it.kind}`), ' · ', bdi(v?.exerciseId ? exName(v.exerciseId) : it.key)),
        h('pre', { class: 'hint' }, JSON.stringify(v, null, 1)),
        it.reviewNote ? note(it.reviewNote, 'warn') : null,
        PERSONAL_CHECK_LABELS[c] ? note(PERSONAL_CHECK_LABELS[c], 'warn') : null,
        c !== 'ok' ? null : h('div', { class: 'row' },
          ...[['confirm', 'אשר'], ['skip', 'השמט']].map(([a, l]) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: `ps-${it.key}`, checked: d[it.key]?.action === a, 'data-ps': `${it.key}:${a}`, onchange: () => set(it.key, { action: a }) }), l)),
          btn('ערוך', async () => {
            const text = await promptBox('הערך (JSON)', JSON.stringify(v));
            if (text === null) return;
            try {
              set(it.key, { action: 'edit', value: JSON.parse(text) });
            } catch {
              await messageBox('JSON לא תקין. לא נשמר דבר.');
            }
          }, { id: `ps-edit-${it.key}` })));
    })),
    open.length ? note(`נשארו ${open.length} פריטים להחלטה.`, 'warn') : null,
    h('div', { class: 'row' },
      btn('שמור', async () => {
        const r = await run(ctx, ctx.app.applyPersonalSeed(f.plan.planId, d));
        if (!r.ok) {
          if (r.code === 'PLAN_INVALID') ctx.setFlow({ kind: 'personal' });
          return;
        }
        if (r.outcome === 'unchanged') {
          await messageBox('לא נבחר דבר לשמירה. לא נשמר דבר.');
          return ctx.setFlow(null);
        }
        return ctx.setFlow({ kind: 'report', importId: r.importId });
      }, { pri: true, id: 'ps-save', disabled: open.length > 0 }),
      back));
}

// ---- restore (2a R1, revision 2 "C") ---------------------------------------------------------------------
export function restoreScreen(ctx) {
  const f = ctx.flow;
  const req = restoreRequirements(ctx.state);
  const back = btn('ביטול', () => ctx.setFlow(null));
  const blocked = transferBlocked(ctx, 'שחזור');
  if (blocked) return h('div', { 'data-screen': 'restore' }, h('h1', {}, 'שחזור מגיבוי'), blocked, btn('חזרה', () => ctx.setFlow(null)));
  const set = (patch) => ctx.setFlow({ ...f, ...patch });
  if (req.prevCopyFirst) {
    return h('div', { 'data-screen': 'restore' }, h('h1', {}, 'שחזור מגיבוי'), prevCopyPanel(ctx, { forRestore: true }), back);
  }
  const parts = [h('h1', {}, 'שחזור מגיבוי')];
  if (req.replacing) {
    parts.push(card(h('h2', {}, 'שלב 1: ייצא את הנתונים הנוכחיים'),
      note(req.proofKind === 'raw' ? 'ייצוא התוכן השמור כפי שהוא (גולמי).' : 'גיבוי של הנתונים הנוכחיים לפני שיוחלפו.'),
      btn(f.exported ? '✓ יוצא' : 'ייצא', async () => {
        const ok = req.proofKind === 'raw' ? await exportRaw(ctx) : await exportForProof(ctx);
        if (ok) set({ exported: true });
      }, { pri: !f.exported, id: 'export-current' }),
      h('p', { class: 'hint' }, 'אחרי השמירה בחר את אותו קובץ כדי לאשר שהייצוא נשמר:'),
      btn(f.proof ? `✓ ${f.proof.name}` : 'בחר את הקובץ שייצאת', async () => {
        const file = await pickFile();
        if (file) set({ proof: { name: file.name, bytes: file.bytes } });
      }, { id: 'pick-proof' })));
  }
  parts.push(card(h('h2', {}, req.replacing ? 'שלב 2: בחר את קובץ הגיבוי' : 'בחר את קובץ הגיבוי'),
    btn(f.backup ? `✓ ${f.backup.name}` : 'בחר קובץ גיבוי', async () => {
      const file = await pickFile();
      if (!file) return;
      const info = sniffFile(file.text);
      if (info.kind === 'v1') return messageBox('זה קובץ מהאפליקציה הקודמת. השתמש בייבוא.');
      if (info.kind !== 'gymlog-backup') return messageBox('סוג הקובץ לא מזוהה כגיבוי של GymLog.');
      set({ backup: { name: file.name, bytes: file.bytes, info }, ackUnsaved: false });
    }, { pri: !f.backup, id: 'pick-backup' }),
    f.backup ? h('p', {}, `גיבוי: ${f.backup.info.sessions ?? '?'} אימונים · יוצא ${dateOf(f.backup.info.exportedAt)}`) : null,
    f.backup && ctx.store ? h('p', {}, `נוכחי: ${ctx.store.sessions.length} אימונים · עודכן ${dateOf(ctx.store.meta.updatedAt)}`) : null,
    f.backup && ctx.store && f.backup.info.exportedAt && f.backup.info.exportedAt < ctx.store.meta.updatedAt ? note('⚠️ הגיבוי ישן מהנתונים הנוכחיים.', 'warn') : null,
    f.backup?.info.unsavedState ? h('div', {}, note('⚠️ גיבוי ממצב שלא נשמר: הקובץ נוצר מהזיכרון אחרי שהשמירה במכשיר נכשלה. ייתכן שהוא שונה מהנתונים שנשמרו בפועל או שאינו מלא.', 'warn'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!f.ackUnsaved, onchange: (e) => set({ ackUnsaved: e.target.checked }) }), 'הבנתי ואני רוצה לשחזר ממנו')) : null));
  if (req.replacing) {
    parts.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!f.understand, onchange: (e) => set({ understand: e.target.checked }), 'data-check': 'understand' }), 'אני מבין שהנתונים הנוכחיים יוחלפו בתוכן הגיבוי'));
  }
  if (req.orphanAck) {
    parts.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!f.ackOrphan, onchange: (e) => set({ ackOrphan: e.target.checked }) }), 'קובצי מקור מייבוא שלא הושלם יישארו במכשיר'));
  }
  const ready = !!f.backup && (!req.replacing || (f.proof && f.understand)) && (!f.backup?.info.unsavedState || f.ackUnsaved) && (!req.orphanAck || f.ackOrphan);
  parts.push(desktopWarning(ctx), h('div', { class: 'row' },
    btn('שחזר', async () => {
      const r = await run(ctx, ctx.app.restoreBackup({
        backupBytes: f.backup.bytes, provenExportBytes: f.proof?.bytes ?? null, overwriteInvalid: req.overwriteInvalid,
        acknowledgeUnsavedBackup: !!f.ackUnsaved, acknowledgeOrphanLegacy: !!f.ackOrphan,
      }));
      if (r.ok) ctx.setFlow(null);
    }, { pri: true, disabled: !ready, id: 'confirm-restore' }),
    back));
  return h('div', { 'data-screen': 'restore' }, ...parts);
}

// ---- previous copy (2a R1 §1.5, revision §4) -----------------------------------------------------------------
function prevCopyPanel(ctx, { forRestore = false } = {}) {
  const pc = ctx.state.prevCopy;
  const f = ctx.flow ?? {};
  const set = (patch) => ctx.setFlow({ ...(ctx.flow ?? { kind: 'prev' }), ...patch });
  const title = pc.notice === 'restore_not_performed' ? 'השחזור לא בוצע. הנתונים הנוכחיים לא השתנו.' : `קיים עותק קודם משחזור מ-${dateOf(pc.capturedAt)}`;
  return card(
    h('h2', {}, title),
    forRestore ? note('שחזור חדש דורש מקום לעותק אחד בלבד, ולא נדרוס אותו.') : null,
    btn(f.prevExported ? '✓ יוצא' : 'ייצא את העותק הקודם', async () => {
      const r = await ctx.app.exportPrevCopy();
      if (!r.ok) return messageBox(messageFor(r));
      const how = await deliverFile(`gymlog-previous-copy-${today()}.json`, r.raw);
      if (how === 'shared' || how === 'downloaded') set({ prevExported: true });
      return undefined;
    }, { id: 'export-prev' }),
    btn('מחק את העותק הקודם', async () => {
      if (!pc.valid || !pc.id || !pc.rawSha256) return messageBox('העותק הקודם אינו תקין ולכן לא יימחק מכאן.');
      await messageBox('כדי למחוק, בחר את קובץ העותק הקודם שייצאת.');
      const file = await pickFile();
      if (!file) return undefined;
      if (!(await confirmBox('למחוק את העותק הקודם מהמכשיר? הקובץ שייצאת נשאר אצלך.', { confirmLabel: 'מחק', danger: true }))) return undefined;
      const r = await run(ctx, ctx.app.deletePrevCopy({ id: pc.id, rawSha256: pc.rawSha256, provenExportBytes: file.bytes }));
      if (r.ok) ctx.setFlow(forRestore ? { kind: 'restore' } : null);
      return undefined;
    }, { danger: true, disabled: !f.prevExported, id: 'delete-prev' }),
    !forRestore && pc.valid && pc.kind === 'restore' && pc.matchesImport ? btn('חזור לעותק הקודם', async () => {
      await messageBox('לפני החזרה, שמור גיבוי של הנתונים הנוכחיים ובחר אותו.');
      if (!(await exportForProof(ctx))) return undefined;
      const file = await pickFile();
      if (!file) return undefined;
      const r = await run(ctx, ctx.app.revertToPrevCopy({ provenExportBytes: file.bytes }));
      if (r.ok) ctx.setFlow(null);
      return undefined;
    }, { id: 'revert-prev' }) : null);
}

export function prevCopyBanner(ctx) {
  const pc = ctx.state.prevCopy;
  if (!pc) return null;
  const text = pc.notice === 'restore_not_performed' ? 'השחזור לא בוצע. הנתונים הנוכחיים לא השתנו.' : 'השחזור הושלם. העותק הקודם עדיין שמור במכשיר.';
  return h('div', { class: 'banner banner-info', 'data-banner': 'prev' }, h('span', {}, text), btn('טפל בעותק', () => ctx.setFlow({ kind: 'prev' })));
}

export const prevScreen = (ctx) => h('div', { 'data-screen': 'prev' }, h('h1', {}, 'עותק קודם'), ctx.state.prevCopy ? prevCopyPanel(ctx) : note('אין עותק קודם.'), btn('חזרה', () => ctx.setFlow(null)));

// ---- R recovery -------------------------------------------------------------------------------------------
export function recoveryScreen(ctx) {
  // Remembered for this window (the facade keeps its own record that the raw text was exported).
  const f = ctx.session;
  const set = (patch) => { Object.assign(ctx.session, patch); ctx.rerender(); };
  return h('div', { 'data-screen': 'R' },
    h('h1', {}, '⚠️ נמצאה בעיה בנתונים'),
    h('p', {}, 'לא נמחק ולא שונה דבר. תיעוד אימונים מושבת עד שהבעיה תיפתר.'),
    h('details', {}, h('summary', {}, 'פרטים טכניים'), h('pre', {}, JSON.stringify({ gate: ctx.state.gate, reason: ctx.state.reason, prevCopy: ctx.state.prevCopy, proof: ctx.state.proof }, null, 1))),
    card(
      btn(`1. ${f.rawExported ? '✓ ' : ''}ייצא את הנתונים הנוכחיים (גולמי)`, async () => { if (await exportRaw(ctx)) set({ rawExported: true }); }, { pri: !f.rawExported, id: 'export-raw' }),
      h('div', {}, h('p', {}, '2. ייצא את קובצי המקור והעותקים השמורים:'), ...keyExports(ctx)),
      btn('3. שחזור מגיבוי', () => ctx.setFlow({ kind: 'restore' }), { id: 'restore' }),
      btn('4. בנייה מחדש מהקובץ הישן', async () => {
        if (!(await confirmBox('בנייה מחדש תחליף את הנתונים השמורים בנתונים שנבנו מקובץ המקור הישן.', { confirmLabel: 'המשך', danger: true }))) return;
        if (!(await confirmBox('אימונים שתועדו אחרי המעבר יאבדו. להמשיך?', { confirmLabel: 'בנה מחדש', danger: true }))) return;
        const r = await run(ctx, ctx.app.manualRebuild({ confirm: true }));
        if (r.ok) ctx.setFlow(null);
      }, { danger: true, disabled: !f.rawExported, id: 'rebuild' }),
      f.rawExported ? null : h('p', { class: 'hint' }, 'בנייה מחדש זמינה רק אחרי שלב 1.')));
}

// ---- other gate states (2c) -------------------------------------------------------------------------------
export function cleanupScreen(ctx) {
  return h('div', { 'data-screen': 'cleanup' },
    h('h1', {}, 'הייבוא לא הסתיים עד הסוף'),
    h('p', {}, 'נשאר במכשיר קובץ עזר של הייבוא. עד שיימחק, כתיבה נעולה. הנתונים עצמם לא נפגעו.'),
    card(btn('נסה להשלים', () => run(ctx, ctx.app.retryCleanup()), { pri: true, id: 'retry-cleanup' }),
      btn('ייצא את הנתונים הנוכחיים', () => exportStoreJson(ctx))));
}

export function verificationScreen(ctx) {
  const p = ctx.state.pendingImport ?? {};
  const sourceText = { ok: 'קובץ המקור שמור במכשיר.', missing: 'קובץ המקור חסר במכשיר.', hash_mismatch: 'קובץ המקור במכשיר אינו תואם.', unreadable: 'לא ניתן לקרוא את קובץ המקור.' }[p.source] ?? '';
  const sourceMissing = p.source && p.source !== 'ok';
  return h('div', { 'data-screen': 'verification' },
    h('h1', {}, 'הייבוא לא אומת עד הסוף'),
    h('p', {}, `${IMPORT_KIND_LABELS[p.kind] ?? p.kind ?? ''}: הנתונים נשמרו אבל לא אומתו. כתיבה נעולה עד שהאימות יושלם.`),
    sourceText ? note(sourceText, p.source === 'ok' ? 'info' : 'warn') : null,
    card(
      btn('נסה לאמת שוב', () => run(ctx, ctx.app.retryVerification()), { pri: true, id: 'retry-verify' }),
      sourceMissing ? btn('בחר שוב את קובץ המקור', async () => {
        const file = await pickFile();
        if (file) await run(ctx, ctx.app.reattachSource(file.bytes));
      }, { id: 'reattach' }) : null,
      sourceMissing ? btn('המשך בלי קובץ המקור', async () => {
        if (await confirmBox('הנתונים יאושרו בלי קובץ המקור. גיבוי מלא לא יהיה אפשרי עד שהקובץ יצורף שוב.', { confirmLabel: 'המשך' })) await run(ctx, ctx.app.continueWithoutSource({ confirm: true }));
      }, { id: 'continue-without' }) : null,
      !sourceMissing ? btn('אשר את הנתונים השמורים כפי שהם', async () => {
        if (await confirmBox('הנתונים השמורים שונים ממה שהייבוא יצר. לאשר אותם כפי שהם? הדוח יסומן בהתאם.', { confirmLabel: 'אשר', danger: true })) await run(ctx, ctx.app.acceptUnproven({ confirm: true }));
      }, { id: 'accept-unproven' }) : null,
      btn('ייצא את הנתונים הנוכחיים', () => exportStoreJson(ctx))));
}

export function inspectionScreen(ctx) {
  return h('div', { 'data-screen': 'inspection' },
    h('h1', {}, 'לא ניתן היה לקרוא את האחסון'),
    h('p', {}, 'לא נמחק ולא שונה דבר. ייתכן שהדפדפן חוסם גישה לאחסון, או שחלון אחר כתב בו בדיוק עכשיו.'),
    ctx.state.failedReads?.length ? h('p', { class: 'hint' }, `לא נקראו: ${ctx.state.failedReads.join(', ')}`) : null,
    btn('נסה שוב', () => run(ctx, ctx.app.retryInspection()), { pri: true, id: 'retry-inspection' }));
}

// ---- open app: banners and the data-management section of the Manage tab ----------------------------------
export function appBanners(ctx) {
  const out = [prevCopyBanner(ctx)];
  if (needsVerification(ctx.store)) {
    out.push(h('div', { class: 'banner banner-warn', 'data-banner': 'S8' }, h('span', {}, 'השלם אימות · אל תתעד באפליקציה הישנה'), btn('לאימות', () => ctx.setFlow({ kind: 'verify' }))));
  }
  return out.filter(Boolean);
}

export function dataSection(ctx) {
  const s = ctx.store;
  const lastBackup = s.settings.lastBackupAt ? `גיבוי אחרון: ${dateOf(s.settings.lastBackupAt)}${s.settings.lastBackupRevision === s.meta.dataRevision ? ' (עדכני)' : ' (יש שינויים מאז)'}` : 'עדיין לא נשמר גיבוי.';
  return h('div', { 'data-section': 'data' },
    h('h2', {}, 'נתונים'),
    card(h('p', { class: 'hint' }, lastBackup),
      btn('שמור גיבוי של GymLog', () => saveBackup(ctx), { pri: true, id: 'backup' }),
      btn('שחזור מגיבוי', () => ctx.setFlow({ kind: 'restore' }), { id: 'restore' }),
      btn('ייבוא נוסף מהאפליקציה הקודמת', () => ctx.setFlow({ kind: 'late' }), { id: 'late' }),
      btn('ייבוא אימון בודד (Garmin CSV)', () => ctx.setFlow({ kind: 'csv', single: true }), { id: 'csv-single' }),
      btn('ייבוא היסטוריה מ-Garmin (CSV)', () => ctx.setFlow({ kind: 'csv' }), { id: 'csv' }),
      btn('ייבוא נתונים אישיים (gymlog-personal.json)', () => ctx.setFlow({ kind: 'personal' }), { id: 'personal' }),
      s.meta.importLog.some((e) => e.kind === 'v1_migration') ? btn('אימות לפני העברת האפליקציה הישנה', () => ctx.setFlow({ kind: 'verify' }), { id: 'verify' }) : null),
    h('h2', {}, 'היסטוריית ייבוא'),
    s.meta.importLog.length
      ? h('ul', { class: 'list' }, ...[...s.meta.importLog].reverse().map((e) => h('li', {},
        h('button', { type: 'button', class: 'link', onclick: () => ctx.setFlow({ kind: 'report', importId: e.importId }) },
          `${IMPORT_KIND_LABELS[e.kind] ?? e.kind} · ${dateOf(e.at)}${e.counts ? ` · ${e.counts.sessions} אימונים` : ''}`))))
      : h('p', { class: 'hint' }, 'אין ייבואים.'));
}

/** The screen for an id from screenFor. */
export function renderScreen(id, ctx) {
  switch (id) {
    case 'busy': return busyScreen();
    case 'welcome': return welcomeScreen(ctx);
    case 'import': return importScreen(ctx);
    case 'restore': return restoreScreen(ctx);
    case 'recovery': return recoveryScreen(ctx);
    case 'cleanupPending': return cleanupScreen(ctx);
    case 'verificationIncomplete': return verificationScreen(ctx);
    case 'inspectionFailed': return inspectionScreen(ctx);
    case 'report': return reportScreen(ctx, ctx.flow?.importId ?? unseenReport(ctx.store)?.importId);
    case 'verify': return verifyScreen(ctx);
    case 'late': return lateImportScreen(ctx);
    case 'csv': return csvImportScreen(ctx);
    case 'personal': return personalScreen(ctx);
    case 'prev': return prevScreen(ctx);
    default: return null;
  }
}
