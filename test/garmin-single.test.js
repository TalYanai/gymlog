import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singleToWide, activityIdFromFileName, normalizeDate } from '../src/import/garmin-single.js';
import { createTestApp } from './helpers.js';

const enc = (s) => new TextEncoder().encode(s);
const SETS = `"Set","Exercise Name","Time","Rest","Reps","Weight","Volume"
"1","Choose an Exercise","1:52","1:18.2","5","--","--"
"2","Curl","0:46.9","1:21.1","12","12.5 kg","150 kg"
"11","Bench Press","0:33.2","1:27.6","9","80 kg","720 kg"
`;
const ROUNDS = `"","Round","Exercise Name","Time","Rest","Reps","Weight"
"","1","Round 1","11:34","5:29","6",""
"","1-1","Choose an Exercise","11:34","5:29","6","Add Weight"
"","3","Round 3","16:59","2:02","75",""
"","3-1","Choose an Exercise","16:59","2:02","75","Add Weight"
`;
const opt = { date: '2026-11-10', title: 'Push', activityId: '25000462779' };

describe('single-activity Garmin CSV', () => {
  it('helpers', () => {
    assert.equal(activityIdFromFileName('activity_25000462779.csv'), '25000462779');
    assert.equal(activityIdFromFileName('x.csv'), null);
    assert.equal(normalizeDate('2026-11-10'), '10-11-2026');
    assert.equal(normalizeDate('10-11-2026'), '10-11-2026');
    assert.equal(normalizeDate('nope'), null);
  });
  it('rejects bad input without guessing', () => {
    assert.equal(singleToWide(enc(SETS), { ...opt, date: '' }).code, 'SINGLE_BAD_DATE');
    assert.equal(singleToWide(enc(SETS), { ...opt, activityId: null }).code, 'SINGLE_BAD_ID');
    assert.equal(singleToWide(enc(SETS), { ...opt, title: ' ' }).code, 'SINGLE_BAD_TITLE');
    assert.equal(singleToWide(enc('a,b\n1,2\n'), opt).code, 'SINGLE_UNSUPPORTED');
  });
  for (const [name, text, kind] of [['strength', SETS, 'sets'], ['HIIT rounds', ROUNDS, 'rounds']]) {
    it(`${name}: converts and analyzes with the existing importer`, async () => {
      const r = singleToWide(enc(text), opt);
      assert.ok(r.ok);
      assert.equal(r.kind, kind);
      const { app } = await createTestApp();
      const plan = await app.planGarminCsv(enc(r.csv), 'activity_25000462779.csv');
      assert.ok(plan.ok, JSON.stringify(plan));
      assert.equal(plan.analysis.activities.length, 1);
      // names are mapped automatically (exact/alias, otherwise NEW under the Garmin name): only the load basis, unit and dates stay open
      const pv0 = await app.previewGarminCsv(plan.planId, plan.defaults);
      assert.equal(pv0.complete, false);
      assert.ok(pv0.missing.every((m) => ['load', 'unit', 'dates'].includes(m.kind)), JSON.stringify(pv0.missing));
      const d = structuredClone(plan.defaults);
      d.datesConfirmed = true;
      d.unit = 'kg';
      for (const m of pv0.missing) if (m.kind === 'name') d.names[m.ref] = 'ignore';
      for (const m of pv0.missing) if (m.kind === 'load') d.load[m.ref] = m.ref.startsWith('new:') ? 'total' : 'basis';
      for (const m of pv0.missing) if (m.kind === 'row') d.rows[m.ref] = 'ignore';
      const pv = await app.previewGarminCsv(plan.planId, d);
      assert.ok(pv.ok && pv.complete, JSON.stringify(pv));
      assert.equal(pv.counts.sessions, 1);
      const done = await app.applyGarminCsv(plan.planId, d);
      assert.ok(done.ok, JSON.stringify(done));
      // the same activity again is a duplicate, never a second session
      const again = await app.planGarminCsv(enc(singleToWide(enc(text), { ...opt, title: 'Other' }).csv), 'activity_25000462779.csv');
      assert.ok(!again.ok || again.analysis.alreadyFile || again.analysis.activities.every((a) => a.status !== 'new'), JSON.stringify(again.ok ? again.analysis.activities : again));
    });
  }
  it('a single HIIT file becomes one ex_hiit exercise whose duration is the total of round time + rest (same shape as the history import)', async () => {
    const r = singleToWide(enc(ROUNDS), { ...opt, title: 'HIIT' });
    const { app } = await createTestApp();
    const plan = await app.planGarminCsv(enc(r.csv), 'activity_25000462779.csv');
    const d = structuredClone(plan.defaults);
    d.datesConfirmed = true;
    d.unit = 'kg';
    const pv = await app.previewGarminCsv(plan.planId, d);
    assert.ok(pv.ok && pv.complete, JSON.stringify(pv));
    assert.deepEqual(pv.unresolved, []);
    assert.equal(pv.counts.performances, 1);
    assert.equal(pv.counts.sets, 1);
    const done = await app.applyGarminCsv(plan.planId, d);
    assert.ok(done.ok, JSON.stringify(done));
    const ses = app.snapshot().store.sessions.find((x) => x.provenance?.fingerprint === 'garmin:25000462779');
    assert.deepEqual(ses.performances.map((p) => p.exerciseId), ['ex_hiit']);
    assert.equal(ses.performances[0].sets[0].durationSec, 694 + 329 + 1019 + 122); // (11:34 + 5:29) + (16:59 + 2:02)
  });
});
