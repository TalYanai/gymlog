// Step 2d.6 — Progress, Personal Records (PR) & Weekly/Monthly Period Comparisons:
// - Personal Records (automatic workout-derived PRs + manual PRs with add/edit/delete)
// - Weekly (Sunday–Saturday) & Monthly (1st–last calendar day) Comparisons with partial-period badges
// - Goals (status as values, add / archive), exact-distance results (10K) by time basis,
//   and per-exercise progress charts and history from saved data.
import { h, bdi } from './dom.js';
import { formatDate, formatNumber, formatSeconds } from './format.js';
import { messageBox, confirmBox } from './io.js';
import { messageFor } from './flow-model.js';
import { parseDurationInput } from '../derive/units.js';
import {
  progressExercises,
  exerciseProgress,
  distanceModel,
  goalsModel,
  goalFormFor,
  BASIS_LABELS,
  GOAL_EXERCISES,
  chartMetrics,
  keyChartsModel,
  mainRecordsModel,
  chartSeries,
  chartValueText,
  personalRecordsModel,
  manualRecordExercises,
  manualRecordMetricOptions,
  periodComparisonModel,
} from './progress-model.js';

const fail = async (r) => {
  if (!r.ok && r.outcome !== 'unsaved') {
    await messageBox(r.code === 'RESULT_INVALID' ? 'הנתון אינו תקין עבור התרגיל הזה.' : r.message || messageFor(r));
  }
  return r;
};

// ---- Personal Records (PR) Section ------------------------------------------------------------------------

function openManualRecordEdit(ctx, recId) {
  const rec = (ctx.store.manualRecords ?? []).find((r) => r.id === recId);
  if (!rec) return;
  ctx.progressUi.manualRecordForm = {
    mode: 'edit',
    recordId: rec.id,
    exerciseId: rec.exerciseId,
    metric: rec.metric,
    load: rec.load !== null ? String(rec.load) : '',
    reps: rec.reps !== null ? String(rec.reps) : '',
    distanceKm: rec.distanceM !== null ? String(Math.round((rec.distanceM / 1000) * 1000) / 1000) : '',
    duration: rec.durationSec !== null ? formatSeconds(rec.durationSec) : '',
    timeBasis: rec.timeBasis ?? 'moving',
    date: rec.date ?? '',
    note: rec.note ?? '',
  };
  ctx.rerender();
}

