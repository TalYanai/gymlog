import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, makeSyntheticGarminCsv } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('V1 Migration, Late Import, Personal Seed & Six Recent Features Verification (Part 4 & Part 7)', () => {
  it('plans and imports a synthetic V1 backup and handles late-import duplicate detection', async () => {
    const { app } = await createTestApp({ startFresh: false });
    assert.equal(app.getState().gate, 'absent');

    const syntheticV1 = {
      workouts: [
        {
          id: 'w-synth-1',
          date: '2026-03-15',
          name: 'Push A',
          entries: [
            {
              name: 'Bench Press',
              sets: [{ w: 82.5, r: 8 }, { w: 82.5, r: 7 }],
            },
            {
              name: 'Unknown Custom Move',
              sets: [{ w: 20, r: 12 }],
            },
          ],
        },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(syntheticV1));
    const plan = await app.planImportV1(bytes);
    assert.equal(plan.ok, true);
    assert.equal(plan.summary.counts.sessions, 1);
    assert.equal(plan.summary.counts.sets, 3);
    assert.equal(plan.summary.report.unresolvedExercises.length, 1);

    const imp = await app.importV1(plan.planId);
    assert.equal(imp.ok, true);
    assert.equal(app.getState().gate, 'open');

    const store = app.snapshot().store;
    assert.equal(store.sessions.length, 1);
    assert.equal(store.sessions[0].origin, 'v1_migration');

    // Late import of the exact same file is rejected with ALREADY_IMPORTED
    const lateSame = await app.planLateImport(bytes);
    assert.equal(lateSame.ok, false);
    assert.equal(lateSame.code, 'ALREADY_IMPORTED');

    // Late import with 1 identical workout and 1 new workout classifies both accurately
    const syntheticV1Second = {
      workouts: [
        ...syntheticV1.workouts,
        {
          id: 'w-synth-2',
          date: '2026-03-18',
          name: 'Heavy Pull Day',
          entries: [
            {
              name: 'Lat Pulldown',
              sets: [{ w: 70, r: 10 }],
            },
          ],
        },
      ],
    };
    const bytes2 = new TextEncoder().encode(JSON.stringify(syntheticV1Second));
    const latePlan = await app.planLateImport(bytes2);
    assert.equal(latePlan.ok, true);
    assert.equal(latePlan.summary.items.length, 2);
    assert.equal(latePlan.summary.items[0].cls, 'identical');
    assert.equal(latePlan.summary.items[1].cls, 'new');

    const lateApply = await app.applyLateImport(latePlan.planId, {});
    assert.equal(lateApply.ok, true);
    assert.equal(app.snapshot().store.sessions.length, 2);
  });

  it('plans and applies a synthetic personal-seed file with explicit review decisions', async () => {
    const { app } = await createTestApp();
    const syntheticPersonal = {
      format: 'gymlog-personal-seed',
      formatVersion: 1,
      items: [
        {
          key: 'goal_bp_100x5',
          kind: 'goal',
          needsReview: false,
          value: {
            exerciseId: 'ex_bench_press',
            metric: 'load_for_min_reps',
            target: { load: 100, loadUnit: 'kg', loadBasis: 'total', reps: 5 },
            deadline: null,
          },
        },
        {
          key: 'mr_pullup_review',
          kind: 'manual_record',
          needsReview: true,
          reviewNote: 'בדיקת משקל נוסף',
          value: {
            exerciseId: 'ex_weighted_pull_up',
            metric: 'actual_1rm',
            load: 40,
            loadUnit: 'kg',
            loadBasis: 'added',
            reps: 1,
            date: '2026-01-10',
          },
        },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(syntheticPersonal));
    const plan = await app.planPersonalSeed(bytes);
    assert.equal(plan.ok, true);
    assert.equal(plan.items.length, 2);
    // Item 1 (needsReview: false) defaults to confirm; Item 2 (needsReview: true) requires user choice
    assert.deepEqual(plan.defaults.goal_bp_100x5, { action: 'confirm' });
    assert.equal(plan.defaults.mr_pullup_review, undefined);

    const decisions = {
      ...plan.defaults,
      mr_pullup_review: { action: 'confirm' },
    };
    const res = await app.applyPersonalSeed(plan.planId, decisions);
    assert.equal(res.ok, true);
    const store = app.snapshot().store;
    assert.equal(store.goals.length, 1);
    assert.equal(store.manualRecords.length, 1);
  });

  it('verifies CSS & UI contracts for the six recent changes (fixed bottom nav, chart styles, back-select)', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
    // Feature #6: Fixed bottom navigation
    assert.match(css, /nav#nav\{position:fixed;bottom:0;left:0;right:0;z-index:15;display:flex/);
    assert.match(css, /body\{min-height:100vh;padding-bottom:calc\(var\(--nav-h,56px\)\s*\+\s*24px\s*\+\s*env\(safe-area-inset-bottom\)\)\}/);
    // Feature #1: Back to workout selection button class
    assert.match(css, /\.back-select\{margin-bottom:8px\}/);
    // Feature #2 & #5: SVG chart classes and inline selector
    assert.match(css, /svg\.chart\{width:100%;height:auto;max-height:200px;display:block\}/);
    const progressJs = fs.readFileSync(path.join(ROOT, 'src/ui/progress.js'), 'utf8');
    assert.match(progressJs, /data-id': 'exercise-select'/);
    assert.match(progressJs, /exerciseDetail\(ctx, sel\.id\)/);
  });

  it('renders DOM views for the six recent changes, local-dev banner, and Garmin CSV load choices', async () => {
    // Minimal DOM shim for src/ui/dom.js and SVG chart rendering
    class FakeNode {
      constructor(tag) {
        this.tagName = tag;
        this.className = '';
        this.textContent = '';
        this.attrs = {};
        this.children = [];
        this.listeners = {};
      }
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
      getAttribute(k) { return this.attrs[k] ?? null; }
      addEventListener(type, fn) { this.listeners[type] = fn; }
      append(...nodes) { this.children.push(...nodes); }
      findAll(pred, out = []) {
        if (pred(this)) out.push(this);
        for (const c of this.children) if (c instanceof FakeNode) c.findAll(pred, out);
        return out;
      }
      fullText() {
        if (this.tagName === '#text') return this.textContent;
        return this.textContent + this.children.map((c) => (c instanceof FakeNode ? c.fullText() : String(c))).join('');
      }
    }
    globalThis.Node = FakeNode;
    globalThis.document = {
      createElement: (tag) => new FakeNode(tag),
      createElementNS: (_ns, tag) => new FakeNode(tag),
      createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = String(t); return n; },
    };

    const { progressView } = await import('../src/ui/progress.js');
    const { workoutView } = await import('../src/ui/workout.js');
    const { previewBanner, csvImportScreen } = await import('../src/ui/screens.js');
    const { detectEnvironment } = await import('../src/ui/flow-model.js');
    const { createInputBuffer } = await import('../src/ui/input-buffer.js');

    const { app, actions } = await createTestApp();
    const buffer = createInputBuffer({
      app,
      commitSet: actions.commitSetValues,
      debounceMs: 5000,
    });

    // Log 3 workouts on Bench Press across 3 dates so the SVG progress chart renders a line + dots
    for (const [date, load] of [['2026-04-01', 80], ['2026-04-08', 85], ['2026-04-15', 90]]) {
      await actions.startWorkout({ templateId: 'tpl_push_a', date });
      const active = app.snapshot().store.activeSession.session;
      const bp = active.performances.find((p) => p.exerciseId === 'ex_bench_press');
      await actions.commitSetValues({ sessionId: active.id, performanceId: bp.id, setId: bp.sets[0].id }, { load, reps: 5 }, { completed: true });
      await actions.finishWorkout({ sessionId: active.id, confirmDrop: true });
    }

    // Add 1 allowed goal (Bench Press) and 1 hidden goal (Deadlift)
    await actions.addGoal({
      exerciseId: 'ex_bench_press',
      metric: 'load_for_min_reps',
      target: { load: 100, loadUnit: 'kg', loadBasis: 'total', reps: 5 },
      deadline: null,
    });
    await actions.addGoal({
      exerciseId: 'ex_deadlift',
      metric: 'actual_1rm',
      target: { load: 180, loadUnit: 'kg', loadBasis: 'total' },
      deadline: null,
    });

    const ctx = {
      app,
      actions,
      buffer,
      env: detectEnvironment({ hostname: 'localhost' }),
      get store() { return app.snapshot().store; },
      progressUi: { goalForm: null, exerciseId: null, metric: null },
      workoutUi: {},
      rerender: () => {},
      navigate: () => {},
      setFlow: () => {},
    };

    // Render Progress View (#2, #4, #5)
    const progTree = progressView(ctx, []);
    const exSelect = progTree.findAll((n) => n.getAttribute('data-id') === 'exercise-select');
    assert.equal(exSelect.length, 1);
    const exDetail = progTree.findAll((n) => n.getAttribute('data-view') === 'progress-exercise');
    assert.equal(exDetail.length, 1);
    assert.equal(exDetail[0].getAttribute('data-exercise'), 'ex_bench_press');
    const svgCharts = progTree.findAll((n) => n.tagName === 'svg' && n.className === 'chart');
    assert.equal(svgCharts.length, 2); // the main-exercise card and the selected exercise's own chart
    assert.deepEqual(svgCharts.map((c) => c.getAttribute('data-points')), ['3', '3']);
    const keyCards = progTree.findAll((n) => n.getAttribute('data-key-chart') !== null);
    assert.deepEqual(keyCards.map((n) => n.getAttribute('data-key-chart')), ['ex_bench_press']);
    const goalsTree = progressView({ ...ctx, progressUi: { ...ctx.progressUi, activeTab: 'goals' } }, []);
    const hiddenGoalsNote = goalsTree.findAll((n) => n.getAttribute('data-hidden-goals') === '1');
    assert.equal(hiddenGoalsNote.length, 1);

    // Render Active Workout View (#1: back-to-select button)
    await actions.startWorkout({ templateId: 'tpl_push_a', date: '2026-04-20' });
    const wkTree = workoutView(ctx);
    const backBtn = wkTree.findAll((n) => n.getAttribute('data-id') === 'back-to-select');
    assert.equal(backBtn.length, 1);
    assert.match(backBtn[0].fullText(), /בחירת אימון/);
    await actions.cancelWorkout({ sessionId: app.snapshot().store.activeSession.session.id });

    // Render Environment Banners (#6 / Part 6)
    const localBanner = previewBanner(detectEnvironment({ hostname: 'localhost' }));
    assert.equal(localBanner.getAttribute('data-screen'), 'local-dev');
    const prevBanner = previewBanner(detectEnvironment({ hostname: 'branch.gymlog-tal.pages.dev' }));
    assert.equal(prevBanner.getAttribute('data-screen'), 'S0');
    assert.equal(previewBanner(detectEnvironment({ hostname: 'gymlog-tal.pages.dev' })), null);

    // Render Garmin CSV Import Screen with NEW exercise requiring explicit load-basis selection (#3 / Part 5)
    const { bytes: csvBytes } = makeSyntheticGarminCsv([
      {
        'שם_אימון_תאריך': 'Pull 10-04-2026',
        'שם_האימון': 'Pull',
        'תאריך': '10-04-2026',
        'מזהה_פעילות_Garmin': '90000000001',
        'Set': '1',
        'Exercise Name': 'Skull Crasher',
        'Time': '0:45',
        'Rest': '1:00',
        'Reps': '10.0',
        'Weight': '30.0 kg',
        'Volume': '300.0 kg',
      },
    ]);
    const csvPlan = await app.planGarminCsv(csvBytes);
    assert.equal(csvPlan.ok, true);
    const decisions = {
      ...csvPlan.defaults,
      names: { 'Skull Crasher': 'new' },
    };
    const preview = await app.previewGarminCsv(csvPlan.planId, decisions);
    const csvTree = csvImportScreen({ ...ctx, flow: { kind: 'csv', plan: csvPlan, decisions, preview } });
    const loadSelect = csvTree.findAll((n) => n.getAttribute('data-load') === 'new:Skull Crasher');
    assert.equal(loadSelect.length, 1);
    const applyBtn = csvTree.findAll((n) => n.getAttribute('data-id') === 'csv-import')[0];
    assert.equal(applyBtn.getAttribute('disabled'), '');
  });
});
