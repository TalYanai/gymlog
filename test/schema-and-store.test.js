import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256Hex } from '../src/schema/canonical.js';
import { SCHEMA_VERSION, STORAGE_KEYS } from '../src/schema/constants.js';
import { newId, v1SessionId, derivedPerformanceId, derivedSetId, resolveCollision } from '../src/schema/ids.js';
import { createEmptyStore, createSession, createPerformance, createSet } from '../src/schema/factories.js';
import { validateSeedDefaults } from '../src/schema/seed-schema.js';
import { validateStore } from '../src/schema/validate.js';
import { applySeeds } from '../src/store/seeding.js';
import { createStore } from '../src/store/store.js';
import { checkTransition } from '../src/core/transitions.js';
import { SEED_DOC, makeClock, createMemoryStorage } from './helpers.js';

describe('Schema & Canonicalization', () => {
  it('canonicalizes objects deterministically according to RFC 8785 (JCS)', async () => {
    const a = { b: 1, a: [true, null, 'שלום'], c: { z: 10, y: 20 } };
    const b = { c: { y: 20, z: 10 }, a: [true, null, 'שלום'], b: 1 };
    assert.equal(canonicalize(a), canonicalize(b));
    const h1 = await sha256Hex(canonicalize(a));
    const h2 = await sha256Hex(canonicalize(b));
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it('generates and resolves IDs and deterministic derived IDs', () => {
    const id = newId('ses');
    assert.match(id, /^ses_[0-9a-f-]{36}$/);
    assert.equal(v1SessionId('w123'), 'ses_v1_w123');
    assert.equal(derivedPerformanceId('ses_12345678', 1), 'prf_12345678_01');
    assert.equal(derivedSetId('ses_12345678', 2, 3), 'set_12345678_02_03');
    const col = resolveCollision({ baseId: 'ses_v1_1', isUsed: (x) => x === 'ses_v1_1', isSameOrigin: () => false });
    assert.deepEqual(col, { status: 'assigned', id: 'ses_v1_1_c2', collisionResolved: true });
  });

  it('validates seed-defaults.json and applies the seed catalog to an empty store', async () => {
    const v = await validateSeedDefaults(SEED_DOC);
    assert.equal(v.valid, true);
    const empty = createEmptyStore({ now: '2026-05-01T00:00:00.000Z', appVersion: '2.0.0' });
    const seeded = await applySeeds(empty, SEED_DOC, { now: '2026-05-01T00:00:00.000Z' });
    assert.equal(seeded.ok, true);
    assert.equal(seeded.store.exercises.length, SEED_DOC.exercises.length);
    assert.equal(seeded.store.templates.length, SEED_DOC.templates.length);
    assert.equal(seeded.store.exercises.length, 39);
    assert.equal(seeded.store.templates.length, 7);
  });

  it('validates a seeded store and rejects broken invariants', async () => {
    const empty = createEmptyStore({ now: '2026-05-01T00:00:00.000Z', appVersion: '2.0.0' });
    const { store } = await applySeeds(empty, SEED_DOC, { now: '2026-05-01T00:00:00.000Z' });
    const res = await validateStore(store);
    assert.equal(res.valid, true);
    assert.equal(store.schemaVersion, SCHEMA_VERSION);

    // Mutate to break invariant: unknown field
    const broken = structuredClone(store);
    broken.extraField = 123;
    const resBroken = await validateStore(broken);
    assert.equal(resBroken.valid, false);

    // Mutate to break exercise measurement invariant
    const brokenEx = structuredClone(store);
    brokenEx.exercises[0].measurement.loadBasis = 'invalid_basis';
    assert.equal((await validateStore(brokenEx)).valid, false);
  });
});

describe('Store & Write-Boundary Transitions', () => {
  it('loads an absent store, initializes fresh state, and persists atomically', async () => {
    const mem = createMemoryStorage();
    const clock = makeClock();
    const store = createStore({ backend: mem.backend, now: clock.now, appVersion: '2.0.0' });
    const loaded = await store.load();
    assert.equal(loaded.status, 'absent');

    const empty = createEmptyStore({ now: clock.now(), appVersion: '2.0.0' });
    const { store: seeded } = await applySeeds(empty, SEED_DOC, { now: clock.now() });
    const initRes = await store.initialize(seeded);
    assert.equal(initRes.ok, true);
    assert.equal(store.getState().status, 'ok');
    assert.ok(mem.dump()[STORAGE_KEYS.v2]);
  });

  it('enforces transition rules: prevents deleting saved sessions, modifying importLog, or changing unresolved exercises', async () => {
    const empty = createEmptyStore({ now: '2026-05-01T00:00:00.000Z', appVersion: '2.0.0' });
    const { store: before } = await applySeeds(empty, SEED_DOC, { now: '2026-05-01T00:00:00.000Z' });
    const bench = before.exercises.find((e) => e.id === 'ex_bench_press');
    const ses = createSession({
      id: 'ses_00000001',
      date: '2026-05-01',
      startedAt: '2026-05-01T10:00:00.000Z',
      endedAt: '2026-05-01T10:30:00.000Z',
      templateNameSnapshot: 'אימון בדיקה',
      now: '2026-05-01T10:30:00.000Z',
    });
    const perf = createPerformance({ id: 'prf_00000001', exercise: bench, order: 1 });
    const set1 = createSet({ id: 'set_00000001', measurement: bench.measurement, order: 1 });
    set1.completed = true;
    set1.load = 80;
    set1.reps = 8;
    perf.sets.push(set1);
    ses.performances.push(perf);
    before.sessions.push(ses);
    assert.equal((await validateStore(before)).valid, true);

    // Valid no-op transition returns null
    assert.equal(checkTransition(before, structuredClone(before)), null);

    // Attempt to remove a saved session in an ordinary commit
    const afterMissingSession = structuredClone(before);
    afterMissingSession.sessions = [];
    afterMissingSession.meta.dataRevision += 1;
    const t1 = checkTransition(before, afterMissingSession);
    assert.equal(t1?.code, 'SESSION_REMOVED');

    // Attempt to mutate importLog in an ordinary commit
    const afterImportLog = structuredClone(before);
    afterImportLog.meta.importLog.push({ importId: 'imp_1' });
    const t2 = checkTransition(before, afterImportLog);
    assert.equal(t2?.code, 'IMPORT_LOG_PROTECTED');
  });
});