function manualRecordFormView(ctx) {
  const f = ctx.progressUi.manualRecordForm;
  const exercises = manualRecordExercises(ctx.store);
  const exObj = ctx.store.exercises.find((e) => e.id === f.exerciseId) ?? null;
  const metrics = exObj ? manualRecordMetricOptions(exObj) : [];
  const chosenMetric = metrics.find((x) => x.metric === f.metric) ?? metrics[0] ?? null;
  if (exObj && chosenMetric && f.metric !== chosenMetric.metric) {
    f.metric = chosenMetric.metric;
  }

  const set = (patch) => {
    Object.assign(f, patch);
    ctx.rerender();
  };

  const input = (name, attrs = {}) => {
    const el = h('input', { class: 'in', dir: 'ltr', value: f[name] ?? '', 'data-mr-field': name, ...attrs });
    el.addEventListener('input', () => { f[name] = el.value; });
    return el;
  };

  const save = async () => {
    if (!exObj || !chosenMetric) return messageBox('בחר תרגיל וסוג מדידה.');
    const num = (v) => (/^\d+(?:[.,]\d+)?$/.test(String(v ?? '').trim()) ? Number(String(v).trim().replace(',', '.')) : null);
    const intNum = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : null);

    const payload = {
      exerciseId: exObj.id,
      metric: chosenMetric.metric,
      load: null,
      loadUnit: null,
      loadBasis: null,
      reps: null,
      repsText: null,
      distanceM: null,
      durationSec: null,
      timeBasis: null,
      date: f.date && String(f.date).trim() !== '' ? String(f.date).trim() : null,
      note: f.note && String(f.note).trim() !== '' ? String(f.note).trim() : null,
    };

    if (chosenMetric.fields.includes('load')) {
      const ld = num(f.load);
      if (ld === null || ld <= 0) return messageBox('יש להזין משקל חיובי.');
      payload.load = ld;
      payload.loadUnit = exObj.measurement.loadUnit ?? 'kg';
      payload.loadBasis = exObj.measurement.loadBasis ?? 'total';
    }
    if (chosenMetric.fields.includes('reps')) {
      const rp = intNum(f.reps);
      const minR = chosenMetric.metric === 'load_for_min_reps' ? 2 : 1;
      if (rp === null || rp < minR) {
        return messageBox(minR === 2 ? 'שיא משקל לחזרות דורש לפחות 2 חזרות.' : 'יש להזין מספר חזרות חיובי שלם.');
      }
      payload.reps = rp;
    } else if (chosenMetric.fields.includes('repsOptional')) {
      const rpStr = String(f.reps ?? '').trim();
      if (rpStr !== '') {
        const rp = intNum(rpStr);
        if (rp === null || rp < 1) return messageBox('מספר החזרות חייב להיות שלם וחיובי.');
        payload.reps = rp;
      }
    }
    if (chosenMetric.fields.includes('distanceKm')) {
      const dk = num(f.distanceKm);
      if (dk === null || dk <= 0) return messageBox('יש להזין מרחק חיובי בק״מ.');
      payload.distanceM = Math.round(dk * 10000) / 10;
    }
    if (chosenMetric.fields.includes('duration')) {
      const dur = parseDurationInput(String(f.duration ?? '').trim());
      if (dur === null || dur <= 0) return messageBox('יש להזין זמן תקין (למשל 24:30 או 45).');
      payload.durationSec = dur;
    }
    if (chosenMetric.fields.includes('timeBasis')) {
      payload.timeBasis = f.timeBasis || 'moving';
    }

    const res = f.mode === 'edit' && f.recordId
      ? await fail(await ctx.actions.updateManualRecord({ recordId: f.recordId, ...payload }))
      : await fail(await ctx.actions.addManualRecord(payload));
    if (res.ok) {
      ctx.progressUi.manualRecordForm = null;
      ctx.rerender();
    }
    return res;
  };

  const unitLabel = exObj?.measurement?.loadUnit === 'lb' ? 'lb' : 'ק״ג';
  const basisLabel = exObj ? BASIS_LABELS[exObj.measurement.loadBasis] ?? '' : '';

  return h('section', { class: 'card pr-form-card', 'data-form': 'manual-record' },
    h('h3', {}, f.mode === 'edit' ? 'עריכת שיא אישי ידני' : 'הוספת שיא אישי ידני'),
    h('p', { class: 'hint' }, 'שיא ידני נשמר בנפרד מהיסטוריית האימונים, אינו יוצר אימון מדומה ואינו דורס שיאים קיימים.'),
    h('label', {}, 'תרגיל קיים',
      h('select', {
        class: 'in',
        'data-mr-field': 'exerciseId',
        onchange: (e) => {
          const nextEx = ctx.store.exercises.find((x) => x.id === e.target.value);
          const nextMetrics = nextEx ? manualRecordMetricOptions(nextEx) : [];
          set({ exerciseId: e.target.value, metric: nextMetrics[0]?.metric ?? null });
        },
      },
      h('option', { value: '', selected: !exObj }, 'בחר תרגיל...'),
      ...exercises.map((e) => h('option', { value: e.id, selected: e.id === f.exerciseId }, e.displayLabel)))),
    exObj ? h('label', {}, 'סוג מדידה (הפרדה מלאה בין משקל גוף למשקל נוסף)',
      h('select', {
        class: 'in',
        'data-mr-field': 'metric',
        onchange: (e) => set({ metric: e.target.value }),
      },
      ...metrics.map((m) => h('option', { value: m.metric, selected: m.metric === chosenMetric?.metric }, m.label)))) : null,
    chosenMetric?.metric === 'max_reps'
      ? h('div', { class: 'note note-info', 'data-mr-bodyweight-note': 'true' }, 'שיא חזרות במשקל גוף (ללא תוספת משקל) — אין צורך להזין משקל.')
      : null,
    chosenMetric?.fields.includes('load')
      ? h('label', {}, `משקל (${unitLabel}${basisLabel ? ` · ${basisLabel}` : ''})`, input('load', { inputmode: 'decimal', placeholder: 'למשל 100 או 34' }))
      : null,
    chosenMetric?.fields.includes('reps')
      ? h('label', {}, chosenMetric.metric === 'load_for_min_reps' ? 'מספר חזרות (2 ומעלה)' : 'מספר חזרות נקיות (ללא משקל נוסף)', input('reps', { inputmode: 'numeric', placeholder: 'למשל 27 או 21' }))
      : null,
    chosenMetric?.fields.includes('repsOptional')
      ? h('label', {}, 'מספר חזרות (רשות)', input('reps', { inputmode: 'numeric', placeholder: 'למשל 5' }))
      : null,
    chosenMetric?.fields.includes('distanceKm')
      ? h('label', {}, 'מרחק (ק״מ)', input('distanceKm', { inputmode: 'decimal', placeholder: 'למשל 5 או 10' }))
      : null,
    chosenMetric?.fields.includes('duration')
      ? h('label', {}, 'זמן (דק׳:שנ׳ או ש׳:דק׳:שנ׳)', input('duration', { placeholder: 'למשל 24:15' }))
      : null,
    chosenMetric?.fields.includes('timeBasis')
      ? h('label', {}, 'בסיס זמן',
          h('select', {
            class: 'in',
            'data-mr-field': 'timeBasis',
            onchange: (e) => { f.timeBasis = e.target.value || 'moving'; },
          },
          h('option', { value: 'moving', selected: (f.timeBasis ?? 'moving') === 'moving' }, 'זמן תנועה'),
          h('option', { value: 'elapsed', selected: f.timeBasis === 'elapsed' }, 'זמן כולל (כולל עצירות)')))
      : null,
    chosenMetric ? h('label', {}, 'תאריך השיא (רשות)', input('date', { type: 'date' })) : null,
    chosenMetric ? h('label', {}, 'הערה (רשות)', input('note', { dir: 'rtl', placeholder: 'למשל: 27 חזרות נקיות במשקל גוף ללא תוספת משקל' })) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'pri', disabled: !chosenMetric, 'data-id': 'save-manual-record', onclick: save }, f.mode === 'edit' ? 'עדכן שיא ידני' : 'שמור שיא ידני'),
      h('button', { type: 'button', 'data-id': 'cancel-manual-record', onclick: () => { ctx.progressUi.manualRecordForm = null; ctx.rerender(); } }, 'ביטול')));
}

