// GymLog sync engine: one single-flight loop that joins the shared history once, then pushes the outbox
// and pulls server changes. All data changes go through Store.applySync (atomic, validated, never touches
// the active workout). The transport is injected (HTTP in the browser, handleSync in tests):
//   transport.status() | export() | pull(since, limit) | push({deviceId, epoch, ops})
//   → { ok:true, body } | { ok:false, kind:'network'|'auth'|'epoch'|'server', code? }
import { takeConflict, emptySyncSection, joinReconcile, applyPullPage, applyPushResults, opsToSend, needsReconcile, ENTITY_TYPES, entityKey } from './local.js';

const PUSH_BATCH = 50;
const PULL_LIMIT = 200;
const MAX_ROUNDS = 6;

export function createSyncEngine({ port, transport, config, now = () => new Date().toISOString(), newOpId, newDeviceId, onChange = () => {} }) {
  let running = null;
  let rerun = false;
  const st = { phase: 'off', lastSyncAt: null, lastError: null, pending: 0, conflicts: 0, joined: null };
  const set = (patch) => { Object.assign(st, patch); onChange({ ...st }); };

  const read = () => port.read();
  const refreshCounts = (store) => {
    const s = store?.sync;
    if (s) { st.pending = s.outbox.length; st.conflicts = s.conflicts.length; }
  };

  async function write(fn) {
    const r = await port.applySync(fn);
    return r;
  }
  const ctx = () => ({ now, newOpId });
  const fail = (code, kind = 'error') => { set({ phase: kind, lastError: code }); return { ok: false, code }; };

  async function join() {
    const t = await transport.export();
    if (!t.ok) return t;
    const server = { epoch: t.body.epoch, maxSeq: t.body.maxSeq, entities: new Map(t.body.entities.map((e) => [entityKey(e.type, e.id), e])) };
    let summary = null;
    const r = await write((draft) => { const j = joinReconcile(draft, server, ctx()); summary = j.summary; return { dataChanged: j.dataChanged }; });
    if (!r.ok) return { ok: false, kind: 'local', code: r.code, details: r.errors ?? r.details };
    st.joined = summary;
    return { ok: true };
  }

  async function pullAll(sync) {
    const changes = [];
    let since = sync.appliedSeq;
    let epoch = sync.epoch;
    for (let i = 0; i < 1000; i++) {
      const t = await transport.pull(since, PULL_LIMIT);
      if (!t.ok) return t;
      epoch = t.body.epoch;
      if (epoch !== sync.epoch) return { ok: false, kind: 'epoch' };
      changes.push(...t.body.changes);
      if (t.body.changes.length) since = t.body.changes[t.body.changes.length - 1].seq;
      if (!t.body.more) break;
    }
    return { ok: true, changes };
  }

  async function round() {
    let snap = read();
    if (!snap.ok) return fail('STORE_UNAVAILABLE', 'blocked');
    if (snap.unsaved || snap.stale) return fail('STORE_UNSAVED', 'blocked');
    let sync = snap.store.sync;
    // 1. pull
    const p = await pullAll(sync);
    if (!p.ok) return p;
    let applied = 0;
    if (p.changes.length) {
      const ordered = p.changes.map((c, i) => [c, i]).sort((a, b) => ENTITY_TYPES.indexOf(a[0].type) - ENTITY_TYPES.indexOf(b[0].type) || a[1] - b[1]).map((x) => x[0]);
      const r = await write((draft) => {
        const res = applyPullPage(draft, ordered, ctx());
        for (const c of p.changes) if (c.seq > draft.sync.appliedSeq) draft.sync.appliedSeq = c.seq;
        return res;
      });
      if (!r.ok) return { ok: false, kind: 'local', code: r.code, details: r.errors ?? r.details };
      applied = p.changes.length;
    }
    // 2. push
    snap = read();
    sync = snap.store.sync;
    const ops = opsToSend(sync, PUSH_BATCH);
    if (ops.length) {
      const t = await transport.push({ deviceId: sync.deviceId, epoch: sync.epoch, ops });
      if (!t.ok) return t;
      const r = await write((draft) => applyPushResults(draft, t.body.results, ctx()));
      if (!r.ok) return { ok: false, kind: 'local', code: r.code, details: r.errors ?? r.details };
    }
    refreshCounts(read().store);
    return { ok: true, more: ops.length >= PUSH_BATCH || applied > 0 || ops.length > 0 };
  }

  async function run() {
    const cfg = config.get();
    if (!cfg?.token) { set({ phase: 'off' }); return { ok: true, off: true }; }
    set({ phase: 'syncing', lastError: null });
    let snap = read();
    if (!snap.ok) return fail('STORE_UNAVAILABLE', 'blocked');
    if (!snap.store.sync) {
      const deviceId = cfg.deviceId ?? newDeviceId();
      if (!cfg.deviceId) config.set({ ...cfg, deviceId });
      const r = await port.enableSync(emptySyncSection({ deviceId, epoch: 'unjoined', store: snap.store, state: 'reconcile' }));
      if (!r.ok) { st.details = r.errors ?? r.details; return fail(r.code ?? 'ENABLE_FAILED', 'blocked'); }
    }
    for (let i = 0; i < MAX_ROUNDS; i++) {
      snap = read();
      if (!snap.ok) return fail('STORE_UNAVAILABLE', 'blocked');
      if (needsReconcile(snap.store)) {
        set({ phase: 'reconcile' });
        const j = await join();
        if (!j.ok) return handle(j);
        set({ phase: 'syncing' });
      }
      const r = await round();
      if (!r.ok) {
        if (r.kind === 'epoch') { // another history now lives on the server: reconcile again, never push blindly
          const w = await write((d) => { d.sync.state = 'reconcile'; return { dataChanged: false }; });
          if (!w.ok) return handle({ ok: false, kind: 'local', code: w.code });
          continue;
        }
        return handle(r);
      }
      if (!r.more) break;
    }
    const final = read();
    refreshCounts(final.store);
    set({ phase: 'idle', lastSyncAt: now(), lastError: null });
    return { ok: true };
  }

  function handle(r) {
    if (r.kind === 'network') return fail('OFFLINE', 'offline');
    if (r.kind === 'auth') return fail('AUTH', 'error');
    if (r.details) st.details = r.details;
    return fail(r.code ?? r.kind ?? 'ERROR', 'error');
  }

  /** Single-flight: a request during a run schedules exactly one more run. */
  function sync() {
    if (running) { rerun = true; return running; }
    running = (async () => {
      let out;
      try {
        do { rerun = false; out = await run(); } while (rerun && out.ok);
      } catch (e) {
        out = fail(`UNEXPECTED:${e?.message ?? e}`, 'error');
      } finally { running = null; }
      return out;
    })();
    return running;
  }

  async function dismissConflict(cid) {
    const r = await write((draft) => { takeConflict(draft, cid); return { dataChanged: false }; });
    refreshCounts(read().store);
    onChange({ ...st });
    return r;
  }

  return { sync, dismissConflict, getStatus: () => ({ ...st }), refresh: () => { const s = read(); if (s.ok) refreshCounts(s.store); onChange({ ...st }); } };
}

/** HTTP transport over fetch. Network failures and aborted requests are reported as kind 'network'. */
export function createHttpTransport({ fetchFn = (...a) => fetch(...a), base = '', getToken, timeoutMs = 20000 }) {
  async function call(method, path, body) {
    let res;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      res = await fetchFn(base + path, { method, headers: { authorization: `Bearer ${getToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ctl?.signal });
    } catch { return { ok: false, kind: 'network' }; } finally { if (timer) clearTimeout(timer); }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth' };
    if (res.status === 409 && json?.error === 'EPOCH_MISMATCH') return { ok: false, kind: 'epoch' };
    if (!res.ok || !json) return { ok: false, kind: res.status >= 500 ? 'network' : 'server', code: json?.error ?? `HTTP_${res.status}` };
    return { ok: true, body: json };
  }
  return {
    status: () => call('GET', '/api/sync/status'),
    export: () => call('GET', '/api/sync/export'),
    pull: (since, limit) => call('GET', `/api/sync/pull?since=${since}&limit=${limit}`),
    push: (b) => call('POST', '/api/sync/push', b),
  };
}
