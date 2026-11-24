// Client-side synchronization core (pure functions over a store draft). Used by the Store (outbox
// stamping inside the same atomic write as the data) and by bootstrap's sync facade (pull/push results).
//
// The device-local sync section lives in the canonical store under the optional root field `sync`, so
// the data and its pending operations are written by ONE localStorage.setItem and can never diverge.
//
// sync = {
//   v: 1, deviceId, epoch, state: 'active' | 'reconcile',
//   appliedSeq,                       // downstream checkpoint: highest server seq applied locally
//   opCounter,                        // local monotonic op number
//   outbox: [{ opId, n, type, id, deleted, payload, at }],   // durable pending operations (FIFO)
//   known: { 'type:id': { v, h, d } }, // server version / content hash / deleted, as last applied or acked
//   conflicts: [{ cid, type, id, at, reason, deleted, payload, serverVersion }],
//   seenRestores: [restoreId]         // backup_restore entries already reconciled (restore guard)
// }
//
// Upstream checkpoint: an op leaves the outbox only when the server acknowledged it (applied/duplicate)
// or it became a recorded conflict artifact. The base version of an op is derived at send time from
// `known`, and only the oldest op of an entity is sent at a time, so a stale chain can never overwrite.
import { canonicalize } from '../schema/canonical.js';