function personalRecordsSection(ctx) {
  const filterExId = ctx.progressUi.prFilterExerciseId || null;
  const prModel = personalRecordsModel(ctx.store, { filterExerciseId: filterExId });
  const allPrModel = filterExId ? personalRecordsModel(ctx.store) : prModel;

  return h('section', { 'data-section': 'personal-records', class: 'pr-section' },
    h('div', { class: 'row section-header-row' },
      h('div', {},
        h('h2', {}, 'שיאים (PR)')),
      !ctx.progressUi.manualRecordForm
        ? h('button', {
            type: 'button',
            class: 'pri',
            'data-id': 'new-manual-record',
            onclick: () => {
              const firstEx = prModel.exercises[0] ?? null;
              const firstMetric = firstEx ? manualRecordMetricOptions(ctx.store.exercises.find((e) => e.id === firstEx.id))[0]?.metric ?? null : null;
              ctx.progressUi.manualRecordForm = {
                mode: 'add',
                exerciseId: filterExId || firstEx?.id || '',
                metric: firstMetric,
                load: '',
                reps: '',
                distanceKm: '',
                duration: '',
                timeBasis: 'moving',
                date: new Date().toISOString().slice(0, 10),
                note: '',
              };
              ctx.rerender();
            },
          }, '+ שיא ידני חדש')
        : null),
    ctx.progressUi.manualRecordForm ? manualRecordFormView(ctx) : null,
    allPrModel.groups.length > 1
      ? h('div', { class: 'row pr-filter-row' },
          h('select', {
            class: 'in',
            'data-id': 'pr-filter-exercise',
            'aria-label': 'סנן שיאים לפי תרגיל',
            onchange: (e) => {
              ctx.progressUi.prFilterExerciseId = e.target.value || null;
              ctx.rerender();
            },
          },
          h('option', { value: '', selected: !filterExId }, `כל התרגילים עם שיאים (${allPrModel.groups.length})`),
          ...allPrModel.groups.map((g) => h('option', { value: g.exerciseId, selected: g.exerciseId === filterExId }, `${g.displayLabel} (${g.records.length})`))))
      : null,
    prModel.groups.length === 0
      ? h('p', { class: 'hint', 'data-pr-empty': 'true' }, 'אין עדיין שיאים אישיים להצגה. השלם אימון או הוסף שיא ידני.')
      : h('div', { class: 'pr-groups' },
          ...prModel.groups.map((g) =>
            h('article', { class: 'card pr-exercise-card', 'data-pr-exercise': g.exerciseId },
              h('div', { class: 'row pr-card-head' },
                h('h3', {}, bdi(g.displayLabel)),
                h('span', { class: 'badge' }, g.group)),
              h('ul', { class: 'list pr-record-list' },
                ...g.records.map((rec) =>
                  h('li', { class: 'pr-record-row', 'data-pr-key': rec.key, 'data-pr-metric': rec.metric },
                    h('div', { class: 'pr-record-main' },
                      h('div', { class: 'pr-metric-title' }, h('b', {}, rec.label)),
                      h('div', { class: 'pr-best-line' },
                        h('span', { class: 'pr-best-val', 'data-pr-best': rec.key }, rec.best.text),
                        ' ',
                        h('span', {
                          class: `badge ${rec.best.sourceKind === 'manual' ? 'badge-manual' : 'badge-auto'}`,
                          'data-pr-source': rec.best.sourceKind,
                        }, rec.best.sourceLabel),
                        rec.best.date ? h('span', { class: 'hint pr-date' }, ` · ${formatDate(rec.best.date)}`) : h('span', { class: 'hint pr-date' }, ' · ללא תאריך'))),
                    rec.coexists
                      ? h('div', { class: 'pr-coexist hint', 'data-pr-coexist': 'true' },
                          `שיא אימון אוטומטי: ${rec.calculated.text}${rec.calculated.date ? ` (${formatDate(rec.calculated.date)})` : ''} · שיא ידני מיטבי: ${rec.manual.text}${rec.manual.date ? ` (${formatDate(rec.manual.date)})` : ''}`)
                      : null,
                    rec.manualList.length > 0
                      ? h('div', { class: 'pr-manual-items' },
                          ...rec.manualList.map((m) =>
                            h('div', { class: 'pr-manual-entry', 'data-manual-record-id': m.id },
                              h('div', { class: 'pr-manual-text' },
                                h('span', { class: 'badge badge-manual' }, m.sourceLabel),
                                ' ',
                                h('b', {}, m.text),
                                m.date ? ` · ${formatDate(m.date)}` : ' · ללא תאריך',
                                m.note ? h('div', { class: 'hint pr-manual-note' }, `הערה: ${m.note}`) : null),
                              h('div', { class: 'row pr-manual-actions' },
                                h('button', {
                                  type: 'button',
                                  class: 'link small',
                                  'data-edit-record': m.id,
                                  onclick: () => openManualRecordEdit(ctx, m.id),
                                }, 'ערוך'),
                                h('button', {
                                  type: 'button',
                                  class: 'link small danger',
                                  'data-delete-record': m.id,
                                  onclick: async () => {
                                    if (!(await confirmBox('למחוק את השיא הידני הזה?', { confirmLabel: 'מחק שיא' }))) return;
                                    await fail(await ctx.actions.deleteManualRecord({ recordId: m.id }));
                                  },
                                }, 'מחק')))))
                      : null)))))));
}

// ---- Weekly & Monthly Comparisons Section -----------------------------------------------------------------

