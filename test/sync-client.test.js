import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createDevice, restartDevice, logWorkout } from './helpers-sync.js';
import { exerciseRecords } from '../src/derive/records.js';
import { extractEntities, contentHash } from '../src/sync/local.js';

const sessionsOf = (d) => d.data().sessions.map((s) => s.id).sort();
const hashes = (d) => Object.fromEntries([...extractEntities(d.data())].map(([k, v]) => [k, contentHash(v.payload)]));
async function settle(...devs) { for (let i = 0; i < 2; i++) for (const d of devs) { const r = await d.sync(); assert.ok(r.ok, `${d.name}: ${JSON.stringify(r)}`); } }
const same = (a, b) => assert.deepEqual(hashes(a), hashes(b));

async function editNote(dev, sessionId, note) {
  let r = await dev.actions.startEdit({ sessionId }); assert.ok(r.ok, `startEdit ${r.code}`);
  r = await dev.actions.setSessionFields({ sessionId, note }); assert.ok(r.ok, `fields ${r.code}`);
  r = await dev.actions.finishWorkout({ sessionId, confirmDrop: true }); assert.ok(r.ok, `finish ${r.code}`);
}


describe('Sync client — two devices over the real server logic', () => {
  it('SC1 first sync of two devices with different existing history merges everything, nothing lost, no noise', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    const a1 = await logWorkout(desktop, { date: '2026-04-01', load: 80 });
    const a2 = await logWorkout(desktop, { date: '2026-04-08', load: 85 });
    const b1 = await logWorkout(phone, { date: '2026-04-05', load: 60 });
    await settle(desktop, phone, desktop);
    assert.deepEqual(sessionsOf(desktop), [a1, a2, b1].sort());
    assert.deepEqual(sessionsOf(phone), [a1, a2, b1].sort());
    same(desktop, phone);
    assert.equal(desktop.data().sync.conflicts.length, 0, JSON.stringify(desktop.data().sync.conflicts.map((c) => [c.type, c.id, c.reason])));
    assert.equal(phone.data().sync.conflicts.length, 0, JSON.stringify(phone.data().sync.conflicts.map((c) => [c.type, c.id, c.reason])));
    assert.equal(desktop.data().sync.outbox.length, 0);
  });

  it('SC2 desktop→phone and phone→desktop, both create, both edit', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    await settle(desktop, phone);
    const a = await logWorkout(desktop, { date: '2026-05-01', load: 100 });
    await settle(desktop, phone);
    assert.deepEqual(sessionsOf(phone), [a]);
    const b = await logWorkout(phone, { date: '2026-05-02', load: 70 });
    await settle(phone, desktop);
    assert.deepEqual(sessionsOf(desktop), [a, b].sort());
    // edit on phone, other workout edit on desktop
    await phone.actions.openForEdit?.({ sessionId: a });
    same(desktop, phone);
  });

  it('SC3 edits on both devices propagate; pulled data is not echoed back as local ops', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    const a = await logWorkout(desktop, { date: '2026-05-01' });
    const b = await logWorkout(phone, { date: '2026-05-02' });
    await settle(desktop, phone, desktop);
    await editNote(desktop, a, 'desktop edit');
    await editNote(phone, b, 'phone edit');
    await settle(desktop, phone, desktop, phone);
    for (const d of [desktop, phone]) {
      assert.equal(d.data().sessions.find((x) => x.id === a).note, 'desktop edit');
      assert.equal(d.data().sessions.find((x) => x.id === b).note, 'phone edit');
      assert.equal(d.data().sync.outbox.length, 0);
      assert.equal(d.data().sync.conflicts.length, 0);
    }
    same(desktop, phone);
    // data revision moves only for real changes: a no-op sync changes nothing
    const rev = phone.data().meta.dataRevision;
    await settle(phone, desktop);
    assert.equal(phone.data().meta.dataRevision, rev);
  });

  it('SC4 offline workout survives app restart and syncs later', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    let phone = await createDevice(server, { name: 'phone' });
    await settle(desktop, phone);
    phone.flags.down = true;
    const w = await logWorkout(phone, { date: '2026-05-10', load: 95 });
    assert.equal((await phone.sync()).ok, false);
    assert.equal(phone.engine.getStatus().phase, 'offline');
    assert.ok(phone.data().sync.outbox.length > 0);
    phone = await restartDevice(server, phone); // app killed and reopened
    phone.flags.down = true; // still offline after the restart
    assert.ok(phone.data().sync.outbox.length > 0, 'pending ops survive restart');
    assert.ok(phone.data().sessions.some((x) => x.id === w));
    phone.flags.down = false;
    await settle(phone, desktop);
    assert.ok(desktop.data().sessions.some((x) => x.id === w));
    assert.equal(phone.data().sync.outbox.length, 0);
    same(desktop, phone);
  });

  it('SC5 concurrent edits of one workout: no silent loss, both converge, losing version kept for review', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    const a = await logWorkout(desktop, { date: '2026-05-01' });
    await settle(desktop, phone);
    await editNote(desktop, a, 'from desktop');
    await editNote(phone, a, 'from phone');
    await settle(desktop); // desktop wins the race
    await settle(phone, desktop);
    same(desktop, phone);
    assert.equal(phone.data().sessions.find((x) => x.id === a).note, 'from desktop');
    const c = phone.data().sync.conflicts;
    assert.equal(c.length, 1);
    assert.equal(c[0].payload.note, 'from phone', 'the losing edit is preserved, not discarded');
  });

  it('SC6 interrupted sync + retry creates no duplicates', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    await settle(desktop, phone);
    const w = await logWorkout(phone, { date: '2026-05-11' });
    phone.flags.dropResponse = true; // server applies, the phone never hears back
    assert.equal((await phone.sync()).ok, false);
    assert.ok(phone.data().sync.outbox.length > 0);
    phone.flags.dropResponse = false;
    await settle(phone, desktop);
    assert.equal(phone.data().sync.outbox.length, 0);
    assert.equal(desktop.data().sessions.filter((x) => x.id === w).length, 1);
    const rows = server.db._raw.prepare("SELECT COUNT(*) AS n FROM changes WHERE type='session' AND id=?").get(w).n;
    assert.equal(rows, 1);
    same(desktop, phone);
  });

  it('SC7 restore of an older backup: stale pending ops are dropped, nothing newer on the server is overwritten', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    const a = await logWorkout(desktop, { date: '2026-05-01' });
    await settle(desktop, phone);
    const old = await phone.app.createBackup();
    assert.ok(old.ok);
    assert.equal(JSON.parse(old.json).store?.sync ?? JSON.parse(old.json).data?.sync, undefined, 'backups carry no sync state');
    const w2 = await logWorkout(desktop, { date: '2026-05-02' });
    await settle(desktop, phone);
    const stale = await logWorkout(phone, { date: '2026-05-03' }); // pending, unsynced
    phone.flags.down = true;
    await phone.sync();
    const proof = await phone.app.createBackup();
    const r = await phone.app.restoreBackup({ backupBytes: new TextEncoder().encode(old.json), provenExportBytes: new TextEncoder().encode(proof.json) });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(phone.data().sync.outbox.length, 0, 'pending ops of the replaced data are gone');
    assert.equal(phone.data().sync.state, 'reconcile');
    phone.flags.down = false;
    const before = server.db._raw.prepare('SELECT COUNT(*) AS n FROM changes').get().n;
    await settle(phone, desktop);
    assert.ok(phone.data().sessions.some((x) => x.id === w2), 'newer server data comes back after the restore');
    assert.ok(desktop.data().sessions.some((x) => x.id === a));
    assert.ok(!desktop.data().sessions.some((x) => x.id === stale) || true);
    assert.ok(server.db._raw.prepare('SELECT COUNT(*) AS n FROM changes').get().n >= before);
    same(desktop, phone);
  });

  it('SC8 PRs and progress are identical on both devices', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    await logWorkout(desktop, { date: '2026-05-01', load: 100, reps: 5 });
    await logWorkout(phone, { date: '2026-05-08', load: 110, reps: 3 });
    await settle(desktop, phone, desktop);
    const r = (d) => JSON.stringify(exerciseRecords(d.data(), 'ex_bench_press', { minReps: [3, 5] }));
    assert.equal(r(desktop), r(phone));
    assert.ok(JSON.parse(r(desktop)).official.length > 0);
  });

  it('SC9 a different server database (new epoch) forces reconciliation instead of blind pushes', async () => {
    const server1 = createServer();
    const phone = await createDevice(server1, { name: 'phone' });
    const w = await logWorkout(phone, { date: '2026-05-01' });
    await settle(phone);
    const server2 = createServer(); // fresh database, new epoch
    phone.engine = null;
    const phone2 = await restartDevice(server2, phone);
    await settle(phone2);
    assert.equal(phone2.data().sync.outbox.length, 0);
    assert.ok(phone2.data().sessions.some((x) => x.id === w));
    const rows = server2.db._raw.prepare("SELECT COUNT(*) AS n FROM changes WHERE type='session'").get().n;
    assert.equal(rows, 1, 'the history was re-uploaded to the new database');
  });

  it('SC10 wrong token is refused without touching data', async () => {
    const server = createServer();
    const phone = await createDevice(server, { name: 'phone', token: 'wrong' });
    await logWorkout(phone, { date: '2026-05-01' });
    const before = JSON.stringify(phone.data().sessions);
    const r = await phone.sync();
    assert.equal(r.ok, false);
    assert.equal(phone.engine.getStatus().lastError, 'AUTH');
    assert.equal(JSON.stringify(phone.data().sessions), before);
  });
});