export const SYNC_FORMAT = 1;
export const ENTITY_TYPES = Object.freeze(['settings', 'exercise', 'template', 'import', 'quarantine', 'session', 'record', 'goal']);
const SYNCED_IMPORT_KINDS = new Set(['v1_migration', 'v1_late_import', 'csv_import', 'personal_seed']);
const ARRAY_OF = Object.freeze({ exercise: 'exercises', template: 'templates', quarantine: 'quarantine', session: 'sessions', record: 'manualRecords', goal: 'goals' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const entityKey = (type, id) => `${type}:${id}`;

/** FNV-1a (52-bit) of the canonical JSON: synchronous change detection only (never a security hash). */
export function contentHash(value) {
  if (value === null || value === undefined) return 'null';
  const s = canonicalize(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${(h2 & 0xfffff).toString(16).padStart(5, '0')}`;
}

const pendingImportIds = (store) => new Set((store?.meta?.importLog ?? []).filter((e) => e.status === 'pending').map((e) => e.importId));
export const hasPendingImport = (store) => pendingImportIds(store).size > 0;

/**
 * Every synchronized entity of a store: Map key → { type, id, payload }.
 * Excluded (device-local): activeSession, onboarding, seed bookkeeping, backup bookkeeping in settings,
 * backup_restore import-log entries, and anything belonging to a pending import.
 */
export function extractEntities(store) {
  const out = new Map();
  const pend = pendingImportIds(store);
  const put = (type, id, payload) => out.set(entityKey(type, id), { type, id, payload });
  put('settings', 'main', { loadUnit: store.settings.loadUnit, bodyweight: store.settings.bodyweight });
  for (const e of store.meta.importLog) if (SYNCED_IMPORT_KINDS.has(e.kind) && e.status !== 'pending') put('import', e.importId, e);
  for (const [type, k] of Object.entries(ARRAY_OF)) {
    for (const x of store[k]) {
      if ((type === 'session' || type === 'quarantine') && pend.has(x.provenance?.importId ?? x.importId)) continue;
      put(type, x.id, x);
    }
  }
  return out;
}

function nextOp(sync, type, id, entity, at, newOpId) {
  sync.opCounter += 1;
  return { opId: newOpId(), n: sync.opCounter, type, id, deleted: entity === null, payload: entity === null ? null : structuredClone(entity.payload), at };
}

/**
 * Stamps outbox ops for every synchronized entity that differs between prev and next (the mutation
 * captured at write time). Called by the Store before validation, in the same write as the data.
 * No-op when next has no sync section or holds a pending import (that write is reconciled when the
 * import is verified, see reconcileOutbox).
 */
export function stampOutbox(prev, next, { now, newOpId }) {
  if (!isObj(next?.sync) || !isObj(prev) || hasPendingImport(next)) return next;
  const a = extractEntities(prev);
  const b = extractEntities(next);
  const at = now();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (x && y && JSON.stringify(x.payload) === JSON.stringify(y.payload)) continue;
    const ref = y ?? x;
    next.sync.outbox.push(nextOp(next.sync, ref.type, ref.id, y ?? null, at, newOpId));
  }
  return next;
}

/** The hash the server will have once the pending ops for a key are applied (or the known one). */
function effectiveHash(sync, key) {
  for (let i = sync.outbox.length - 1; i >= 0; i--) {
    const op = sync.outbox[i];
    if (entityKey(op.type, op.id) === key) return op.deleted ? 'deleted' : contentHash(op.payload);
  }
  const k = sync.known[key];
  if (!k) return 'absent';
  return k.d ? 'deleted' : k.h;
}

/** Full reconciliation: ops for every entity whose content differs from known/pending (used after import verification and seeding). */
export function reconcileOutbox(store, { now, newOpId }) {
  if (!isObj(store?.sync) || store.sync.state === 'reconcile' || hasPendingImport(store)) return store; // while reconciling, the join computes the ops
  const ents = extractEntities(store);
  const at = now();
  const keys = new Set([...ents.keys(), ...Object.keys(store.sync.known).filter((k) => !store.sync.known[k].d)]);
  for (const key of keys) {
    const e = ents.get(key) ?? null;
    const want = e ? contentHash(e.payload) : 'deleted';
    const have = effectiveHash(store.sync, key);
    if (want === have || (!e && have === 'absent')) continue;
    const [type, ...rest] = key.split(':');
    store.sync.outbox.push(nextOp(store.sync, type, rest.join(':'), e, at, newOpId));
  }
  return store;
}

/** A pristine store: nothing a user ever entered (safe to adopt the shared history as is). */
export function isPristine(store) {
  return store.meta.dataRevision === 1 && store.sessions.length === 0 && store.manualRecords.length === 0 && store.goals.length === 0
    && store.meta.importLog.length === 0 && store.activeSession === null && store.exercises.every((e) => !e.isCustom);
}

export function emptySyncSection({ deviceId, epoch, store, state = 'active' }) {
  return {
    v: SYNC_FORMAT, deviceId, epoch, state, appliedSeq: 0, opCounter: 0, outbox: [], known: {}, conflicts: [],
    seenRestores: (store.meta.importLog ?? []).filter((e) => e.kind === 'backup_restore').map((e) => e.restoreId),
  };
}

// ---- applying server changes -------------------------------------------------------------------

function currentEntity(store, type, id) {
  return extractEntities(store).get(entityKey(type, id)) ?? null;
}

/** Writes one server entity (or its deletion) into the store draft. Never touches activeSession. */
export function writeEntity(store, type, id, deleted, payload) {
  if (type === 'settings') {
    if (!deleted) {
      store.settings.loadUnit = payload.loadUnit;
      store.settings.bodyweight = structuredClone(payload.bodyweight);
    }
    return;
  }
  const list = type === 'import' ? store.meta.importLog : store[ARRAY_OF[type]];
  if (!list) throw new Error(`unknown entity type ${type}`);
  const idField = type === 'import' ? 'importId' : 'id';
  const i = list.findIndex((x) => x[idField] === id);
  if (deleted) {
    if (i >= 0) list.splice(i, 1);
  } else if (i >= 0) list[i] = structuredClone(payload);
  else list.push(structuredClone(payload));
}

function addConflict(sync, { type, id, reason, local, serverVersion, at, newOpId }) {
  sync.conflicts.push({ cid: newOpId(), type, id, at, reason, deleted: local === null, payload: local === null ? null : structuredClone(local.payload), serverVersion });
}

/**
 * Applies one pull page in a store draft. Returns { dataChanged }.
 * - own op echoed back (opId match) → acknowledge it, content already local;
 * - entity with local pending ops → equal content: adopt silently; otherwise the local version is
 *   preserved as a conflict artifact and the server version becomes the local one (no silent overwrite
 *   of either side: the artifact is reviewable);
 * - otherwise → apply.
 * The downstream checkpoint advances in the same write (same key) as the applied data.
 */
export function applyPullPage(store, changes, { now, newOpId }) {
  const sync = store.sync;
  let dataChanged = false;
  const at = now();
  for (const c of changes) {
    const key = entityKey(c.type, c.id);
    const remoteHash = c.deleted ? 'deleted' : contentHash(c.payload);
    const own = sync.outbox.findIndex((op) => op.opId === c.opId);
    if (own < 0 && (sync.known[key]?.v ?? 0) >= c.version) {
      // Already known (our own op, acknowledged by a push response before this pull): nothing to apply.
    } else if (own >= 0) {
      sync.outbox.splice(own, 1);
      sync.known[key] = { v: c.version, h: remoteHash, d: c.deleted };
    } else {
      const pending = sync.outbox.filter((op) => entityKey(op.type, op.id) === key);
      if (pending.length) {
        const local = currentEntity(store, c.type, c.id);
        const localHash = local ? contentHash(local.payload) : 'deleted';
        if (localHash !== remoteHash) addConflict(sync, { type: c.type, id: c.id, reason: 'remote_changed', local, serverVersion: c.version, at, newOpId });
        sync.outbox = sync.outbox.filter((op) => entityKey(op.type, op.id) !== key);
      }
      const before = currentEntity(store, c.type, c.id);
      if ((before ? contentHash(before.payload) : 'deleted') !== remoteHash) {
        writeEntity(store, c.type, c.id, c.deleted, c.payload);
        dataChanged = true;
      }
      sync.known[key] = { v: c.version, h: remoteHash, d: c.deleted };
    }
    if (c.seq > sync.appliedSeq) sync.appliedSeq = c.seq;
  }
  return { dataChanged };
}

/** The ops to send now: the oldest op of each entity, with its base version from `known`. */
export function opsToSend(sync, max) {
  const seen = new Set();
  const out = [];
  for (const op of sync.outbox) {
    const key = entityKey(op.type, op.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ opId: op.opId, type: op.type, id: op.id, base: sync.known[key]?.v ?? 0, deleted: op.deleted, payload: op.payload });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Applies push results in a store draft. applied/duplicate → acknowledged (removed by opId, newer ops
 * stay); conflict → the local version is preserved as an artifact, the entity's pending ops are
 * dropped, and the next pull brings the server version (its seq is always above appliedSeq).
 * Returns { dataChanged: false } (pushing never changes local data).
 */
export function applyPushResults(store, results, { now, newOpId }) {
  const sync = store.sync;
  const at = now();
  for (const r of results) {
    const i = sync.outbox.findIndex((op) => op.opId === r.opId);
    if (i < 0) continue;
    const op = sync.outbox[i];
    const key = entityKey(op.type, op.id);
    if (r.status === 'applied' || r.status === 'duplicate') {
      sync.outbox.splice(i, 1);
      sync.known[key] = { v: r.version, h: op.deleted ? 'deleted' : contentHash(op.payload), d: op.deleted };
    } else if (r.status === 'conflict') {
      const local = currentEntity(store, op.type, op.id);
      const localHash = local ? contentHash(local.payload) : 'deleted';
      const serverHash = r.current?.deleted ? 'deleted' : r.current ? contentHash(r.current.payload) : 'absent';
      if (localHash !== serverHash) addConflict(sync, { type: op.type, id: op.id, reason: 'stale_write', local, serverVersion: r.current?.version ?? null, at, newOpId });
      sync.outbox = sync.outbox.filter((x) => entityKey(x.type, x.id) !== key);
    }
  }
  return { dataChanged: false };
}

/** A backup was restored locally since sync was enabled → reconciliation required before any push. */
export function needsReconcile(store) {
  const s = store.sync;
  if (!isObj(s)) return false;
  if (s.state === 'reconcile') return true;
  return store.meta.importLog.some((e) => e.kind === 'backup_restore' && !s.seenRestores.includes(e.restoreId));
}

// ---- joining a shared history (first sync, after a restore, or after a server replacement) ------------

const TIMESTAMPS = new Set(['createdAt', 'updatedAt']);
/** Content that matters for "is this the same record": timestamps of the same logical record do not. */
export function comparable(type, payload) {
  if (!isObj(payload) || type === 'import' || type === 'settings') return payload;
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !TIMESTAMPS.has(k)));
}
const comparableHash = (type, payload) => (payload === null ? 'deleted' : contentHash(comparable(type, payload)));

/**
 * Reconciles this device's data with the server's complete current state (a Map of key → { type, id,
 * version, deleted, payload }) in a store draft. Nothing is dropped silently:
 * - only on the server → adopted locally (a deletion → nothing to adopt, just remembered);
 * - only local → queued as a new entity (base 0) for the server;
 * - both, same content (timestamps aside) → the server version is adopted, nothing is queued;
 * - both, different → the server version becomes the shared one and this device's version is kept as a
 *   reviewable conflict artifact ('join_differs'); a pristine device adopts the server without artifacts;
 * - deleted on the server but present here → the deletion is applied and the local version is kept as a
 *   conflict artifact ('deleted_remotely'), so nothing a stale device holds is resurrected or lost.
 * Also: two sessions with the same Garmin fingerprint under different ids are flagged 'possible_duplicate'
 * (both kept). Finishes by acknowledging every restore, adopting the epoch and moving to `active`.
 */
export function joinReconcile(store, server, { now, newOpId }) {
  const sync = store.sync;
  const pristine = isPristine(store);
  const at = now();
  const local = extractEntities(store);
  const summary = { adopted: 0, pushed: 0, same: 0, conflicts: 0, deletedHere: 0 };
  const order = (k) => ENTITY_TYPES.indexOf(k.split(':')[0]);
  const keys = [...new Set([...server.entities.keys(), ...local.keys()])].sort((a, b) => order(a) - order(b));
  let dataChanged = false;
  sync.outbox = [];
  sync.known = {};
  for (const key of keys) {
    const s = server.entities.get(key) ?? null;
    const l = local.get(key) ?? null;
    if (s && !s.deleted) {
      if (!l) { writeEntity(store, s.type, s.id, false, s.payload); dataChanged = true; summary.adopted += 1; }
      else if (comparableHash(s.type, s.payload) === comparableHash(l.type, l.payload)) {
        summary.same += 1;
        if (contentHash(s.payload) !== contentHash(l.payload)) { writeEntity(store, s.type, s.id, false, s.payload); dataChanged = true; }
      } else {
        if (!pristine) { addConflict(sync, { type: s.type, id: s.id, reason: 'join_differs', local: l, serverVersion: s.version, at, newOpId }); summary.conflicts += 1; }
        writeEntity(store, s.type, s.id, false, s.payload);
        dataChanged = true;
      }
      sync.known[key] = { v: s.version, h: contentHash(s.payload), d: false };
    } else if (s && s.deleted) {
      if (l) {
        if (!pristine) { addConflict(sync, { type: s.type, id: s.id, reason: 'deleted_remotely', local: l, serverVersion: s.version, at, newOpId }); summary.conflicts += 1; }
        if (s.type !== 'settings') { writeEntity(store, s.type, s.id, true, null); dataChanged = true; summary.deletedHere += 1; }
      }
      sync.known[key] = { v: s.version, h: 'deleted', d: true };
    } else if (l) {
      store.sync.outbox.push(nextOp(sync, l.type, l.id, l, at, newOpId));
      summary.pushed += 1;
    }
  }
  // Same Garmin activity under two ids: keep both, flag for review.
  const byFp = new Map();
  for (const x of store.sessions) {
    const fp = x.provenance?.fingerprint;
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(x);
  }
  for (const list of byFp.values()) {
    if (list.length < 2) continue;
    for (const x of list.slice(1)) {
      if (!sync.conflicts.some((c) => c.type === 'session' && c.id === x.id && c.reason === 'possible_duplicate')) {
        addConflict(sync, { type: 'session', id: x.id, reason: 'possible_duplicate', local: { type: 'session', id: x.id, payload: x }, serverVersion: sync.known[entityKey('session', x.id)]?.v ?? null, at, newOpId });
        summary.conflicts += 1;
      }
    }
  }
  sync.epoch = server.epoch;
  sync.appliedSeq = server.maxSeq;
  sync.state = 'active';
  sync.seenRestores = store.meta.importLog.filter((e) => e.kind === 'backup_restore').map((e) => e.restoreId);
  return { dataChanged, summary };
}

/** Removes a conflict artifact. Returns it (or null). The caller applies "use mine" as an ordinary data write. */
export function takeConflict(store, cid) {
  const i = store.sync.conflicts.findIndex((c) => c.cid === cid);
  return i < 0 ? null : store.sync.conflicts.splice(i, 1)[0];
}

// ---- shape validation (called by validateStore when `sync` is present) --------------------------

export function syncSectionProblems(s) {
  const p = [];
  const req = ['v', 'deviceId', 'epoch', 'state', 'appliedSeq', 'opCounter', 'outbox', 'known', 'conflicts', 'seenRestores'];
  if (!isObj(s)) return ['must be an object'];
  for (const k of req) if (!(k in s)) p.push(`${k}: required`);
  for (const k of Object.keys(s)) if (!req.includes(k)) p.push(`${k}: unknown field`);
  if (p.length) return p;
  const int0 = (v) => Number.isSafeInteger(v) && v >= 0;
  const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
  if (s.v !== SYNC_FORMAT) p.push('v: unsupported');
  if (!str(s.deviceId)) p.push('deviceId: invalid');
  if (!str(s.epoch)) p.push('epoch: invalid');
  if (!['active', 'reconcile'].includes(s.state)) p.push('state: invalid');
  if (!int0(s.appliedSeq)) p.push('appliedSeq: invalid');
  if (!int0(s.opCounter)) p.push('opCounter: invalid');
  const opKeys = ['opId', 'n', 'type', 'id', 'deleted', 'payload', 'at'];
  if (!Array.isArray(s.outbox)) p.push('outbox: must be an array');
  else {
    const ids = new Set();
    let last = 0;
    s.outbox.forEach((op, i) => {
      if (!isObj(op) || Object.keys(op).length !== opKeys.length || !opKeys.every((k) => k in op)) return p.push(`outbox[${i}]: invalid shape`);
      if (!str(op.opId) || ids.has(op.opId)) p.push(`outbox[${i}].opId: invalid or duplicate`);
      ids.add(op.opId);
      if (!int0(op.n) || op.n <= last || op.n > s.opCounter) p.push(`outbox[${i}].n: must increase and be ≤ opCounter`);
      last = op.n;
      if (!ENTITY_TYPES.includes(op.type) || !str(op.id)) p.push(`outbox[${i}]: invalid entity`);
      if (typeof op.deleted !== 'boolean' || (op.deleted ? op.payload !== null : !isObj(op.payload))) p.push(`outbox[${i}]: payload must be an object, or null when deleted`);
    });
  }
  if (!isObj(s.known)) p.push('known: must be an object');
  else for (const [k, x] of Object.entries(s.known)) {
    if (!ENTITY_TYPES.includes(k.split(':')[0]) || !isObj(x) || !(Number.isSafeInteger(x.v) && x.v >= 1) || typeof x.h !== 'string' || typeof x.d !== 'boolean' || Object.keys(x).length !== 3) p.push(`known.${k}: invalid`);
  }
  if (!Array.isArray(s.conflicts)) p.push('conflicts: must be an array');
  else s.conflicts.forEach((c, i) => {
    const ck = ['cid', 'type', 'id', 'at', 'reason', 'deleted', 'payload', 'serverVersion'];
    if (!isObj(c) || Object.keys(c).length !== ck.length || !ck.every((k) => k in c) || !ENTITY_TYPES.includes(c.type)) p.push(`conflicts[${i}]: invalid`);
  });
  if (!Array.isArray(s.seenRestores) || s.seenRestores.some((x) => !str(x))) p.push('seenRestores: invalid');
  return p;
}