function periodSummaryCard(label, sideKey, summary) {
  return h('div', {
    class: `card compare-period-card ${summary.isFuture ? 'compare-future-card' : summary.isPartial ? 'compare-partial-card' : ''}`,
    'data-compare-side': sideKey,
    'data-partial': String(summary.isPartial),
    'data-future': String(summary.isFuture),
  },
  h('div', { class: 'row pr-card-head' },
    h('h3', {}, `${label}: ${summary.title}`),
    h('span', {
      class: `badge ${summary.isFuture ? 'badge-muted' : summary.isPartial ? 'badge-warn' : 'badge-auto'}`,
      'data-period-status': summary.isFuture ? 'future' : summary.isPartial ? 'partial' : 'complete',
    }, summary.statusBadge)),
  h('div', { class: 'hint', 'data-actual-range': `${summary.actualStartDate}..${summary.actualEndDate}` },
    summary.isFuture ? summary.actualRangeText : `טווח תאריכים בפועל: ${summary.actualRangeText}`),
  summary.isFuture
    ? h('div', { class: 'note note-muted', 'data-future-banner': sideKey },
        'שים לב: תקופה זו עתידית וטרם החלה — אין עדיין אימונים להצגה.')
    : summary.isPartial
      ? h('div', { class: 'note note-warn', 'data-partial-banner': sideKey },
          `שים לב: תקופה זו טרם הסתיימה (כוללת נתונים מ-${formatDate(summary.actualStartDate)} עד ${formatDate(summary.actualEndDate)} בלבד).`)
      : null,
  h('ul', { class: 'list compare-metrics-list' },
    h('li', {}, h('b', {}, 'מספר אימונים ותדירות: '), summary.frequencyText),
    h('li', {}, h('b', {}, 'פילוח אימונים: '), `${summary.strengthSessionCount} אימוני כוח · ${summary.cardioSessionCount} אימוני ריצה/אירובי`),
    h('li', {}, h('b', {}, 'נפח אימון בר-השוואה: '), summary.volumeText)));
}

function comparisonsSection(ctx) {
  const mode = ctx.progressUi.compareMode === 'month' ? 'month' : 'week';
  const periodA = mode === 'month' ? ctx.progressUi.compareMonthA : ctx.progressUi.compareWeekA;
  const periodB = mode === 'month' ? ctx.progressUi.compareMonthB : ctx.progressUi.compareWeekB;
  const cmp = periodComparisonModel(ctx.store, {
    mode,
    periodA,
    periodB,
    today: ctx.progressUi.compareToday || new Date().toISOString().slice(0, 10),
  });

  const setPeriodA = (val) => {
    if (!val) return;
    if (mode === 'month') ctx.progressUi.compareMonthA = val;
    else ctx.progressUi.compareWeekA = val;
    ctx.rerender();
  };
  const setPeriodB = (val) => {
    if (!val) return;
    if (mode === 'month') ctx.progressUi.compareMonthB = val;
    else ctx.progressUi.compareWeekB = val;
    ctx.rerender();
  };

  return h('section', { 'data-section': 'comparisons', class: 'compare-section' },
    h('h2', {}, 'השוואה'),
    h('div', { class: 'row metric-tabs compare-mode-tabs' },
      h('button', {
        type: 'button',
        'data-id': 'compare-mode-week',
        'aria-pressed': String(mode === 'week'),
        class: mode === 'week' ? 'pri' : '',
        onclick: () => { ctx.progressUi.compareMode = 'week'; ctx.rerender(); },
      }, 'שבוע'),
      h('button', {
        type: 'button',
        'data-id': 'compare-mode-month',
        'aria-pressed': String(mode === 'month'),
        class: mode === 'month' ? 'pri' : '',
        onclick: () => { ctx.progressUi.compareMode = 'month'; ctx.rerender(); },
      }, 'חודש')),

    h('div', { class: 'card compare-selectors-card' },
      h('div', { class: 'compare-selector-col' },
        h('label', {}, mode === 'month' ? 'חודש א׳ (תקופת בסיס)' : 'שבוע א׳ (תקופת בסיס · ראשון–שבת)',
          h('select', {
            class: 'in',
            'data-id': 'compare-period-a',
            onchange: (e) => setPeriodA(e.target.value),
          },
          ...cmp.options.map((o) => h('option', { value: o.key, selected: o.key === cmp.selectedA }, o.label)))),
        h('label', { class: 'hint' }, mode === 'month' ? 'חודש אחר:' : 'שבוע של תאריך:',
          h('input', {
            class: 'in',
            dir: 'ltr',
            type: mode === 'month' ? 'month' : 'date',
            'data-id': 'compare-custom-a',
            value: cmp.selectedA,
            onchange: (e) => setPeriodA(e.target.value),
          }))),
      h('div', { class: 'compare-selector-col' },
        h('label', {}, mode === 'month' ? 'חודש ב׳ (תקופה מושווית)' : 'שבוע ב׳ (תקופה מושווית · ראשון–שבת)',
          h('select', {
            class: 'in',
            'data-id': 'compare-period-b',
            onchange: (e) => setPeriodB(e.target.value),
          },
          ...cmp.options.map((o) => h('option', { value: o.key, selected: o.key === cmp.selectedB }, o.label)))),
        h('label', { class: 'hint' }, mode === 'month' ? 'חודש אחר:' : 'שבוע של תאריך:',
          h('input', {
            class: 'in',
            dir: 'ltr',
            type: mode === 'month' ? 'month' : 'date',
            'data-id': 'compare-custom-b',
            value: cmp.selectedB,
            onchange: (e) => setPeriodB(e.target.value),
          }))),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'link small',
          'data-id': 'compare-swap',
          onclick: () => {
            const curA = cmp.selectedA;
            const curB = cmp.selectedB;
            if (mode === 'month') {
              ctx.progressUi.compareMonthA = curB;
              ctx.progressUi.compareMonthB = curA;
            } else {
              ctx.progressUi.compareWeekA = curB;
              ctx.progressUi.compareWeekB = curA;
            }
            ctx.rerender();
          },
        }, '⇄ החלף בין תקופה א׳ לתקופה ב׳'))),

    h('div', { class: 'compare-cards-grid' },
      periodSummaryCard('תקופה א׳', 'A', cmp.periodA),
      periodSummaryCard('תקופה ב׳', 'B', cmp.periodB)),

    h('div', { class: 'card compare-delta-overview', 'data-id': 'compare-overview' },
      h('h3', {}, 'סיכום פערים (תקופה ב׳ מול תקופה א׳)'),
      h('ul', { class: 'list' },
        h('li', {}, h('b', {}, 'שינוי במספר האימונים: '), cmp.workoutDeltaText),
        h('li', {}, h('b', {}, 'שינוי בימים פעילים: '), cmp.activeDaysDeltaText),
        h('li', {}, h('b', {}, 'שינוי בנפח אימון בר-השוואה: '), cmp.volumeComparison.deltaText))),

    h('div', { class: 'card', 'data-id': 'compare-exercises' },
      h('h3', {}, 'התקדמות בתרגילים מרכזיים ושינויי משקל / חזרות'),
      h('p', { class: 'hint' }, 'השוואה מתבצעת רק בין ביצועים באותו תרגיל, אותה יחידת מדידה ואותו בסיס עומס. חוסר נתונים אינו נספר כאפס.'),
      cmp.exerciseComparisons.length === 0
        ? h('p', { class: 'hint', 'data-compare-exercises-empty': 'true' }, 'אין תרגילים שהושלמו בשתי התקופות שנבחרו.')
        : h('ul', { class: 'list compare-ex-list' },
            ...cmp.exerciseComparisons.map((exCmp) =>
              h('li', { class: 'compare-ex-item', 'data-compare-ex': exCmp.compKey, 'data-comparable': String(exCmp.comparable) },
                h('div', { class: 'row pr-card-head' },
                  h('b', {}, bdi(exCmp.exerciseName)),
                  h('span', { class: 'badge' }, exCmp.groupLabel)),
                h('div', { class: 'hint' }, `תקופה א׳: ${exCmp.summaryAText}`),
                h('div', { class: 'hint' }, `תקופה ב׳: ${exCmp.summaryBText}`),
                h('div', { class: exCmp.comparable ? 'note note-ok' : 'hint', 'data-compare-delta': exCmp.compKey },
                  `שינוי (ב׳ מול א׳): ${exCmp.deltaText}`))))),

    h('div', { class: 'card', 'data-id': 'compare-new-records' },
      h('h3', {}, 'שיאים אישיים חדשים שהושגו בכל תקופה'),
      h('div', { class: 'compare-cards-grid' },
        h('div', { 'data-new-records-side': 'A' },
          h('b', {}, `שיאים חדשים בתקופה א׳ (${cmp.periodA.newRecordsFormatted.length})`),
          cmp.periodA.newRecordsFormatted.length === 0
            ? h('p', { class: 'hint' }, 'לא נקבעו שיאים חדשים בתקופה א׳.')
            : h('ul', { class: 'list' },
                ...cmp.periodA.newRecordsFormatted.map((r) =>
                  h('li', {}, h('b', {}, bdi(r.exerciseName)), ` · ${r.metricLabel}: ${r.valueText} (${formatDate(r.date)} · ${r.sourceLabel})`)))),
        h('div', { 'data-new-records-side': 'B' },
          h('b', {}, `שיאים חדשים בתקופה ב׳ (${cmp.periodB.newRecordsFormatted.length})`),
          cmp.periodB.newRecordsFormatted.length === 0
            ? h('p', { class: 'hint' }, 'לא נקבעו שיאים חדשים בתקופה ב׳.')
            : h('ul', { class: 'list' },
                ...cmp.periodB.newRecordsFormatted.map((r) =>
                  h('li', {}, h('b', {}, bdi(r.exerciseName)), ` · ${r.metricLabel}: ${r.valueText} (${formatDate(r.date)} · ${r.sourceLabel})`)))))));
}

