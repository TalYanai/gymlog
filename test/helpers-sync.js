// Two-device simulation helpers: each "device" is a full app on its own memory storage, talking to the
// real server logic (handleSync) over a fake D1. Failure injection: down (no network), dropResponse
// (the server applies the request but the client never sees the answer).
import { createFakeD1 } from './helpers-d1.js';
import { handleSync, _resetEpochCacheForTests } from '../worker/sync-server.js';
import { createSyncEngine } from '../src/sync/engine.js';
import { createTestApp, createMemoryStorage } from './helpers.js';
import { bootstrap } from '../src/app/bootstrap.js';
import { SEED_DOC } from './helpers.js';

export const TOKEN = 'test-token-not-a-secret';

export function createServer() {
  _resetEpochCacheForTests();
  const db = createFakeD1();
  const env = { DB: db, SYNC_TOKEN: TOKEN };
  let n = 0;
  return { db, env, fetchRaw: (path, init) => handleSync(new Request(`https://x.test${path}`, init), env, { now: () => new Date(Date.UTC(2026, 5, 1, 0, 0, ++n)).toISOString() }) };
}

export function directTransport(server, flags) {
  async function call(method, path, body) {
    if (flags.down) return { ok: false, kind: 'network' };
    const res = await server.fetchRaw(path, { method, headers: { authorization: `Bearer ${flags.token ?? TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (flags.dropResponse && method === 'POST') return { ok: false, kind: 'network' };
    const json = await res.json();
    if (res.status === 401) return { ok: false, kind: 'auth' };
    if (res.status === 409 && json.error === 'EPOCH_MISMATCH') return { ok: false, kind: 'epoch' };
    if (!res.ok) return { ok: false, kind: 'server', code: json.error };
    return { ok: true, body: json };
  }
  return {
    status: () => call('GET', '/api/sync/status'),
    export: () => call('GET', '/api/sync/export'),
    pull: (s, l) => call('GET', `/api/sync/pull?since=${s}&limit=${l}`),
    push: (b) => call('POST', '/api/sync/push', b),
  };
}

let devCount = 0;
export async function createDevice(server, { name = `d${++devCount}`, storage = createMemoryStorage(), startFresh = true, startIso, token = TOKEN } = {}) {
  const flags = { down: false, dropResponse: false, token };
  const t = await createTestApp({ storage, startFresh, startIso, idTag: name ? `${name}_` : '' });
  return attach(server, t, flags, name);
}

function attach(server, t, flags, name) {
  const cfg = { token: flags.token, deviceId: `device_${name}` };
  const config = { get: () => cfg, set: (c) => Object.assign(cfg, c) };
  let ops = 0;
  const engine = createSyncEngine({ port: t.syncPort, transport: directTransport(server, flags), config, newOpId: () => `op_${name}_${++ops}_${Math.random().toString(36).slice(2, 8)}`, newDeviceId: () => `device_${name}`, now: t.clock.now });
  return { ...t, name, flags, engine, config, sync: () => engine.sync(), data: () => t.app.snapshot().store };
}

/** "App restart": a new app instance over the same storage (and same device identity). */
export async function restartDevice(server, dev) {
  const { app, store, syncPort } = await bootstrap({ backend: dev.storage.backend, now: dev.clock.now, newId: dev.newId, seedDoc: structuredClone(SEED_DOC), appVersion: '2.0.0' });
  const { createActions } = await import('../src/ui/actions.js');
  return attach(server, { ...dev, app, store, syncPort, actions: createActions(app) }, dev.flags, `${dev.name}`);
}

export async function logWorkout(dev, { date, load = 80, reps = 5, exerciseId = 'ex_bench_press' }) {
  const { actions, app } = dev;
  let r = await actions.startWorkout({ templateId: null, date });
  if (!r.ok) throw new Error(`start: ${r.code}`);
  const sid = app.snapshot().store.activeSession.session.id;
  await actions.addExercise({ sessionId: sid, exerciseId });
  const p = app.snapshot().store.activeSession.session.performances[0];
  await actions.commitSetValues({ sessionId: sid, performanceId: p.id, setId: p.sets[0].id }, { load, reps }, { completed: true });
  r = await actions.finishWorkout({ sessionId: sid, confirmDrop: true });
  if (!r.ok) throw new Error(`finish: ${r.code}`);
  return sid;
}
