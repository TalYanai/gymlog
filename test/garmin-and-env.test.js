import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, makeSyntheticGarminCsv } from './helpers.js';
import { analyzeGarminCsv, defaultDecisions, missingDecisions, buildGarminImport, NEW, IGNORE, squash, GARMIN_ALIASES } from '../src/import/garmin-csv.js';
import { loadDecisionsNeeded, missingText, newLoadChoices } from '../src/ui/csv-model.js';
import { isProductionHost, isLocalDevHost, PRODUCTION_HOST } from '../src/ui/config.js';
import { detectEnvironment } from '../src/ui/flow-model.js';
import { setupPwa } from '../src/ui/pwa.js';

describe('Garmin CSV Import Data-Integrity & Mapping Regressions (Part 5)', () => {
  const syntheticRows = [
    // Exact catalog match: Bench Press
    {
      'שם_אימון_תאריך': 'אימון כוח 10-04-2026',
      'שם_האימון': 'אימון כוח',
      'תאריך': '10-04-2026',
      'מזהה_פעילות_Garmin': '90000000001',
      'Set': '1',
      'Exercise Name': 'Bench Press',
      'Time': '0:45',
      'Rest': '1:30',
      'Reps': '8.0',
      'Weight': '80.0 kg',
      'Volume': '640.0 kg',
    },
    // Similar/ambiguous names that MUST NOT auto-map or silently default to NEW with loadBasis: 'total'
    {
      'שם_אימון_תאריך': 'אימון כוח 10-04-2026',
      'שם_האימון': 'אימון כוח',
      'תאריך': '10-04-2026',
      'מזהה_פעילות_Garmin': '90000000001',
      'Set': '2',
      'Exercise Name': 'Lat Pull Down',
      'Time': '0:40',
      'Rest': '1:30',
      'Reps': '10.0',
      'Weight': '65.0 kg',
      'Volume': '650.0 kg',
    },
    {
      'שם_אימון_תאריך': 'אימון כוח 10-04-2026',
      'שם_האימון': 'אימון כוח',
      'תאריך': '10-04-2026',
      'מזהה_פעילות_Garmin': '90000000001',
      'Set': '3',
      'Exercise Name': 'Skull Crasher',
      'Time': '0:35',
      'Rest': '1:15',
      'Reps': '12.0',
      'Weight': '12.5 kg',
      'Volume': '150.0 kg',
    },
    {
      'שם_אימון_תאריך': 'אימון כוח 10-04-2026',
      'שם_האימון': 'אימון כוח',
      'תאריך': '10-04-2026',
      'מזהה_פעילות_Garmin': '90000000001',
      'Set': '4',
      'Exercise Name': 'Pull-up',
      'Time': '0:30',
      'Rest': '2:00',
      'Reps': '6.0',
      'Weight': '10.0 kg',
      'Volume': '60.0 kg',
    },
    {
      'שם_אימון_תאריך': 'אימון כוח 10-04-2026',
      'שם_האימון': 'אימון כוח',
      'תאריך': '10-04-2026',
      'מזהה_פעילות_Garmin': '90000000001',
      'Set': '5',
      'Exercise Name': 'Row',
      'Time': '0:40',
      'Rest': '1:30',
      'Reps': '10.0',
      'Weight': '32.0 kg',
      'Volume': '320.0 kg',
    },
    // Unidentified "Choose an Exercise"
    {
      'שם_אימון_תאריך': 'אימון כוח 10-04-2026',
      'שם_האימון': 'אימון כוח',
      'תאריך': '10-04-2026',
      'מזהה_פעילות_Garmin': '90000000001',
      'Set': '6',
      'Exercise Name': 'Choose an Exercise',
      'Time': '0:30',
      'Rest': '1:00',
      'Reps': '15.0',
      'Weight': '20.0 kg',
      'Volume': '300.0 kg',
    },
  ];

  it('maps names automatically: exact/alias matches are pre-selected, any other name defaults to NEW under its Garmin name, only the load basis stays open', async () => {
    const { app } = await createTestApp();
    const store = app.snapshot().store;
    const csv = makeSyntheticGarminCsv(syntheticRows);

    const plan = await app.planGarminCsv(csv.bytes, 'synthetic.csv');
    assert.equal(plan.ok, true);

    const { analysis, defaults } = plan;
    // exact (case/space/hyphen-insensitive) and known aliases: pre-selected to the existing exercise
    assert.equal(defaults.names['Bench Press'], 'ex_bench_press');
    assert.equal(defaults.names['Lat Pull Down'], 'ex_lat_pulldown');
    // no match (also "similar" names): NEW under the original Garmin name, never guessed
    assert.equal(defaults.names['Skull Crasher'], NEW);
    assert.equal(defaults.names['Pull-up'], NEW);
    assert.equal(defaults.names['Row'], NEW);
    // "Choose an Exercise" is never mapped and never listed as a name
    assert.ok(!analysis.names.some((n) => n.name === 'Choose an Exercise'));
    assert.equal(defaults.names['Choose an Exercise'], undefined);

    // no name decision is missing any more; the load basis is still asked (never assumed)
    const missing = missingDecisions(analysis, defaults, store);
    assert.deepEqual(missing.filter((m) => m.kind === 'name'), []);
    assert.ok(missing.some((m) => m.kind === 'load' && m.ref === 'ex_bench_press'));
    assert.ok(missing.some((m) => m.kind === 'load' && m.ref === 'new:Row'));
  });

  it('squash: case, spaces, hyphens and punctuation are ignored; Hebrew letters kept; the alias table maps exactly four names', () => {
    assert.equal(squash('Lat Pull-down'), 'latpulldown');
    assert.equal(squash('  Weighted  Pull-Up '), 'weightedpullup');
    assert.equal(squash('שחייה – חתירה'), 'שחייהחתירה');
    assert.equal(squash(''), '');
    assert.deepEqual(Object.keys(GARMIN_ALIASES).sort(), ['cableoverheadtricepsextension', 'latpulldown', 'overheaddumbbelltricepsextension', 'weightedpullup']);
  });

  it('known Garmin aliases map automatically to the existing exercises; similar names do not', async () => {
    const { app } = await createTestApp();
    const mk = (name, n) => ({ 'שם_אימון_תאריך': 'כוח 10-04-2026', 'שם_האימון': 'כוח', 'תאריך': '10-04-2026', 'מזהה_פעילות_Garmin': '90000000002', Set: String(n), 'Exercise Name': name, Time: '0:30', Rest: '1:00', Reps: '10.0', Weight: '20.0 kg', Volume: '200.0 kg' });
    const names = ['Lat Pull-down', 'Weighted Pull-up', 'Cable Overhead Triceps Extension', 'Overhead Dumbbell Triceps Extension', 'Overhead Triceps Extension'];
    const plan = await app.planGarminCsv(makeSyntheticGarminCsv(names.map((n, i) => mk(n, i + 1))).bytes, 'alias.csv');
    assert.equal(plan.ok, true);
    assert.equal(plan.defaults.names['Lat Pull-down'], 'ex_lat_pulldown');
    assert.equal(plan.defaults.names['Weighted Pull-up'], 'ex_weighted_pull_up');
    assert.equal(plan.defaults.names['Cable Overhead Triceps Extension'], 'ex_overhead_extension');
    assert.equal(plan.defaults.names['Overhead Dumbbell Triceps Extension'], 'ex_db_skull_crusher');
    assert.equal(plan.defaults.names['Overhead Triceps Extension'], NEW); // similar, not an alias
  });

  it('a Pool Swim activity is imported as pool swimming (ex_swim_freestyle, titled שחייה) with its distance and elapsed time', async () => {
    const { app } = await createTestApp();
    const row = { 'שם_אימון_תאריך': 'Pool Swim 10-04-2026', 'שם_האימון': 'Pool Swim', 'תאריך': '10-04-2026', 'מזהה_פעילות_Garmin': '90000000003', Set: '1', 'Exercise Name': 'Lap Swimming', Time: '39:17', Rest: '0:00', Reps: '', Weight: '--', Volume: '', 'Distance km': '1.02', 'Moving Time': '39:00' };
    const plan = await app.planGarminCsv(makeSyntheticGarminCsv([row]).bytes, 'swim.csv');
    assert.equal(plan.ok, true);
    const d = structuredClone(plan.defaults);
    d.datesConfirmed = true;
    d.unit = 'kg';
    const done = await app.applyGarminCsv(plan.planId, d);
    assert.ok(done.ok, JSON.stringify(done));
    const ses = app.snapshot().store.sessions.find((x) => x.provenance?.fingerprint === 'garmin:90000000003');
    assert.equal(ses.templateNameSnapshot, 'שחייה');
    assert.deepEqual(ses.performances.map((p) => p.exerciseId), ['ex_swim_freestyle']);
    const set = ses.performances[0].sets[0];
    assert.equal(set.distanceM, 1020);
    assert.equal(set.durationSec, 39 * 60 + 17);
    assert.equal(set.durationBasis, 'elapsed');
  });

  it('requires explicit load-basis selection when accepting a weighted Garmin exercise as NEW (never assumes total)', async () => {
    const { app } = await createTestApp();
    const store = app.snapshot().store;
    const csv = makeSyntheticGarminCsv(syntheticRows);
    const plan = await app.planGarminCsv(csv.bytes, 'synthetic.csv');
    assert.equal(plan.ok, true);

    const decisions = structuredClone(plan.defaults);
    decisions.datesConfirmed = true;
    decisions.unit = 'kg';
    // Map Lat Pull Down -> ex_lat_pulldown, Pull-up -> ex_weighted_pull_up, Row -> ex_one_arm_db_row
    decisions.names['Lat Pull Down'] = 'ex_lat_pulldown';
    decisions.names['Pull-up'] = 'ex_weighted_pull_up';
    decisions.names['Row'] = 'ex_one_arm_db_row';
    // Accept 'Skull Crasher' as a NEW custom exercise under its original Garmin name
    decisions.names['Skull Crasher'] = NEW;

    // Confirm catalog exercise loads, but leave 'new:Skull Crasher' load undecided
    decisions.load.ex_bench_press = 'basis';
    decisions.load.ex_lat_pulldown = 'basis';
    decisions.load.ex_weighted_pull_up = 'basis';
    decisions.load.ex_one_arm_db_row = 'basis';

    const missingBefore = missingDecisions(plan.analysis, decisions, store);
    assert.deepEqual(missingBefore, [{ kind: 'load', ref: 'new:Skull Crasher' }]);
    assert.deepEqual(loadDecisionsNeeded(missingBefore), ['new:Skull Crasher']);
    assert.match(missingText(missingBefore, store)[0], /Skull Crasher/);
    assert.ok(newLoadChoices().some((c) => c.value === 'per_hand'));

    // Now explicitly choose 'per_hand' for 'new:Skull Crasher'
    decisions.load['new:Skull Crasher'] = 'per_hand';
    const missingAfter = missingDecisions(plan.analysis, decisions, store);
    assert.deepEqual(missingAfter, []);

    const pv = await app.previewGarminCsv(plan.planId, decisions);
    assert.equal(pv.ok, true);
    assert.equal(pv.complete, true);
    assert.deepEqual(pv.newExercises, ['Skull Crasher']);

    const applyRes = await app.applyGarminCsv(plan.planId, decisions);
    assert.equal(applyRes.ok, true);

    const updated = app.snapshot().store;
    const customEx = updated.exercises.find((e) => e.name === 'Skull Crasher');
    assert.ok(customEx);
    assert.ok(customEx.id.startsWith('ex_csvn_'));
    assert.equal(customEx.measurement.type, 'weight_reps');
    assert.equal(customEx.measurement.loadBasis, 'per_hand');
    assert.equal(customEx.measurement.loadUnit, 'kg');

    // Verify provenance and sourceRaw preservation on imported session
    assert.equal(updated.sessions.length, 1);
    const ses = updated.sessions[0];
    assert.equal(ses.origin, 'csv_import');
    assert.equal(ses.provenance.fingerprint, 'garmin:90000000001');
    // Set 6 ("Choose an Exercise") is preserved as unresolved with raw values intact
    const unresPerf = ses.performances.find((p) => p.measurement.type === 'unresolved');
    assert.ok(unresPerf);
    assert.equal(unresPerf.sets[0].load, null);
    assert.equal(unresPerf.sets[0].sourceRaw.rows[0].cells.Weight, '20.0 kg');

    // Verify repeated import of a new CSV containing 'Skull Crasher' automatically suggests & reuses the existing ex_csvn_* exercise
    const secondCsv = makeSyntheticGarminCsv([
      {
        'שם_אימון_תאריך': 'אימון כוח 12-04-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '12-04-2026',
        'מזהה_פעילות_Garmin': '90000000002',
        'Set': '1',
        'Exercise Name': 'Skull Crasher',
        'Time': '0:35',
        'Rest': '1:15',
        'Reps': '10.0',
        'Weight': '15.0 kg',
        'Volume': '150.0 kg',
      },
    ]);
    const plan2 = await app.planGarminCsv(secondCsv.bytes, 'synthetic2.csv');
    assert.equal(plan2.ok, true);
    assert.equal(plan2.defaults.names['Skull Crasher'], customEx.id);

    // Verify repeated import of the same activity is skipped without duplicates
    const repeatCsv = makeSyntheticGarminCsv([
      ...syntheticRows,
      {
        'שם_אימון_תאריך': 'אימון כוח 12-04-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '12-04-2026',
        'מזהה_פעילות_Garmin': '90000000002',
        'Set': '1',
        'Exercise Name': 'Skull Crasher',
        'Time': '0:35',
        'Rest': '1:15',
        'Reps': '10.0',
        'Weight': '15.0 kg',
        'Volume': '150.0 kg',
      },
    ]);
    const planRepeat = await app.planGarminCsv(repeatCsv.bytes, 'repeat.csv');
    assert.equal(planRepeat.ok, true);
    const act1 = planRepeat.analysis.activities.find((a) => a.id === '90000000001');
    assert.equal(act1.status, 'already');
  });

  it('preserves weight in sourceRaw only (with warning) and creates an unresolved exercise when user selects unknown load semantics for a NEW Garmin exercise (AUD-01)', async () => {
    const { app } = await createTestApp();
    const store = app.snapshot().store;
    const csv = makeSyntheticGarminCsv([
      {
        'שם_אימון_תאריך': 'אימון 15-04-2026',
        'שם_האימון': 'אימון',
        'תאריך': '15-04-2026',
        'מזהה_פעילות_Garmin': '90000000003',
        'Set': '1',
        'Exercise Name': 'Mystery Machine Press',
        'Time': '0:40',
        'Rest': '1:00',
        'Reps': '10.0',
        'Weight': '45.0 kg',
        'Volume': '450.0 kg',
      },
    ]);
    const plan = await app.planGarminCsv(csv.bytes, 'mystery.csv');
    const decisions = structuredClone(plan.defaults);
    decisions.datesConfirmed = true;
    decisions.unit = 'kg';
    decisions.names['Mystery Machine Press'] = NEW;
    decisions.load['new:Mystery Machine Press'] = 'unknown';

    const b = await buildGarminImport(plan.analysis, decisions, { store, importedAt: '2026-05-01T12:00:00.000Z' });
    assert.equal(b.ok, true);
    const ex = b.additions.exercises[0];
    assert.equal(ex.name, 'Mystery Machine Press');
    assert.equal(ex.measurement.type, 'unresolved');
    assert.ok(ex.id.startsWith('ex_csvu_'));
    const importedSet = b.additions.sessions[0].performances[0].sets[0];
    assert.equal(importedSet.load, null);
    assert.equal(importedSet.reps, null);
    assert.equal(importedSet.sourceRaw.rows[0].cells.Weight, '45.0 kg');
    assert.ok(importedSet.warnings.includes('CSV_LOAD_SEMANTICS_UNRESOLVED'));
  });

  it('enforces case-insensitive exact match, rejects archived/conflicting existing exercise reuse on NEW, and scopes rowsOfName strictly (AUD-02, AUD-03, AUD-04)', async () => {
    const { app } = await createTestApp();
    // Archive ex_lateral_raise to test AUD-02 when creating NEW with same name
    await app.commit((draft) => {
      const lr = draft.exercises.find((e) => e.id === 'ex_lateral_raise');
      lr.archived = true;
      return draft;
    });
    const store = app.snapshot().store;
    const csv = makeSyntheticGarminCsv([
      // Case-insensitive exact match to Bench Press ('bench press')
      {
        'שם_אימון_תאריך': 'אימון A 16-04-2026',
        'שם_האימון': 'אימון A',
        'תאריך': '16-04-2026',
        'מזהה_פעילות_Garmin': '90000000010',
        'Set': '1',
        'Exercise Name': 'bench press',
        'Time': '0:40',
        'Rest': '1:00',
        'Reps': '8.0',
        'Weight': '80.0 kg',
        'Volume': '640.0 kg',
      },
      // Archived exercise name chosen as NEW -> should report invalid_target (AUD-02)
      {
        'שם_אימון_תאריך': 'אימון A 16-04-2026',
        'שם_האימון': 'אימון A',
        'תאריך': '16-04-2026',
        'מזהה_פעילות_Garmin': '90000000010',
        'Set': '2',
        'Exercise Name': 'Lateral Raise',
        'Time': '0:40',
        'Rest': '1:00',
        'Reps': '12.0',
        'Weight': '10.0 kg',
        'Volume': '120.0 kg',
      },
      // Activity set aside ('aside') has weighted row for 'Push-up', while imported activity has only bodyweight 'Push-up' (AUD-03)
      {
        'שם_אימון_תאריך': 'אימון B 17-04-2026',
        'שם_האימון': 'אימון B',
        'תאריך': '17-04-2026',
        'מזהה_פעילות_Garmin': '90000000011',
        'Set': '1',
        'Exercise Name': 'Push-up',
        'Time': '0:40',
        'Rest': '1:00',
        'Reps': '20.0',
        'Weight': '20.0 kg',
        'Volume': '400.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון C 18-04-2026',
        'שם_האימון': 'אימון C',
        'תאריך': '18-04-2026',
        'מזהה_פעילות_Garmin': '90000000012',
        'Set': '1',
        'Exercise Name': 'Push-up',
        'Time': '0:40',
        'Rest': '1:00',
        'Reps': '25.0',
        'Weight': 'Bodyweight',
        'Volume': '0.0',
      },
    ]);

    const plan = await app.planGarminCsv(csv.bytes, 'aud.csv');
    assert.equal(plan.ok, true);
    // AUD-04: 'bench press' matched ex_bench_press case-insensitively
    const bpEntry = plan.analysis.names.find((n) => n.name === 'bench press');
    assert.equal(bpEntry.suggested, 'ex_bench_press');
    assert.equal(plan.defaults.names['bench press'], 'ex_bench_press');

    const decisions = structuredClone(plan.defaults);
    decisions.datesConfirmed = true;
    decisions.unit = 'kg';
    decisions.load.ex_bench_press = 'basis';
    // AUD-02: Trying to create NEW for 'Lateral Raise' when an archived exercise with that name exists
    decisions.names['Lateral Raise'] = NEW;
    decisions.load['new:Lateral Raise'] = 'per_hand';
    decisions.activities['90000000011'] = 'aside';
    decisions.names['Push-up'] = NEW;

    const miss = missingDecisions(plan.analysis, decisions, store);
    assert.ok(miss.some((m) => m.kind === 'invalid_target'));

    // Fix 'Lateral Raise' to 'unresolved' and verify AUD-03: 'Push-up' in imported activity 90000000012 has no weights,
    // so it does NOT require a load decision and creates a bodyweight_reps exercise cleanly!
    decisions.names['Lateral Raise'] = 'unresolved';
    assert.deepEqual(missingDecisions(plan.analysis, decisions, store), []);
    const built = await buildGarminImport(plan.analysis, decisions, { store, importedAt: '2026-05-01T12:00:00.000Z' });
    assert.equal(built.ok, true);
    const pushUpEx = built.additions.exercises.find((e) => e.name === 'Push-up');
    assert.equal(pushUpEx.measurement.type, 'bodyweight_reps');
  });

  it('consolidates core exercises, ignores minor exercises without creating ex_csvu_* clutter, retains all sessions, and gates row-level unconfirmed loads', async () => {
    const { buildSafeArchiveDecisions } = await import('../src/import/garmin-archive.js');
    const { app } = await createTestApp();
    const csv = makeSyntheticGarminCsv([
      // Activity 1: Core exercises (Bench Press barbell 80kg + DB 30kg, Pull-up +20kg + carry-over 90kg, Lateral Raise 15kg + carry-over 60kg, Lat Pull Down, Skull Crasher) + minor (WarmUp, Curl, Choose an Exercise)
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '1',
        'Exercise Name': 'WarmUp',
        'Time': '2:00',
        'Rest': '0:30',
        'Reps': '15.0',
        'Weight': 'Bodyweight',
        'Volume': '0.0',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '2',
        'Exercise Name': 'Bench Press',
        'Time': '0:40',
        'Rest': '1:30',
        'Reps': '8.0',
        'Weight': '85.0 kg',
        'Volume': '680.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '3',
        'Exercise Name': 'Bench Press',
        'Time': '0:40',
        'Rest': '1:30',
        'Reps': '10.0',
        'Weight': '30.0 kg',
        'Volume': '300.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '4',
        'Exercise Name': 'Pull-up',
        'Time': '0:35',
        'Rest': '2:00',
        'Reps': '6.0',
        'Weight': '25.0 kg',
        'Volume': '150.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '5',
        'Exercise Name': 'Pull-up',
        'Time': '0:35',
        'Rest': '2:00',
        'Reps': '8.0',
        'Weight': '90.0 kg',
        'Volume': '720.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '6',
        'Exercise Name': 'Lateral Raise',
        'Time': '0:30',
        'Rest': '1:00',
        'Reps': '12.0',
        'Weight': '15.0 kg',
        'Volume': '180.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '7',
        'Exercise Name': 'Lateral Raise',
        'Time': '0:30',
        'Rest': '1:00',
        'Reps': '12.0',
        'Weight': '60.0 kg',
        'Volume': '720.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '8',
        'Exercise Name': 'Lat Pull Down',
        'Time': '0:40',
        'Rest': '1:30',
        'Reps': '7.0',
        'Weight': '85.5 kg',
        'Volume': '598.5 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '9',
        'Exercise Name': 'Skull Crasher',
        'Time': '0:35',
        'Rest': '1:15',
        'Reps': '13.0',
        'Weight': '20.0 kg',
        'Volume': '260.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '10',
        'Exercise Name': 'Curl',
        'Time': '0:35',
        'Rest': '1:00',
        'Reps': '10.0',
        'Weight': '15.0 kg',
        'Volume': '150.0 kg',
      },
      {
        'שם_אימון_תאריך': 'אימון כוח 01-07-2026',
        'שם_האימון': 'אימון כוח',
        'תאריך': '01-07-2026',
        'מזהה_פעילות_Garmin': '90000000020',
        'Set': '11',
        'Exercise Name': 'Choose an Exercise',
        'Time': '0:35',
        'Rest': '1:00',
        'Reps': '10.0',
        'Weight': '20.0 kg',
        'Volume': '200.0 kg',
      },
      // Activity 2: Session containing ONLY minor exercises (e.g. Jump Rope + Choose an Exercise) -> session must still be retained!
      {
        'שם_אימון_תאריך': 'HIIT 02-07-2026',
        'שם_האימון': 'HIIT',
        'תאריך': '02-07-2026',
        'מזהה_פעילות_Garmin': '90000000021',
        'Set': '1',
        'Exercise Name': 'Jump Rope',
        'Time': '1:00',
        'Rest': '0:30',
        'Reps': '50.0',
        'Weight': 'Bodyweight',
        'Volume': '0.0',
      },
    ]);

    const plan = await app.planGarminCsv(csv.bytes, 'refined.csv');
    assert.equal(plan.ok, true);
    const decisions = buildSafeArchiveDecisions(plan.analysis, app.snapshot().store);
    assert.equal(decisions.names.WarmUp, IGNORE);
    assert.equal(decisions.names.Curl, IGNORE);
    assert.equal(decisions.names['Jump Rope'], IGNORE);
    assert.equal(decisions.names['Choose an Exercise'], IGNORE);

    const applied = await app.applyGarminCsv(plan.planId, decisions);
    assert.equal(applied.ok, true);
    assert.equal(applied.report.reconciliation.ignored, 4);
    assert.equal(applied.report.reconciliation.imported, 8);

    const st = app.snapshot().store;
    // Both sessions retained (including Activity 2 which had only minor exercises)
    assert.equal(st.sessions.length, 2);
    assert.equal(st.sessions[1].performances.length, 0);
    // Zero unresolved or custom exercises created
    assert.equal(st.exercises.filter((e) => e.id.startsWith('ex_csv')).length, 0);

    // Check row-level load gating on Activity 1
    const perfs = st.sessions[0].performances;
    const bpPerf = perfs.find((p) => p.exerciseId === 'ex_bench_press');
    assert.equal(bpPerf.sets[0].load, 85); // >= 40 kg barbell confirmed
    assert.equal(bpPerf.sets[1].load, null); // < 40 kg dumbbell unconfirmed, kept in sourceRaw
    assert.equal(bpPerf.sets[1].sourceRaw.rows[0].cells.Weight, '30.0 kg');

    const puPerf = perfs.find((p) => p.exerciseId === 'ex_weighted_pull_up');
    assert.equal(puPerf.sets[0].load, 25); // <= 45 kg added weight confirmed
    assert.equal(puPerf.sets[1].load, null); // 90 kg carry-over unconfirmed

    const lrPerf = perfs.find((p) => p.exerciseId === 'ex_lateral_raise');
    assert.equal(lrPerf.sets[0].load, 15); // <= 22.5 kg per_hand confirmed
    assert.equal(lrPerf.sets[1].load, null); // 60 kg carry-over unconfirmed

    const lpdPerf = perfs.find((p) => p.exerciseId === 'ex_lat_pulldown');
    assert.equal(lpdPerf.sets[0].load, 85.5);

    const scPerf = perfs.find((p) => p.exerciseId === 'ex_db_skull_crusher');
    assert.equal(scPerf.sets[0].load, null); // unconfirmed load basis per review note
    assert.equal(scPerf.sets[0].reps, 13);
  });
});