// ---- Goals, 10K & Exercise Charts Sections ----------------------------------------------------------------

function goalsSection(ctx) {
  const all = goalsModel(ctx.store);
  const goals = all.filter((g) => GOAL_EXERCISES.includes(g.exerciseId));
  const hidden = all.length - goals.length;
  return h('section', { 'data-section': 'goals' },
    h('h2', {}, 'יעדים'),
    goals.length ? h('ul', { class: 'list goals' }, ...goals.map((g) => h('li', { class: 'card', 'data-goal': g.id },
      h('div', {}, h('b', {}, bdi(g.exercise)), ` · ${g.targetText}`),
      h('div', { class: g.achieved ? 'note note-ok' : 'hint' }, g.achieved ? `✓ ${g.achievedText}` : g.current),
      g.deadline ? h('div', { class: 'hint' }, `עד ${formatDate(g.deadline)}`) : null,
      g.notCounted ? h('div', { class: 'hint' }, `${g.notCounted} לא נספרו`) : null,
      h('button', { type: 'button', class: 'link small', onclick: async () => {
        if (!(await confirmBox('להעביר את היעד לארכיון?', { confirmLabel: 'לארכיון' }))) return;
        await fail(await ctx.actions.setGoalArchived({ goalId: g.id, archived: true }));
      } }, 'לארכיון')))) : h('p', { class: 'hint' }, 'אין יעדים פעילים.'),
    hidden ? h('p', { class: 'hint', 'data-hidden-goals': String(hidden) }, `+${hidden} יעדים מוסתרים`) : null,
    ctx.progressUi.goalForm ? goalForm(ctx) : h('button', { type: 'button', 'data-id': 'new-goal', onclick: () => { ctx.progressUi.goalForm = {}; ctx.rerender(); } }, '+ יעד חדש'));
}