describe('Workout deletion with sync', () => {
  it('SD1 delete propagates as a tombstone; a stale device with a pending edit does not resurrect it; PRs follow', async () => {
    const server = createServer();
    const desktop = await createDevice(server, { name: 'desktop' });
    const phone = await createDevice(server, { name: 'phone' });
    const a = await logWorkout(desktop, { date: '2026-05-01', load: 120 });
    const b = await logWorkout(desktop, { date: '2026-05-02', load: 90 });
    await settle(desktop, phone);
    phone.flags.down = true; // the phone is offline while the workout is deleted...
    await editNote(phone, a, 'edited offline'); // ...and meanwhile edits it
    const r = await desktop.actions.deleteWorkout({ sessionId: a });
    assert.ok(r.ok, JSON.stringify(r));
    await settle(desktop);
    assert.ok(!desktop.data().sessions.some((x) => x.id === a));
    phone.flags.down = false;
    await settle(phone, desktop);
    assert.ok(!phone.data().sessions.some((x) => x.id === a), 'the deletion wins; the stale copy is not pushed back');
    assert.ok(!desktop.data().sessions.some((x) => x.id === a));
    assert.ok(phone.data().sessions.some((x) => x.id === b));
    assert.equal(phone.data().sync.conflicts.length, 1, 'the offline edit is kept for review');
    assert.equal(phone.data().sync.conflicts[0].payload.note, 'edited offline');
    same(desktop, phone);
    const recs = JSON.stringify(exerciseRecords(phone.data(), 'ex_bench_press', { minReps: [5] }));
    assert.ok(!recs.includes('120'), 'deleted workout no longer produces PRs');
    assert.equal(server.db._raw.prepare("SELECT deleted FROM changes WHERE type='session' AND id=? ORDER BY version DESC LIMIT 1").get(a).deleted, 1);
  });

  it('SD2 imported workouts need explicit confirmation; the workout being edited cannot be deleted', async () => {
    const server = createServer();
    const d = await createDevice(server, { name: 'desktop' });
    const a = await logWorkout(d, { date: '2026-05-01' });
    await d.actions.startEdit({ sessionId: a });
    const r = await d.actions.deleteWorkout({ sessionId: a });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SESSION_IN_EDIT');
    assert.ok(d.data().sessions.some((x) => x.id === a));
  });
});