describe('Environment Detection, Local Dev Isolation & Backup/Restore (Part 6)', () => {
  it('distinguishes production, local dev, and preview hosts strictly', () => {
    assert.equal(isProductionHost(PRODUCTION_HOST), true);
    assert.equal(isProductionHost('gymlog-tal.pages.dev'), true);
    assert.equal(isProductionHost('localhost'), false);
    assert.equal(isLocalDevHost('localhost'), true);
    assert.equal(isLocalDevHost('127.0.0.1'), true);
    assert.equal(isLocalDevHost('[::1]'), true);
    assert.equal(isLocalDevHost('evil-localhost.com'), false);

    // Production on iOS standalone -> allowed
    const prodIosApp = detectEnvironment({ hostname: PRODUCTION_HOST, userAgent: 'iPhone', standalone: true });
    assert.equal(prodIosApp.mode, 'production');
    assert.equal(prodIosApp.preview, false);
    assert.equal(prodIosApp.localDev, false);
    assert.equal(prodIosApp.dataTransfer, 'allowed');

    // Production on iOS browser tab -> blocked until installed ('install')
    const prodIosTab = detectEnvironment({ hostname: PRODUCTION_HOST, userAgent: 'iPhone', standalone: false });
    assert.equal(prodIosTab.mode, 'production');
    assert.equal(prodIosTab.dataTransfer, 'install');

    // Arbitrary preview host -> blocked ('preview')
    const previewEnv = detectEnvironment({ hostname: 'preview-123.workers.dev', userAgent: 'Mozilla/5.0' });
    assert.equal(previewEnv.mode, 'preview');
    assert.equal(previewEnv.preview, true);
    assert.equal(previewEnv.localDev, false);
    assert.equal(previewEnv.dataTransfer, 'preview');

    // Local development on desktop -> mode 'local', dataTransfer 'allowed', PWA service worker not installed
    const localEnv = detectEnvironment({ hostname: 'localhost', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    assert.equal(localEnv.mode, 'local');
    assert.equal(localEnv.localDev, true);
    assert.equal(localEnv.preview, false);
    assert.equal(localEnv.dataTransfer, 'allowed');
  });

  it('skips PWA service worker registration in both preview and localDev modes', async () => {
    const localEnv = detectEnvironment({ hostname: 'localhost' });
    const resLocal = await setupPwa({ env: localEnv, flush: async () => {}, canUpdate: () => true, win: {} });
    assert.deepEqual(resLocal, { installed: false, reason: 'local' });

    const prevEnv = detectEnvironment({ hostname: 'example.com' });
    const resPrev = await setupPwa({ env: prevEnv, flush: async () => {}, canUpdate: () => true, win: {} });
    assert.deepEqual(resPrev, { installed: false, reason: 'preview' });
  });

  it('creates a full verified backup and restores it safely with proven export and prevCopy protection', async () => {
    const { app, actions } = await createTestApp();
    await actions.startWorkout({ templateId: null, date: '2026-05-03' });
    let s = app.snapshot().store;
    const sid = s.activeSession.session.id;
    await actions.addExercise({ sessionId: sid, exerciseId: 'ex_bench_press' });
    s = app.snapshot().store;
    const pid = s.activeSession.session.performances[0].id;
    const setId = s.activeSession.session.performances[0].sets[0].id;
    await actions.commitSetValues({ sessionId: sid, performanceId: pid, setId }, { load: 75, reps: 10 }, { completed: true });
    await actions.finishWorkout({ sessionId: sid, confirmDrop: false });

    const b1 = await app.createBackup();
    assert.equal(b1.ok, true);
    assert.equal(b1.complete, true);
    const b1Bytes = new TextEncoder().encode(b1.json);

    // Log another workout so current state differs from b1
    await actions.startWorkout({ templateId: null, date: '2026-05-04' });
    s = app.snapshot().store;
    const sid2 = s.activeSession.session.id;
    await actions.addExercise({ sessionId: sid2, exerciseId: 'ex_weighted_pull_up' });
    s = app.snapshot().store;
    await actions.commitSetValues(
      { sessionId: sid2, performanceId: s.activeSession.session.performances[0].id, setId: s.activeSession.session.performances[0].sets[0].id },
      { load: 15, reps: 8 },
      { completed: true },
    );
    await actions.finishWorkout({ sessionId: sid2, confirmDrop: false });
    assert.equal(app.snapshot().store.sessions.length, 2);

    // Export current state as proof before restore
    const proofBackup = await app.createBackup();
    const proofBytes = new TextEncoder().encode(proofBackup.json);

    const restRes = await app.restoreBackup({ backupBytes: b1Bytes, provenExportBytes: proofBytes });
    assert.equal(restRes.ok, true);
    assert.equal(app.snapshot().store.sessions.length, 1);
    assert.ok(app.getState().prevCopy);
  });

  it('serves runtime files on 127.0.0.1 with strict CSP headers and blocks personal/dev files (404)', async () => {
    const { createDevServer } = await import('../scripts/dev-server.mjs');
    const server = createDevServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
      for (const okPath of ['/', '/index.html', '/src/ui/main.js', '/seed-defaults.json', '/precache.json']) {
        const res = await fetch(`${base}${okPath}`);
        assert.equal(res.status, 200, `Expected 200 for ${okPath}`);
        assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      }
      for (const blockedPath of ['/gymlog-personal.json', '/unified_workouts.csv', '/package.json', '/test/helpers.js', '/scripts/build-dist.mjs']) {
        const res = await fetch(`${base}${blockedPath}`);
        assert.equal(res.status, 404, `Expected 404 for ${blockedPath}`);
      }
      // AUD-05: Malformed percent-encoded URL must return 400 Bad Request, never crash the server
      const badRes = await fetch(`${base}/%E0%A4%A`);
      assert.equal(badRes.status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('parses synthetic Garmin FIT binary buffers and converts strength, HIIT, running, and swimming activities cleanly', async () => {
    const {
      ARCHIVE_CSV_COLUMNS,
      parseFitBuffer,
      buildActivityCsvRows,
      serializeGarminCsv,
      buildSafeArchiveDecisions,
    } = await import('../src/import/garmin-archive.js');

    // Construct a minimal valid binary .FIT buffer with 1 definition (21B) + 1 set message (12B) = 33B dataSize
    const fullFit = new Uint8Array(14 + 33);
    const fdv = new DataView(fullFit.buffer);
    fdv.setUint8(0, 14);
    fdv.setUint32(4, 33, true);
    fullFit.set([0x2e, 0x46, 0x49, 0x54], 8);
    let p = 14;
    fdv.setUint8(p++, 0x40); // definition, local 0
    fdv.setUint8(p++, 0); // reserved
    fdv.setUint8(p++, 0); // little-endian
    fdv.setUint16(p, 225, true); p += 2; // globalMesgNum = 225 (set)
    fdv.setUint8(p++, 5); // 5 fields
    // f0: num=0 (duration), size=4, baseType=6 (uint32)
    fullFit.set([0, 4, 6], p); p += 3;
    // f3: num=3 (reps), size=2, baseType=4 (uint16)
    fullFit.set([3, 2, 4], p); p += 3;
    // f4: num=4 (weight), size=2, baseType=4 (uint16)
    fullFit.set([4, 2, 4], p); p += 3;
    // f5: num=5 (set_type), size=1, baseType=2 (uint8)
    fullFit.set([5, 1, 2], p); p += 3;
    // f7: num=7 (category), size=2, baseType=4 (uint16)
    fullFit.set([7, 2, 4], p); p += 3;
    // Data message at p (11 bytes): local 0
    fdv.setUint8(p++, 0x00);
    fdv.setUint32(p, 42000, true); p += 4; // 42.0s
    fdv.setUint16(p, 10, true); p += 2; // 10 reps
    fdv.setUint16(p, 80 * 16, true); p += 2; // 80 kg
    fdv.setUint8(p++, 1); // active set
    fdv.setUint16(p, 0, true); p += 2; // category 0 = Bench Press

    const msgs = parseFitBuffer(fullFit, { allowedMessages: [225] });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].globalMesgNum, 225);
    assert.equal(msgs[0].fields[3], 10);
    assert.equal(msgs[0].fields[4], 1280);

    const strengthAct = buildActivityCsvRows({
      summary: {
        activityId: 990001,
        name: 'Synthetic Strength',
        activityType: 'strength_training',
        startTimeGmt: Date.parse('2026-06-15T08:00:00Z'),
        startTimeLocal: Date.parse('2026-06-15T11:00:00Z'),
        duration: 1800000,
      },
      fitMsgs: msgs,
      fitFileName: 'synthetic.fit',
    });
    assert.equal(strengthAct.kind, 'sets');
    assert.equal(strengthAct.rows.length, 1);
    assert.equal(strengthAct.rows[0]['Exercise Name'], 'Bench Press');
    assert.equal(strengthAct.rows[0].Weight, '80 kg');

    const runAct = buildActivityCsvRows({
      summary: {
        activityId: 990002,
        name: 'Synthetic Run',
        activityType: 'running',
        startTimeGmt: Date.parse('2026-06-16T08:00:00Z'),
        startTimeLocal: Date.parse('2026-06-16T11:00:00Z'),
        duration: 1500000,
        movingDuration: 1480000,
        distance: 500000, // 5.00 km in cm
      },
      fitMsgs: [],
    });
    assert.equal(runAct.kind, 'run');
    assert.equal(runAct.rows[0]['Distance km'], '5.00');

    const csvText = serializeGarminCsv([...strengthAct.rows, ...runAct.rows], ARCHIVE_CSV_COLUMNS);
    const { app } = await createTestApp();
    const plan = await app.planGarminCsv(new TextEncoder().encode(csvText), 'synth-archive.csv');
    assert.equal(plan.ok, true);
    const decisions = buildSafeArchiveDecisions(plan.analysis, app.snapshot().store);
    const applied = await app.applyGarminCsv(plan.planId, decisions);
    assert.equal(applied.ok, true);
    assert.equal(app.snapshot().store.sessions.length, 2);
  });
});