function goalForm(ctx) {
  const f = ctx.progressUi.goalForm;
  const exercises = ctx.store.exercises.filter((e) => GOAL_EXERCISES.includes(e.id) && e.measurement.type !== 'unresolved' && goalFormFor(e.measurement.type).length > 0);
  const ex = exercises.find((e) => e.id === f.exerciseId) ?? null;
  const metrics = ex ? goalFormFor(ex.measurement.type) : [];
  const m = metrics.find((x) => x.metric === f.metric) ?? null;
  const set = (patch) => { Object.assign(f, patch); ctx.rerender(); };
  const input = (name, attrs) => {
    const el = h('input', { class: 'in', dir: 'ltr', value: f[name] ?? '', 'data-goal-field': name, ...attrs });
    el.addEventListener('input', () => { f[name] = el.value; });
    return el;
  };
  const save = async () => {
    const unit = ex.measurement.loadUnit ?? 'kg';
    const basis = ex.measurement.loadBasis ?? 'total';
    const num = (v) => (/^\d+(?:[.,]\d+)?$/.test(String(v ?? '').trim()) ? Number(String(v).replace(',', '.')) : null);
    const target = {};
    if (m.fields.includes('load')) Object.assign(target, { load: num(f.load), loadUnit: unit, loadBasis: basis });
    if (m.fields.includes('reps')) target.reps = /^\d+$/.test(String(f.reps ?? '').trim()) ? Number(f.reps) : null;
    if (m.fields.includes('distanceKm')) target.distanceM = num(f.distanceKm) === null ? null : Math.round(num(f.distanceKm) * 10000) / 10;
    if (m.fields.includes('duration')) target.durationSec = parseDurationInput(f.duration ?? '');
    if (m.fields.includes('timeBasis')) target.timeBasis = f.timeBasis ?? null;
    if (Object.values(target).some((v) => v === null || v === undefined)) return messageBox('חסר ערך או שהוא לא תקין.');
    const r = await fail(await ctx.actions.addGoal({ exerciseId: ex.id, metric: m.metric, target, deadline: f.deadline || null }));
    if (r.ok) { ctx.progressUi.goalForm = null; ctx.rerender(); }
    return r;
  };
  return h('section', { class: 'card', 'data-form': 'goal' },
    h('h3', {}, 'יעד חדש'),
    h('select', { class: 'in', 'data-goal-field': 'exerciseId', onchange: (e) => set({ exerciseId: e.target.value, metric: null }) },
      h('option', { value: '', selected: !ex }, 'בחר תרגיל'),
      ...exercises.map((e) => h('option', { value: e.id, selected: e.id === f.exerciseId }, e.name))),
    ex ? h('select', { class: 'in', 'data-goal-field': 'metric', onchange: (e) => set({ metric: e.target.value }) },
      h('option', { value: '', selected: !m }, 'סוג יעד'),
      ...metrics.map((x) => h('option', { value: x.metric, selected: x.metric === f.metric }, x.label))) : null,
    m?.fields.includes('load') ? h('label', {}, `משקל (${ex.measurement.loadUnit === 'lb' ? 'lb' : 'ק״ג'}${BASIS_LABELS[ex.measurement.loadBasis] ? ` ${BASIS_LABELS[ex.measurement.loadBasis]}` : ''})`, input('load', { inputmode: 'decimal' })) : null,
    m?.fields.includes('reps') ? h('label', {}, 'חזרות לפחות (2 ומעלה)', input('reps', { inputmode: 'numeric' })) : null,
    m?.fields.includes('distanceKm') ? h('label', {}, 'מרחק (ק״מ)', input('distanceKm', { inputmode: 'decimal' })) : null,
    m?.fields.includes('duration') ? h('label', {}, 'זמן (דק׳:שנ׳ או ש׳:דק׳:שנ׳)', input('duration', {})) : null,
    m?.fields.includes('timeBasis') ? h('select', { class: 'in', 'data-goal-field': 'timeBasis', onchange: (e) => { f.timeBasis = e.target.value || null; } },
      h('option', { value: '' }, 'בסיס זמן (חובה)'), h('option', { value: 'elapsed', selected: f.timeBasis === 'elapsed' }, 'זמן כולל (כולל עצירות)'), h('option', { value: 'moving', selected: f.timeBasis === 'moving' }, 'זמן תנועה')) : null,
    m ? h('label', {}, 'תאריך יעד (רשות)', input('deadline', { type: 'date' })) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'pri', disabled: !m, 'data-id': 'save-goal', onclick: save }, 'שמור יעד'),
      h('button', { type: 'button', onclick: () => { ctx.progressUi.goalForm = null; ctx.rerender(); } }, 'ביטול')));
}

function distanceSection(ctx) {
  const groups = distanceModel(ctx.store);
  if (!groups.length) return null;
  return h('section', { 'data-section': '10k' },
    h('h2', {}, '10 ק״מ'),
    ...groups.map((g) => h('div', { class: 'card' }, h('b', {}, g.label), h('ol', {}, ...g.results.slice(0, 5).map((r) => h('li', {}, `${r.text} · ${formatDate(r.date)}`))))));
}

function subnavBar(ctx) {
  const tab = ctx.progressUi.activeTab || 'charts';
  const tabs = [
    { id: 'charts', label: 'גרפים' },
    { id: 'records', label: 'שיאים' },
    { id: 'compare', label: 'השוואה' },
    { id: 'goals', label: 'יעדים' },
  ];
  return h('div', { class: 'row metric-tabs progress-subnav', 'data-id': 'progress-subnav' },
    ...tabs.map((t) => h('button', {
      type: 'button',
      'data-subtab': t.id,
      'aria-pressed': String(tab === t.id),
      class: tab === t.id ? 'pri' : '',
      onclick: () => { ctx.progressUi.activeTab = t.id; ctx.rerender(); },
    }, t.label)));
}

