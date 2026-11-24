// Sync server (worker/sync-server.js) against a D1-shaped sqlite. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSync, _resetEpochCacheForTests } from '../worker/sync-server.js';
import { createFakeD1 } from './helpers-d1.js';

const TOKEN = 'test-token-not-secret';
function server() {
  _resetEpochCacheForTests();
  const env = { DB: createFakeD1(), SYNC_TOKEN: TOKEN };
  const call = async (method, path, body, token = TOKEN) => {
    const r = await handleSync(new Request(`https://x.test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { now: () => '2026-11-10T10:00:00.000Z' });
    return { status: r.status, json: await r.json() };
  };
  return { env, call };
}
const op = (o) => ({ opId: 'op1', type: 'session', id: 'ses_1', base: 0, deleted: false, payload: { id: 'ses_1', n: 1 }, ...o });

test('SS1: auth — no/wrong token refused; unconfigured server refuses', async () => {
  const s = server();
  assert.equal((await s.call('GET', '/api/sync/status', undefined, 'wrong')).status, 401);
  assert.equal((await s.call('GET', '/api/sync/status', undefined, '')).status, 401);
  _resetEpochCacheForTests();
  const r = await handleSync(new Request('https://x.test/api/sync/status'), { DB: createFakeD1() });
  assert.equal(r.status, 503);
});

test('SS2: push applies, versions increase, pull returns the log in order; retry is a duplicate', async () => {
  const s = server();
  const st = (await s.call('GET', '/api/sync/status')).json;
  const p1 = (await s.call('POST', '/api/sync/push', { deviceId: 'd1', epoch: st.epoch, ops: [op({})] })).json;
  assert.deepEqual(p1.results.map((x) => [x.status, x.version]), [['applied', 1]]);
  const p2 = (await s.call('POST', '/api/sync/push', { deviceId: 'd1', epoch: st.epoch, ops: [op({ opId: 'op2', base: 1, payload: { id: 'ses_1', n: 2 } })] })).json;
  assert.deepEqual(p2.results.map((x) => [x.status, x.version]), [['applied', 2]]);
  const retry = (await s.call('POST', '/api/sync/push', { deviceId: 'd1', epoch: st.epoch, ops: [op({})] })).json;
  assert.deepEqual(retry.results.map((x) => [x.status, x.version]), [['duplicate', 1]], 'same opId again: no new row');
  const pull = (await s.call('GET', '/api/sync/pull?since=0')).json;
  assert.deepEqual(pull.changes.map((c) => [c.seq, c.version, c.opId, c.payload.n]), [[1, 1, 'op1', 1], [2, 2, 'op2', 2]]);
  assert.equal(pull.more, false);
  assert.deepEqual((await s.call('GET', '/api/sync/pull?since=1')).json.changes.map((c) => c.seq), [2]);
});

test('SS3: a stale base is a conflict that carries the current server version; nothing is overwritten', async () => {
  const s = server();
  const { epoch } = (await s.call('GET', '/api/sync/status')).json;
  await s.call('POST', '/api/sync/push', { deviceId: 'phone', epoch, ops: [op({})] });
  await s.call('POST', '/api/sync/push', { deviceId: 'phone', epoch, ops: [op({ opId: 'op2', base: 1, payload: { id: 'ses_1', n: 2 } })] });
  const stale = (await s.call('POST', '/api/sync/push', { deviceId: 'pc', epoch, ops: [op({ opId: 'op3', base: 1, payload: { id: 'ses_1', n: 99 } })] })).json;
  assert.equal(stale.results[0].status, 'conflict');
  assert.deepEqual(stale.results[0].current, { version: 2, deleted: false, payload: { id: 'ses_1', n: 2 } });
  const fresh = (await s.call('POST', '/api/sync/push', { deviceId: 'pc', epoch, ops: [op({ opId: 'op4', base: 0 })] })).json;
  assert.equal(fresh.results[0].status, 'conflict', 'a device that thinks the entity is new cannot overwrite an existing one');
  assert.equal((await s.call('GET', '/api/sync/pull?since=0')).json.changes.length, 2);
});

test('SS4: deletes are tombstones — a stale device cannot resurrect; a current device can recreate', async () => {
  const s = server();
  const { epoch } = (await s.call('GET', '/api/sync/status')).json;
  await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({})] });
  const del = (await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({ opId: 'op2', base: 1, deleted: true, payload: null })] })).json;
  assert.equal(del.results[0].status, 'applied');
  const stale = (await s.call('POST', '/api/sync/push', { deviceId: 'b', epoch, ops: [op({ opId: 'op3', base: 1, payload: { id: 'ses_1', n: 5 } })] })).json;
  assert.equal(stale.results[0].status, 'conflict');
  assert.equal(stale.results[0].current.deleted, true);
  const pull = (await s.call('GET', '/api/sync/pull?since=0')).json;
  assert.deepEqual(pull.changes.map((c) => [c.version, c.deleted, c.payload === null]), [[1, false, false], [2, true, true]]);
  const back = (await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({ opId: 'op4', base: 2 })] })).json;
  assert.deepEqual([back.results[0].status, back.results[0].version], ['applied', 3]);
});

test('SS5: concurrent writers — exactly one wins a version (UNIQUE lock), the other gets a conflict', async () => {
  const s = server();
  const { epoch } = (await s.call('GET', '/api/sync/status')).json;
  await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({})] });
  const [x, y] = await Promise.all([
    s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({ opId: 'opA', base: 1, payload: { id: 'ses_1', n: 'A' } })] }),
    s.call('POST', '/api/sync/push', { deviceId: 'b', epoch, ops: [op({ opId: 'opB', base: 1, payload: { id: 'ses_1', n: 'B' } })] }),
  ]);
  assert.deepEqual([x.json.results[0].status, y.json.results[0].status].sort(), ['applied', 'conflict']);
  assert.equal((await s.call('GET', '/api/sync/status')).json.maxSeq, 2);
  // the database itself refuses a duplicate version
  assert.throws(() => s.env.DB._raw.prepare("INSERT INTO changes (type,id,version,deleted,payload,op_id,device_id,at) VALUES ('session','ses_1',2,0,'{}','zz','d','t')").run());
});

test('SS6: epoch mismatch is refused (a replaced server database); invalid ops and sizes are refused', async () => {
  const s = server();
  const { epoch } = (await s.call('GET', '/api/sync/status')).json;
  const r = await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch: 'ep_other', ops: [op({})] });
  assert.deepEqual([r.status, r.json.error, r.json.epoch], [409, 'EPOCH_MISMATCH', epoch]);
  assert.equal((await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({ type: 'bogus' })] })).status, 400);
  assert.equal((await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({ deleted: true })] })).status, 400, 'a deletion carries no payload');
  assert.equal((await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: Array.from({ length: 101 }, (_, i) => op({ opId: `o${i}`, id: `s${i}` })) })).status, 400);
  assert.equal((await s.call('GET', '/api/sync/status')).json.maxSeq, 0, 'nothing was written by refused requests');
});

test('SS7: pull pages (more=true), and export returns the latest version of every entity including tombstones', async () => {
  const s = server();
  const { epoch } = (await s.call('GET', '/api/sync/status')).json;
  const ops = Array.from({ length: 5 }, (_, i) => op({ opId: `o${i}`, id: `s${i}`, payload: { id: `s${i}` } }));
  await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops });
  await s.call('POST', '/api/sync/push', { deviceId: 'a', epoch, ops: [op({ opId: 'o9', id: 's0', base: 1, deleted: true, payload: null })] });
  const p = (await s.call('GET', '/api/sync/pull?since=0&limit=4')).json;
  assert.deepEqual([p.changes.length, p.more, p.maxSeq], [4, true, 6]);
  const ex = (await s.call('GET', '/api/sync/export')).json;
  assert.deepEqual(ex.entities.map((e) => [e.id, e.version, e.deleted]), [['s1', 1, false], ['s2', 1, false], ['s3', 1, false], ['s4', 1, false], ['s0', 2, true]]);
});