function listView(ctx, wantedId) {
  const list = progressExercises(ctx.store);
  const firstKey = keyChartsModel(ctx.store)[0]?.id;
  const sel = list.find((e) => e.id === (wantedId ?? ctx.progressUi.exerciseId ?? firstKey)) ?? list[0] ?? null;
  const pick = (id) => { ctx.progressUi.exerciseId = id; ctx.progressUi.metric = null; ctx.rerender(); };
  const tab = ctx.progressUi.activeTab || 'charts';
  const showRecords = tab === 'all' || tab === 'records';
  const showCompare = tab === 'all' || tab === 'compare';
  const showCharts = tab === 'all' || tab === 'charts';
  const showGoals = tab === 'all' || tab === 'goals';
  const keyCards = keyChartsModel(ctx.store).length > 0;

  return h('div', { 'data-view': 'progress' },
    subnavBar(ctx),
    showRecords && tab !== 'all' ? mainRecordsSection(ctx) : null,
    showRecords && tab !== 'all' ? h('details', { class: 'all-records', open: ctx.progressUi.manualRecordForm || ctx.progressUi.prFilterExerciseId ? true : null }, h('summary', {}, 'כל השיאים'), personalRecordsSection(ctx)) : null,
    showRecords && tab === 'all' ? personalRecordsSection(ctx) : null,
    showCompare ? comparisonsSection(ctx) : null,
    showGoals ? goalsSection(ctx) : null,
    showGoals ? distanceSection(ctx) : null,
    showCharts ? keyChartsSection(ctx) : null,
    showCharts
      ? (list.length ? h('details', { class: 'all-exercises', open: !keyCards || ctx.progressUi.exerciseId ? true : null },
          h('summary', {}, 'כל התרגילים'),
          h('select', { class: 'in', 'data-id': 'exercise-select', 'aria-label': 'כל התרגילים', onchange: (e) => pick(e.target.value) },
            ...list.map((e) => h('option', { value: e.id, selected: sel && e.id === sel.id }, `${e.name} · ${e.sessions}`))),
          sel ? exerciseDetail(ctx, sel.id) : null)
          : h('p', { class: 'hint', 'data-empty': 'true' }, 'אין עדיין אימונים.'))
      : null);
}

/** The records that matter: a few big numbers per exercise. Everything else stays under "כל השיאים". */
function mainRecordsSection(ctx) {
  const rows = mainRecordsModel(ctx.store);
  const groups = [...new Set(rows.map((r) => r.group))];
  return h('section', { 'data-section': 'main-records' },
    h('div', { class: 'row section-header-row' },
      h('h2', {}, 'שיאים'),
      h('button', { type: 'button', 'data-id': 'add-record', onclick: () => { ctx.progressUi.manualRecordForm = {}; ctx.rerender(); } }, '+ שיא')),
    ...groups.map((g) => h('div', { class: 'card main-record', 'data-record-group': g },
      h('b', {}, bdi(g)),
      ...rows.filter((r) => r.group === g).map((r) => h('div', { class: r.value === null ? 'mr-row mr-empty' : 'mr-row', 'data-record': r.id },
        h('span', { class: 'hint' }, r.label),
        h('span', { class: 'mr-v' }, r.value ?? '—'),
        h('span', { class: 'hint mr-meta' }, [r.note, r.date ? formatDate(r.date) : null].filter(Boolean).join(' · ')))))));
}

function bestText(type, b, loadUnit) {
  const u = loadUnit === 'lb' ? 'lb' : 'ק״ג';
  if (['weight_reps', 'bodyweight_plus_load'].includes(type)) return `${b.load === null ? '—' : `${type === 'bodyweight_plus_load' ? '+' : ''}${formatNumber(b.load)} ${u}`} × ${b.reps ?? '—'}`;
  if (type === 'bodyweight_reps') return `${b.reps ?? '—'} חזרות`;
  if (type === 'duration') return formatSeconds(b.durationSec);
  if (type === 'distance_duration') return `${b.distanceM === null ? '—' : `${formatNumber(b.distanceM / 1000)} ק״מ`} · ${b.durationSec === null ? '—' : formatSeconds(b.durationSec)}`;
  if (type === 'load_distance') return `${b.load === null ? '—' : `${formatNumber(b.load)} ${u}`} · ${b.distanceM === null ? '—' : `${formatNumber(b.distanceM)} מ׳`}`;
  return '';
}

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text = null) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== null) el.textContent = text;
  return el;
};

/** An SVG chart of real saved points: dated x axis, labelled min/max, a line only from 3 points. */
function chart(series, loadUnit) {
  const { points, metric } = series;
  const W = 320;
  const H = 170;
  const L = 8;
  const R = 8;
  const T = 18;
  const B = 24;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const days = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const d0 = days(points[0].date);
  const d1 = days(points.at(-1).date);
  const x = (p) => (d1 === d0 ? (L + W - R) / 2 : L + ((days(p.date) - d0) / (d1 - d0)) * (W - L - R));
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'data-chart': metric, 'data-points': points.length });
  svg.append(svgEl('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'axis' }));
  svg.append(svgEl('line', { x1: L, y1: y(Math.max(...vals)), x2: W - R, y2: y(Math.max(...vals)), class: 'grid' }));
  if (series.line) svg.append(svgEl('polyline', { points: points.map((p) => `${x(p)},${y(p.value)}`).join(' '), class: 'trace' }));
  points.forEach((p, i) => {
    const c = svgEl('circle', { cx: x(p), cy: y(p.value), r: i === points.length - 1 ? 5.5 : 3.5, class: i === points.length - 1 ? 'dot last' : 'dot' });
    c.append(svgEl('title', {}, `${formatDate(p.date)} · ${p.text}`));
    svg.append(c);
  });
  svg.append(svgEl('text', { x: L, y: 11, class: 'lbl' }, chartValueText(metric, Math.max(...vals), loadUnit)));
  if (Math.min(...vals) !== Math.max(...vals)) svg.append(svgEl('text', { x: L, y: H - B - 5, class: 'lbl' }, chartValueText(metric, Math.min(...vals), loadUnit)));
  svg.append(svgEl('text', { x: L, y: H - 6, class: 'lbl', 'text-anchor': 'start' }, formatDate(points[0].date)));
  if (points.length > 1) svg.append(svgEl('text', { x: W - R, y: H - 6, class: 'lbl', 'text-anchor': 'end' }, formatDate(points.at(-1).date)));
  return h('div', { class: 'chart-wrap', dir: 'ltr' }, svg);
}

/** The main exercises at a glance: last / best weight as big numbers, one clear chart each. */
function keyChartsSection(ctx) {
  const cards = keyChartsModel(ctx.store);
  if (!cards.length) return null;
  return h('section', { 'data-section': 'key-charts' },
    ...cards.map((c) => h('div', { class: 'card key-chart', 'data-key-chart': c.id },
      h('div', { class: 'kc-head' },
        h('b', {}, bdi(c.name), BASIS_LABELS[c.loadBasis] ? ` · ${BASIS_LABELS[c.loadBasis]}` : ''),
        h('span', { class: 'hint' }, `${c.count} אימונים`)),
      h('div', { class: 'kc-nums' },
        h('div', {}, h('span', { class: 'kc-n' }, c.last.text), h('span', { class: 'hint' }, 'אחרון')),
        h('div', {}, h('span', { class: 'kc-n' }, c.top.text), h('span', { class: 'hint' }, 'שיא'))),
      chart(c.series, c.loadUnit))));
}

function groupCard(ctx, g) {
  const metrics = chartMetrics(g.type);
  const gk = `${g.loadBasis ?? '-'}|${g.loadUnit ?? '-'}`;
  const chosen = metrics.find((m) => m.id === ctx.progressUi.metric) ?? metrics[0];
  const series = chosen ? chartSeries(g, chosen.id) : null;
  const notes = [];
  if (series?.noValue) notes.push(`${series.noValue} אימונים בלי ${chosen.label} — לא בגרף`);
  if (series?.undated) notes.push(`${series.undated} בלי תאריך — לא בגרף`);
  return h('section', { class: 'card', 'data-group': gk },
    h('h3', {}, 'לפי אימון', BASIS_LABELS[g.loadBasis] ? ` (${BASIS_LABELS[g.loadBasis]})` : ''),
    metrics.length > 1 ? h('div', { class: 'row metric-tabs' }, ...metrics.map((m) => h('button', { type: 'button', 'data-metric': m.id, 'aria-pressed': String(m.id === chosen.id), class: m.id === chosen.id ? 'pri' : '', onclick: () => { ctx.progressUi.metric = m.id; ctx.rerender(); } }, m.label))) : null,
    !series || series.points.length === 0 ? h('p', { class: 'note note-info', 'data-chart-empty': 'true' }, 'אין נתונים')
      : series.points.length === 1 ? h('p', { class: 'note note-info', 'data-chart-empty': 'true' }, `${series.points[0].text} · ${formatDate(series.points[0].date)} — גרף מ-2 אימונים`)
        : [chart(series, g.loadUnit), series.line ? null : h('p', { class: 'hint', 'data-chart-few': 'true' }, '2 נקודות בלבד')],
    ...notes.map((n) => h('p', { class: 'hint' }, n)),
    h('ol', { class: 'timeline' }, ...[...g.points].reverse().map((x) => h('li', {},
      h('a', { href: `#/history/${encodeURIComponent(x.sessionId)}` }, formatDate(x.date)), ` · ${bestText(g.type, x.best, g.loadUnit)} · ${x.sets} סטים`))));
}

function exerciseDetail(ctx, exerciseId) {
  const p = exerciseProgress(ctx.store, exerciseId);
  if (!p) return h('p', {}, 'התרגיל לא נמצא.');
  return h('div', { 'data-view': 'progress-exercise', 'data-exercise': p.id },
    h('section', { class: 'card' }, h('h3', {}, 'שיאים'),
      p.records.length ? h('ul', { class: 'list' }, ...p.records.map((r) => h('li', {},
        h('b', {}, r.label), ': ', r.calculated ? `${r.calculated.text} (${formatDate(r.calculated.date)})` : '—',
        ...r.manual.map((m) => h('div', { class: 'hint' }, `רשומה ידנית: ${m.text}${m.date ? ` (${formatDate(m.date)})` : ''}${r.higher === 'manual' ? ' — גבוהה יותר' : ''}${m.note ? ` · ${m.note}` : ''}`))))) : h('p', { class: 'hint' }, 'אין שיאים.'),
      p.estimates.length ? h('details', {}, h('summary', {}, 'הערכות 1RM'), h('ul', {}, ...p.estimates.map((e) => h('li', {}, `${e.text} (${formatDate(e.date)})`)))) : null,
      p.assumed.length ? h('details', {}, h('summary', {}, 'לפי משקל גוף משוער'), h('ul', {}, ...p.assumed.map((a) => h('li', {}, `${a.label}: ${a.text}`)))) : null),
    p.mixedGroups ? h('p', { class: 'note note-warn' }, 'כמה בסיסי משקל — מוצגים בנפרד') : null,
    ...p.timeline.map((g) => groupCard(ctx, g)));
}

/** The Progress tab content: #/progress or #/progress/<exerciseId>. */
export function progressView(ctx, parts) {
  return listView(ctx, parts[0] ?? null); // an old #/progress/<id> link selects that exercise on the same screen
}
