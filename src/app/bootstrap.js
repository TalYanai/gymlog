// Application bootstrap, central write gate and workflows (Step 2c.5–2c.8; plan revisions 5–9).
//
// This is the ONLY module that creates the Store and the side-keys module (static test GATE-S1).
// Their handles never leave this closure: UI code receives only the frozen `app` facade, and every
// value it returns is a detached, deep-frozen copy of plain data (R6-1, R7-3).
//
// Gate states: inspectionFailed | absent | cleanupPending | recovery | verificationIncomplete | open | busy.
// - The gate is derived ONLY from an inspection of what is stored (settle(), R7-1): two complete
//   snapshots that agree, at most three attempts (R9-3). A failed read anywhere → inspectionFailed.
// - Normal writes (commit, retrySave, bookkeeping) are allowed only in `open`, checked when called and
//   again when their queued operation starts.
// - Multi-step workflows acquire the gate synchronously before their first await (R6-3); a competing
//   workflow gets WRITES_BUSY. Whatever happens, the wrapper ends with settle(), which writes nothing.
// - Automatic verification, cleanup and rebuild run only at launch and on explicit retry actions.
// - Exports never present an unsaved workflow candidate as stored data: v2 exports are unavailable
//   while busy (R9-2); legacy and previous-copy exports read storage at the time of the call.
// - The gate is per window and held in memory. Between windows the protection is the Store's
//   external-change check plus the side-key checks; neither is atomic (documented race, SKX10).

import { createStore } from '../store/store.js';
import { createSideKeys, INPUT_DRAFT_MAX_CHARS } from '../store/side-keys.js';
import { applySeeds } from '../store/seeding.js';
import { createEmptyStore } from '../schema/factories.js';
import { canonicalize, canonicalSha256, sha256Hex } from '../schema/canonical.js';
import { MIGRATION_RULES_VERSION } from '../schema/constants.js';
import { decodeSource } from '../import/source-bytes.js';
import { buildFirstMigration, planLateImport as planLate, buildLateImport } from '../import/v1-import.js';
import { parsePersonalSeed, defaultPersonalDecisions, checkPersonalItems, buildPersonalSeed } from '../import/personal-seed.js';
import { analyzeGarminCsv, buildGarminImport, defaultDecisions, missingDecisions, storedRowsOf } from '../import/garmin-csv.js';
import { createBackup as buildBackup, parseBackup, verifyExportFile, referencedLegacy } from '../backup/backup.js';
import { buildRestoredStore } from '../backup/restore.js';
import { draftProblem } from '../core/input-draft.js';

const MAX_ATTEMPTS = 3;
const V1_KINDS = ['v1_migration', 'v1_late_import'];

// ---- detached, deep-frozen plain data --------------------------------------------------------
function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}
const out = (v) => deepFreeze(structuredClone(v));
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/**
 * @param {object} deps
 * @param {Storage} [deps.backend]  TESTS ONLY (GATE-S4). Production calls omit it; storage.js resolves the browser storage.
 * @param {() => string} deps.now
 * @param {(prefix:string) => string} deps.newId
 * @param {object} deps.seedDoc
 * @param {string} deps.appVersion
 * @returns {Promise<{state: object, app: object}>}
 */
export async function bootstrap({ backend, now, newId, seedDoc, appVersion } = {}) {
  if (typeof now !== 'function' || typeof newId !== 'function' || !seedDoc || typeof appVersion !== 'string') {
    throw new TypeError('bootstrap requires { now, newId, seedDoc, appVersion }');
  }
  const store = createStore({ backend, now });
  const sideKeys = createSideKeys({ backend });
  const seedSha256 = await canonicalSha256(seedDoc);

  let gate = { gate: 'inspectionFailed', failedReads: ['v2'], reason: 'not_inspected', externalChange: null, orphanLegacy: [], prevCopy: null, pendingImport: null };
  let busy = null; // workflow name while a workflow holds the gate
  let known = null; // last stable snapshot {v2, proof, prevCopy, legacyList}
  const listeners = new Set();
  const plans = new Map();
  let planSeq = 0;
  let rawExported = false;

  const currentGate = () => (busy ? 'busy' : gate.gate);
  /** A new ID that is not already used by any import-log entry (importId / restoreId) of `data`. */
  function freshId(prefix, data) {
    const taken = new Set((data?.meta?.importLog ?? []).flatMap((e) => [e.importId, e.restoreId]));
    for (let i = 0; i < 8; i++) {
      const id = newId(prefix);
      if (!taken.has(id)) return id;
    }
    throw new Error(`could not draw an unused ${prefix} id`);
  }
  function setGate(payload) {
    gate = payload;
    const snapshot = out({ ...gate, gate: currentGate() });
    for (const cb of listeners) {
      try {
        cb(snapshot);
      } catch {
        // a listener error never affects the gate
      }
    }
    notifyChange();
  }

  // ---- change notification (Step 2d.0) ------------------------------------------------------------
  // Called only AFTER an operation has finished (never inside the write path), on a microtask.
  // Each listener is isolated: an exception is reported and cannot affect writes or other listeners.
  const changeListeners = new Set();
  function notifyChange() {
    if (changeListeners.size === 0) return;
    queueMicrotask(() => {
      const payload = Object.freeze({ seq: store.getState().seq, gate: currentGate() });
      for (const cb of [...changeListeners]) {
        try {
          cb(payload);
        } catch (err) {
          console.error('GymLog onChange listener failed', err);
        }
      }
    });
  }

  // ---- inspection --------------------------------------------------------------------------------
  /** Synchronous fingerprint of the in-memory v2 state (canonical text, so formatting is ignored). */
  function v2Fingerprint() {
    const st = store.getState();
    if (st.status === 'absent') return 'absent';
    if (st.status === 'invalid') return `invalid:${store.rawForExport().raw}`;
    if (st.status === 'ok') return `ok:${canonicalize(store.exportCurrentState().store)}`;
    return null;
  }

  /** One complete snapshot: v2 (through reload, which only reads), proof, previous copy, legacy list. */
  async function readSnapshot() {
    const failedReads = [];
    await store.reload({ discardUnsaved: true });
    if (store.getState().status === 'unavailable') failedReads.push('v2');
    const proof = await sideKeys.getProof();
    if (!proof.ok) failedReads.push('proof');
    const prev = await sideKeys.getPrevCopy();
    if (!prev.ok) failedReads.push('prevCopy');
    const legacy = sideKeys.listLegacy();
    if (!legacy.ok) failedReads.push('legacyList');
    if (failedReads.length) return { failedReads };
    return {
      failedReads,
      keys: { v2: v2Fingerprint(), proof: proof.present ? proof.raw : null, prevCopy: prev.present ? prev.raw : null, legacyList: legacy.sha256s.join(',') },
      proof,
      prev,
      legacy: legacy.sha256s,
      stale: store.getState().stale,
    };
  }
  const sameKeys = (a, b) => ['v2', 'proof', 'prevCopy', 'legacyList'].every((k) => a[k] === b[k]);

  /** Up to three complete snapshot pairs; a failed read ends the inspection at once (R9-3). */
  async function stableSnapshot() {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const a = await readSnapshot();
      if (a.failedReads.length) return { failedReads: a.failedReads };
      const b = await readSnapshot();
      if (b.failedReads.length) return { failedReads: b.failedReads };
      if (sameKeys(a.keys, b.keys) && !b.stale) return { snap: b };
    }
    return { unstable: true };
  }

  async function legacyStatus(sha) {
    const r = await sideKeys.getLegacy(sha);
    if (!r.ok) return 'unreadable';
    if (!r.present) return 'missing';
    return r.hashValid ? 'ok' : 'hash_mismatch';
  }

  /** Maps a stable snapshot to the gate table (Revision 7 C1, extended by revisions 8–9). */
  async function derive(snap) {
    const st = store.getState();
    const payload = { gate: 'open', failedReads: [], reason: null, externalChange: null, orphanLegacy: [], prevCopy: null, pendingImport: null, proof: snap.proof.present ? { valid: snap.proof.valid, importId: snap.proof.proof?.importId ?? null } : null };
    const mem = st.status === 'ok' ? store.exportCurrentState().store : null;
    const referenced = new Set(mem ? referencedLegacy(mem).map((r) => r.sha256) : []);
    if (st.status !== 'invalid') {
      for (const sha of snap.legacy) {
        if (referenced.has(sha)) continue;
        const r = await sideKeys.getLegacy(sha);
        payload.orphanLegacy.push({ sha256: sha, sizeChars: r.ok && r.present ? r.raw.length : null });
      }
    }
    if (snap.prev.present) {
      const c = snap.prev.copy;
      const log = mem ? mem.meta.importLog : [];
      // A copy matches when the restore it protects exists, or a revert brought its data back.
      const matches = !!c && log.some((e) => (c.kind === 'restore' ? e.restoreId === c.id || (c.dataSha256 !== null && e.kind === 'backup_restore' && e.backupDataSha256 === c.dataSha256) : e.importId === c.id));
      payload.prevCopy = { valid: snap.prev.valid, kind: c?.kind ?? null, id: c?.id ?? null, capturedAt: c?.capturedAt ?? null, rawSha256: c?.rawSha256 ?? null, matchesImport: matches, notice: c?.kind === 'restore' && !matches ? 'restore_not_performed' : 'previous_copy' };
    }
    if (st.status === 'absent') payload.gate = snap.proof.present ? 'cleanupPending' : 'absent';
    else if (st.status === 'invalid') payload.gate = 'recovery';
    else {
      const pend = mem.meta.importLog.find((e) => e.status === 'pending');
      if (pend) {
        payload.gate = 'verificationIncomplete';
        payload.pendingImport = { importId: pend.importId, kind: pend.kind, sourceSha256: pend.sourceSha256, source: V1_KINDS.includes(pend.kind) ? await legacyStatus(pend.sourceSha256) : null };
      } else payload.gate = snap.proof.present ? 'cleanupPending' : 'open';
    }
    return payload;
  }

  /**
   * Inspects storage and derives the gate. Writes nothing (SG4/SG14). `expected` is the workflow's
   * view of every key; any difference is reported as externalChange { keys }.
   */
  async function settle(expected = null) {
    const r = await stableSnapshot();
    let payload;
    if (r.failedReads) payload = { ...gate, gate: 'inspectionFailed', failedReads: r.failedReads, reason: 'failedReads', externalChange: null };
    else if (r.unstable) payload = { ...gate, gate: 'inspectionFailed', failedReads: [], reason: 'unstable', externalChange: null };
    else {
      payload = await derive(r.snap);
      if (expected) {
        const keys = ['v2', 'proof', 'prevCopy', 'legacyList'].filter((k) => expected[k] !== undefined && expected[k] !== r.snap.keys[k]);
        payload.externalChange = keys.length ? { keys } : null;
      }
      known = { ...r.snap.keys };
    }
    setGate(payload);
    return payload;
  }

  // ---- automatic recovery (launch and explicit retry actions only) -----------------------------

  /** M7: deletes the proof only if the stored v2 has a verified entry for its importId, or no v2 exists. */
  async function cleanupProof(exp) {
    const p = await sideKeys.getProof();
    if (!p.ok) return p;
    if (!p.present) return { ok: true };
    const st = store.getState();
    const mem = st.status === 'ok' ? store.exportCurrentState().store : null;
    let allowed = st.status === 'absent';
    if (mem && !mem.meta.importLog.some((e) => e.status === 'pending')) {
      allowed = p.valid ? mem.meta.importLog.some((e) => e.importId === p.proof.importId && e.status === 'verified') : true; // a corrupt proof can support nothing
    }
    if (!allowed) return fail('NOT_REBUILDABLE', { stage: 'cleanup' });
    const d = sideKeys.deleteProof(p.raw);
    if (d.ok && exp) exp.proof = null;
    return d;
  }

  async function reproduce(entry, params) {
    const legacy = await sideKeys.getLegacy(entry.sourceSha256);
    if (!legacy.ok || !legacy.present || !legacy.hashValid) return { ok: false, code: 'SOURCE_MISMATCH' };
    if (params.seedSha256 !== seedSha256) return { ok: false, code: 'SEED_MISMATCH' };
    return buildFirstMigration({ text: legacy.raw, importId: entry.importId, importedAt: params.importedAt, appVersion: params.appVersion, seedDoc });
  }

  /** Verifies one pending import (M5/M6, R6, late import), then cleans up its proof. */
  async function verifyPending(entry, exp) {
    const proof = await sideKeys.getProof();
    if (!proof.ok) return proof;
    if (V1_KINDS.includes(entry.kind) && (await legacyStatus(entry.sourceSha256)) !== 'ok') return fail('SOURCE_MISMATCH');
    let expectedCandidateSha256;
    if (entry.kind === 'v1_migration') {
      const storedHash = await canonicalSha256(store.exportCurrentState().store);
      const p = proof.present && proof.valid && proof.proof.importId === entry.importId ? proof.proof : null;
      if (p && storedHash === p.candidateSha256) expectedCandidateSha256 = p.candidateSha256;
      else if (p) {
        // Stored candidate differs from the proof: rebuild only if the exact reproduction matches.
        const rep = await reproduce(entry, p.params);
        if (!rep.ok || rep.candidateSha256 !== p.candidateSha256) return fail('CANDIDATE_MISMATCH');
        const raw = JSON.stringify(store.exportCurrentState().store);
        const prev = await sideKeys.putPrevCopy({ kind: 'migration_rebuild', id: entry.importId, capturedAt: now(), dataSha256: storedHash, raw });
        if (!prev.ok) return prev;
        if (exp) exp.prevCopy = prev.raw;
        const conf = sideKeys.confirmPrevCopy(prev.raw);
        if (!conf.ok) return conf;
        const st = store.getState();
        const rb = await store.rebuildPendingMigration(rep.candidate, { proof: p, expected: { revision: st.revision, rawSha256: await sha256Hex(raw) } });
        if (!rb.ok) return rb;
        if (exp) exp.v2 = v2Fingerprint();
        expectedCandidateSha256 = p.candidateSha256;
      } else {
        // No proof (R5-1): reproduce from the entry's own parameters; equal → verified with that hash.
        const rep = await reproduce(entry, { importedAt: entry.at, appVersion: entry.reproduction.appVersion, seedSha256: entry.reproduction.seedSha256 });
        if (!rep.ok) return rep;
        if (rep.candidateSha256 !== storedHash) return fail('CANDIDATE_MISMATCH');
        expectedCandidateSha256 = storedHash;
      }
    }
    const v = await store.markImportVerified(entry.importId, expectedCandidateSha256 ? { expectedCandidateSha256 } : {});
    if (!v.ok) return v;
    if (exp) exp.v2 = v2Fingerprint();
    return cleanupProof(exp);
  }

  /** Automatic rebuild of an INVALID store from the proof (Revision 4 §2): every condition must hold. */
  async function rebuildInvalid(exp, { manual = false } = {}) {
    const p = await sideKeys.getProof();
    if (!p.ok) return p;
    if (!p.present || !p.valid) return fail('NOT_REBUILDABLE');
    const raw = store.rawForExport().raw;
    if (!manual) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return fail('NOT_REBUILDABLE', { reason: 'unparseable' });
      }
      const log = parsed?.meta?.importLog;
      const ok = Array.isArray(log) && log.length === 1 && log[0]?.kind === 'v1_migration' && log[0]?.status === 'pending' && log[0]?.importId === p.proof.importId && parsed?.meta?.dataRevision === 1;
      if (!ok) return fail('NOT_REBUILDABLE');
    }
    const entry = { importId: p.proof.importId, sourceSha256: p.proof.sourceSha256 };
    const rep = await reproduce(entry, p.proof.params);
    if (!rep.ok) return rep;
    if (rep.candidateSha256 !== p.proof.candidateSha256) return fail('CANDIDATE_MISMATCH');
    if (canonicalize(rep.candidate) === raw) return fail('NOT_REBUILDABLE', { reason: 'identical' }); // rules changed; a rebuild cannot help
    const prev = await sideKeys.putPrevCopy({ kind: 'migration_rebuild', id: entry.importId, capturedAt: now(), dataSha256: null, raw });
    if (!prev.ok) return prev;
    if (exp) exp.prevCopy = prev.raw;
    const conf = sideKeys.confirmPrevCopy(prev.raw);
    if (!conf.ok) return conf;
    const rb = await store.rebuildPendingMigration(rep.candidate, { proof: p.proof, expected: { invalidSha256: await sha256Hex(raw) } });
    if (!rb.ok) return rb;
    if (exp) exp.v2 = v2Fingerprint();
    const v = await store.markImportVerified(entry.importId, { expectedCandidateSha256: p.proof.candidateSha256 });
    if (!v.ok) return v;
    if (exp) exp.v2 = v2Fingerprint();
    return cleanupProof(exp);
  }

  /** The startup table's automatic steps (Revision 4 §2, 5 A1). Stops at the first failure. */
  async function autoRecover(exp = null) {
    for (let guard = 0; guard < 4; guard++) {
      const st = store.getState();
      if (st.unsaved || st.stale) return fail(st.unsaved ? 'UNSAVED_STATE' : 'EXTERNAL_CHANGE');
      if (st.status === 'absent') {
        const p = await sideKeys.getProof();
        if (p.ok && p.present) return cleanupProof(exp);
        return { ok: true };
      }
      if (st.status === 'invalid') return rebuildInvalid(exp);
      if (st.status !== 'ok') return fail('STORE_UNAVAILABLE');
      const mem = store.exportCurrentState().store;
      const pend = mem.meta.importLog.find((e) => e.status === 'pending');
      if (!pend) return cleanupProof(exp);
      const r = await verifyPending(pend, exp);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  // ---- workflow wrapper (R6-3, R7-1) -----------------------------------------------------------
  /**
   * Every multi-step write goes through here. The gate is acquired synchronously, before any await.
   * The body receives `exp`, the workflow's view of every key, which it updates after each of its
   * own confirmed writes; settle() reports anything else as externalChange.
   */
  function workflow(name, allowed, body, { requireSaved = true, precheck = null } = {}) {
    return function run(...args) {
      if (busy) return Promise.resolve(out(fail('WRITES_BUSY', { gate: 'busy' })));
      if (!allowed.includes(gate.gate)) return Promise.resolve(out(fail('WRITES_NOT_ALLOWED', { gate: gate.gate })));
      const st = store.getState();
      if (requireSaved && st.unsaved) return Promise.resolve(out(fail('UNSAVED_STATE', { gate: gate.gate })));
      if (requireSaved && st.stale) return Promise.resolve(out(fail('EXTERNAL_CHANGE', { gate: gate.gate })));
      let argsCopy;
      try {
        argsCopy = structuredClone(args); // inputs are copied at the call (ENC4)
      } catch {
        return Promise.resolve(out(fail('RESULT_INVALID', { errors: [{ code: 'INV-SHAPE', path: '$args', message: 'arguments must be plain data' }] })));
      }
      busy = name;
      return (async () => {
        // Normal writes admitted before the gate was taken finish first. If one left the store
        // unsaved or stale, the workflow is refused WITHOUT settle(), so that change is never discarded.
        await normalTail;
        const now2 = store.getState();
        const refusal = requireSaved && (now2.unsaved || now2.stale) ? fail(now2.unsaved ? 'UNSAVED_STATE' : 'EXTERNAL_CHANGE', { gate: gate.gate }) : precheck?.(...argsCopy) ?? null;
        if (refusal) {
          busy = null;
          setGate(gate);
          return out(refusal);
        }
        const exp = { ...(known ?? {}), v2: v2Fingerprint() };
        let result;
        try {
          result = await body(exp, ...argsCopy);
        } catch (err) {
          result = fail('WORKFLOW_FAILED', { message: String(err?.message ?? err) });
        }
        let payload;
        try {
          payload = await settle(exp);
        } catch (err) {
          payload = { ...gate, gate: 'inspectionFailed', failedReads: [], reason: 'settle_failed', externalChange: null };
          gate = payload;
        } finally {
          busy = null;
          setGate(gate);
        }
        return out({ ...result, gate: payload.gate, externalChange: payload.externalChange });
      })();
    };
  }

  /** Orphan legacy keys require an explicit acknowledgment before startFresh / restoreBackup (R8-2). */
  const orphanBlock = (opts) => (gate.orphanLegacy.length && opts?.acknowledgeOrphanLegacy !== true ? fail('ORPHAN_LEGACY_PRESENT', { orphanLegacy: gate.orphanLegacy }) : null);

  // ---- workflows ---------------------------------------------------------------------------------
  const startFresh = workflow('startFresh', ['absent'], async (exp, opts = {}) => {
    const blocked = orphanBlock(opts);
    if (blocked) return blocked;
    const at = now();
    const s = await applySeeds(createEmptyStore({ now: at, appVersion }), seedDoc, { now: at });
    if (!s.ok) return s;
    const r = await store.initialize(s.store);
    if (!r.ok) return r;
    exp.v2 = v2Fingerprint();
    return { ok: true };
  });

  // ---- first migration: read-only preview, then the confirmed write (Step 2d.1, G3) ----------------
  // planImportV1(bytes) builds the complete candidate (M1) and writes nothing. The plan is bound to
  // the exact source (sourceSha256 of the decoded text; decodeSource accepts only bytes that
  // re-encode to themselves, so the text and the bytes determine each other), to the candidate
  // (candidateSha256) and to the storage state it was made on (v2 absent, proof, previous copy,
  // legacy list). importV1(planId) consumes the plan on its first use, success or not, re-reads that
  // storage state before its first write, and writes exactly the previewed candidate through the
  // existing M2–M8 steps (validated initialize, verification, proof cleanup).

  /** The storage state a first-migration plan depends on (reads only). */
  async function firstMigrationKeys() {
    const proof = await sideKeys.getProof();
    if (!proof.ok) return proof;
    const prev = await sideKeys.getPrevCopy();
    if (!prev.ok) return prev;
    const legacy = sideKeys.listLegacy();
    if (!legacy.ok) return legacy;
    return { ok: true, keys: { proof: proof.present ? proof.raw : null, prevCopy: prev.present ? prev.raw : null, legacyList: legacy.sha256s.join(',') } };
  }
  const sameFirstKeys = (a, b) => a.proof === b.proof && a.prevCopy === b.prevCopy && a.legacyList === b.legacyList;

  async function planImportV1(bytes) {
    if (busy) return out(fail('WRITES_BUSY', { gate: 'busy' }));
    if (gate.gate !== 'absent') return out(fail('WRITES_NOT_ALLOWED', { gate: gate.gate }));
    // The input is copied at the call, before any await (ENC4): later changes to the caller's buffer
    // cannot reach the plan.
    let copy;
    if (bytes instanceof Uint8Array) copy = bytes.slice();
    else if (bytes instanceof ArrayBuffer) copy = new Uint8Array(bytes.slice(0));
    else return out(fail('RESULT_INVALID', { errors: [{ code: 'INV-SHAPE', path: '$bytes', message: 'the source must be a Uint8Array or ArrayBuffer' }] }));
    const k = await firstMigrationKeys();
    if (!k.ok) return out(k);
    const dec = await decodeSource(copy);
    if (!dec.ok) return out(dec);
    const importId = newId('imp');
    const importedAt = now();
    const b = await buildFirstMigration({ text: dec.text, importId, importedAt, appVersion, seedDoc }); // M1 (no write)
    if (!b.ok) return out(b);
    if (busy || gate.gate !== 'absent' || store.getState().status !== 'absent') return out(fail('PLAN_INVALID', { reason: 'stale' }));
    planSeq += 1;
    const planId = `plan_${planSeq}_${importId}`;
    plans.set(planId, { kind: 'v1_first', gate: 'absent', text: dec.text, byteLength: dec.byteLength, importId, importedAt, b, keys: k.keys });
    return out({ ok: true, planId, summary: { importId, importedAt, sourceSha256: b.sourceSha256, byteLength: dec.byteLength, candidateSha256: b.candidateSha256, counts: b.entry.counts, activeSession: b.candidate.activeSession !== null, report: b.report } });
  }

  /** First migration M1–M8 (Revision 4 §2), confirmed from a plan (Step 2d.1). */
  const importV1 = workflow('importV1', ['absent'], async (exp, planId) => {
    const plan = plans.get(planId);
    plans.delete(planId); // single use, whatever happens next
    if (!plan || plan.kind !== 'v1_first' || plan.gate !== 'absent') return fail('PLAN_INVALID', { reason: 'unknown' });
    // Stale-plan protection: the storage state the preview was made on, read again before any write.
    const loaded = await store.reload();
    if (loaded.status !== 'absent') return fail('PLAN_INVALID', { reason: 'stale' });
    const k = await firstMigrationKeys();
    if (!k.ok) return k;
    if (!sameFirstKeys(k.keys, plan.keys)) return fail('PLAN_INVALID', { reason: 'stale' });
    // The plan's own content is unchanged: source text and candidate still hash to the previewed values.
    const { b, importId, importedAt } = plan;
    if ((await sha256Hex(plan.text)) !== b.sourceSha256 || (await canonicalSha256(b.candidate)) !== b.candidateSha256) return fail('PLAN_INVALID', { reason: 'integrity' });
    const dec = { text: plan.text };
    const leg = await sideKeys.putLegacy(dec.text, b.sourceSha256); // M2
    if (!leg.ok) return { ...leg, stage: 'legacy' };
    exp.legacyList = [...new Set([...(exp.legacyList ? exp.legacyList.split(',').filter(Boolean) : []), b.sourceSha256])].sort().join(',');
    const proof = await sideKeys.putProof({ importId, sourceSha256: b.sourceSha256, candidateSha256: b.candidateSha256, params: { importedAt, appVersion, seedSha256: b.seedSha256, rulesVersion: MIGRATION_RULES_VERSION } }); // M3
    if (!proof.ok) return { ...proof, stage: 'proof' };
    exp.proof = proof.raw;
    const init = await store.initialize(b.candidate); // M4
    if (!init.ok) return { ...init, stage: 'store' };
    exp.v2 = v2Fingerprint();
    if ((await legacyStatus(b.sourceSha256)) !== 'ok') return fail('SOURCE_MISMATCH', { stage: 'verify' }); // M5
    const v = await store.markImportVerified(importId, { expectedCandidateSha256: b.candidateSha256 }); // M6
    if (!v.ok) return { ...v, stage: 'verify' };
    exp.v2 = v2Fingerprint();
    const del = sideKeys.deleteProof(proof.raw); // M7
    if (!del.ok) return { ...del, stage: 'cleanup' };
    exp.proof = null;
    return { ok: true, importId, report: b.report }; // M8: the gate opens through settle()
  });

  const applyLateImport = workflow('applyLateImport', ['open'], async (exp, planId, selection = {}) => {
    const plan = plans.get(planId);
    plans.delete(planId);
    if (!plan || plan.gate !== 'open' || canonicalize(store.exportCurrentState().store) !== plan.plan.storeCanonical) return fail('PLAN_INVALID');
    const b = buildLateImport(plan.plan, selection);
    if (!b.ok) return b;
    if (!b.additions) return { ok: true, outcome: 'unchanged' };
    const leg = await sideKeys.putLegacy(plan.plan.text, plan.plan.sourceSha256);
    if (!leg.ok) return { ...leg, stage: 'legacy' };
    exp.legacyList = [...new Set([...(exp.legacyList ? exp.legacyList.split(',').filter(Boolean) : []), plan.plan.sourceSha256])].sort().join(',');
    const a = b.additions;
    // The dedicated, checked write (remediation A): ordinary commits cannot add import-log entries.
    const c = await store.appendLateImport(a);
    if (c.outcome !== 'saved') return { ...c, ok: false, stage: 'store' };
    exp.v2 = v2Fingerprint();
    if ((await legacyStatus(plan.plan.sourceSha256)) !== 'ok') return fail('SOURCE_MISMATCH', { stage: 'verify' });
    const v = await store.markImportVerified(a.entry.importId);
    if (!v.ok) return { ...v, stage: 'verify' };
    exp.v2 = v2Fingerprint();
    return { ok: true, importId: a.entry.importId, counts: a.entry.counts };
  });

  /**
   * Step 2f: Garmin CSV import. The plan is built again from the same bytes and the user's decisions;
   * the store must be unchanged since the plan (else PLAN_INVALID 'stale': plan again). Writes through
   * the dedicated Store.appendCsvImport, then verifies the stored result against the build (every data
   * row accounted for) before the entry is marked verified. A partial result is never marked verified.
   */
  const applyGarminCsv = workflow('applyGarminCsv', ['open'], async (exp, planId, decisions) => {
    const plan = plans.get(planId);
    if (!plan || plan.kind !== 'garmin_csv') return fail('PLAN_INVALID', { reason: 'unknown' });
    if (canonicalize(store.exportCurrentState().store) !== plan.storeCanonical) {
      plans.delete(planId);
      return fail('PLAN_INVALID', { reason: 'stale' });
    }
    const cur = store.exportCurrentState().store;
    const dec = await decodeSource(plan.bytes);
    if (!dec.ok || dec.sha256 !== plan.analysis.fileSha256) return fail('PLAN_INVALID', { reason: 'integrity' });
    const an = await analyzeGarminCsv({ text: dec.text, fileSha256: dec.sha256, fileName: plan.analysis.fileName, store: cur });
    if (!an.ok) return an;
    const b = await buildGarminImport(an.analysis, decisions, { store: cur, importedAt: now() });
    if (!b.ok) return b;
    if (!b.additions) return { ok: true, outcome: 'unchanged', report: b.report };
    const a = b.additions;
    plans.delete(planId); // a plan is written at most once
    const c = await store.appendCsvImport(a);
    if (c.outcome !== 'saved') return { ...c, ok: false, stage: 'store' };
    exp.v2 = v2Fingerprint();
    // verification of what was stored: the import's sessions and quarantine are exactly the additions,
    // and the rows they reference are exactly the rows the build accounted for as imported / set aside.
    const after = store.exportCurrentState().store;
    const mine = after.sessions.filter((x) => x.origin === 'csv_import' && x.provenance.importId === a.entry.importId);
    const q = after.quarantine.filter((x) => x.importId === a.entry.importId);
    const rows = storedRowsOf(after, a.entry.importId);
    const r = b.report.reconciliation;
    if (canonicalize(mine) !== canonicalize(a.sessions) || canonicalize(q) !== canonicalize(a.quarantine) || rows.length !== r.imported + r.setAside || new Set(rows).size !== rows.length) {
      return fail('CANDIDATE_MISMATCH', { stage: 'verify' }); // stays pending: the gate shows it until it is resolved
    }
    const v = await store.markImportVerified(a.entry.importId);
    if (!v.ok) return { ...v, stage: 'verify' };
    exp.v2 = v2Fingerprint();
    return { ok: true, importId: a.entry.importId, counts: a.entry.counts, report: b.report };
  });

  /**
   * Step 2f: imports the reviewed personal-data file (separate from the CSV import). The plan must be
   * current; the write goes through Store.appendPersonalSeed; the stored result is compared with the
   * build before the entry is marked verified; onboarding.personalSeed becomes "done".
   */
  const applyPersonalSeed = workflow('applyPersonalSeed', ['open'], async (exp, planId, decisions) => {
    const plan = plans.get(planId);
    if (!plan || plan.kind !== 'personal_seed') return fail('PLAN_INVALID', { reason: 'unknown' });
    const cur = store.exportCurrentState().store;
    if (canonicalize(cur) !== plan.storeCanonical) {
      plans.delete(planId);
      return fail('PLAN_INVALID', { reason: 'stale' });
    }
    const b = await buildPersonalSeed(plan.items, decisions ?? {}, { store: cur, importedAt: now(), sourceSha256: plan.sourceSha256 });
    if (!b.ok) return b;
    if (!b.additions) return { ok: true, outcome: 'unchanged', summary: b.summary };
    plans.delete(planId);
    const c = await store.appendPersonalSeed(b.additions);
    if (c.outcome !== 'saved') return { ...c, ok: false, stage: 'store' };
    exp.v2 = v2Fingerprint();
    const after = store.exportCurrentState().store;
    const a = b.additions;
    const goalsOk = a.goals.every((g) => after.goals.some((x) => canonicalize(x) === canonicalize(g)));
    const recsOk = a.manualRecords.every((r) => after.manualRecords.some((x) => canonicalize(x) === canonicalize(r)));
    const pfOk = a.prefills.every((pf) => after.exercises.find((x) => x.id === pf.exerciseId)?.prefill?.load === pf.load);
    const bwOk = a.bodyweight === null || (after.settings.bodyweight.value === a.bodyweight.value && after.settings.bodyweight.unit === a.bodyweight.unit);
    if (!(goalsOk && recsOk && pfOk && bwOk)) return fail('CANDIDATE_MISMATCH', { stage: 'verify' });
    const v = await store.markImportVerified(a.entry.importId);
    if (!v.ok) return { ...v, stage: 'verify' };
    exp.v2 = v2Fingerprint();
    const ob = await store.updateOnboarding({ personalSeed: 'done' });
    if (ob.ok !== false) exp.v2 = v2Fingerprint();
    return { ok: true, importId: a.entry.importId, summary: b.summary };
  });

  /**
   * Required legacy hashes that will be missing after a restore: required − valid snapshots supplied
   * − valid keys already on the device. Reads only; runs before any write (legacy keys are never deleted).
   */
  async function missingAfter(required, supplied) {
    const have = new Set(supplied.map((s) => s.sha256));
    const missing = [];
    for (const sha of required) {
      if (have.has(sha)) continue;
      const st = await legacyStatus(sha);
      if (st === 'unreadable') return fail('STORAGE_READ_FAILED', { stage: 'legacy' });
      if (st !== 'ok') missing.push(sha);
    }
    return { ok: true, missing };
  }

  /** The proven export of the state about to be replaced (Revision 2 "C"). */
  async function proveExport(st, bytes) {
    if (st.status === 'absent') return { ok: true };
    if (!bytes) return fail('EXPORT_NOT_PROVEN');
    if (st.status === 'invalid') return verifyExportFile(bytes, { kind: 'raw', rawSha256: await sha256Hex(store.rawForExport().raw) });
    return verifyExportFile(bytes, { kind: 'store', dataSha256: await canonicalSha256((({ sync, ...rest }) => rest)(store.exportCurrentState().store)), unsavedState: false }); // device-local sync state is not part of a backup
  }

  /** Shared restore core R3–R6: previous copy, legacy snapshots, single store write, verification. */
  async function replaceWith(exp, st, built, { importId, restoreId, snapshots, overwriteInvalid, keepPrev = false }) {
    let prevRaw = null;
    let expected;
    if (st.status === 'ok') {
      const cur = store.exportCurrentState().store;
      expected = { revision: cur.meta.dataRevision, storeSha256: await canonicalSha256(cur) };
    } else if (st.status === 'invalid') expected = { invalidSha256: await sha256Hex(store.rawForExport().raw) };
    else expected = { absent: true };
    if (st.status !== 'absent' && !keepPrev) {
      const raw = st.status === 'ok' ? JSON.stringify(store.exportCurrentState().store) : store.rawForExport().raw;
      const prev = await sideKeys.putPrevCopy({ kind: 'restore', id: restoreId, capturedAt: now(), dataSha256: st.status === 'ok' ? expected.storeSha256 : null, raw }); // R3
      if (!prev.ok) return { ...prev, stage: 'prevCopy' };
      exp.prevCopy = prev.raw;
      prevRaw = prev.raw;
    }
    for (const s of snapshots) { // R4
      const leg = await sideKeys.putLegacy(s.raw, s.sha256);
      if (!leg.ok) return { ...leg, stage: 'legacy' };
      exp.legacyList = [...new Set([...(exp.legacyList ? exp.legacyList.split(',').filter(Boolean) : []), s.sha256])].sort().join(',');
    }
    if (prevRaw) {
      const conf = sideKeys.confirmPrevCopy(prevRaw);
      if (!conf.ok) return { ...conf, stage: 'prevCopy' };
    }
    const r = await store.replaceStore(built, { expected, overwriteInvalid }); // R5
    if (!r.ok) return { ...r, stage: 'store' };
    exp.v2 = v2Fingerprint();
    const v = await store.markImportVerified(importId, { expectedCandidateSha256: await canonicalSha256(built) }); // R6
    if (!v.ok) return { ...v, stage: 'verify' };
    exp.v2 = v2Fingerprint();
    return { ok: true, restoreId, importId, revision: built.meta.dataRevision };
  }

  const restoreBackup = workflow('restoreBackup', ['absent', 'open', 'recovery'], async (exp, opts = {}) => {
    const blocked = orphanBlock(opts);
    if (blocked) return blocked;
    const st = store.getState();
    if (st.status === 'invalid' && opts.overwriteInvalid !== true) return fail('INVALID_STORE');
    const parsed = await parseBackup(opts.backupBytes);
    if (!parsed.ok) return parsed;
    if (parsed.envelope.unsavedState && opts.acknowledgeUnsavedBackup !== true) return fail('CONFIRMATION_REQUIRED', { reason: 'unsaved_state_backup' });
    const prevNow = await sideKeys.getPrevCopy();
    if (!prevNow.ok) return prevNow;
    if (prevNow.present && st.status !== 'absent') return fail('PREV_COPY_PRESENT');
    const proven = await proveExport(st, opts.provenExportBytes);
    if (!proven.ok) return proven;
    const missingAtRestore = await missingAfter(parsed.required, parsed.goodSnapshots);
    if (!missingAtRestore.ok) return missingAtRestore;
    const restoreId = freshId('restore', parsed.data);
    const importId = freshId('imp', parsed.data);
    const built = await buildRestoredStore({
      data: parsed.data, envelope: parsed.envelope, sourceSha256: parsed.sourceSha256,
      currentRevision: st.status === 'ok' ? st.revision : null, restoreId, importId, now: now(),
      prevCopyExists: st.status !== 'absent', missingAtRestore: missingAtRestore.missing,
    }); // R1
    if (!built.ok) return built;
    return replaceWith(exp, st, built.store, { importId, restoreId, snapshots: parsed.goodSnapshots, overwriteInvalid: opts.overwriteInvalid === true });
  });

  /** "Go back to the previous copy" (manual): a restore whose source is the stored previous copy. */
  const revertToPrevCopy = workflow('revertToPrevCopy', ['open'], async (exp, opts = {}) => {
    const p = await sideKeys.getPrevCopy();
    if (!p.ok) return p;
    if (!p.present || !p.valid || p.copy.dataSha256 === null) return fail('NOT_FOUND');
    let data;
    try {
      data = JSON.parse(p.copy.raw);
    } catch {
      return fail('RESULT_INVALID');
    }
    if ((await canonicalSha256(data)) !== p.copy.dataSha256) return fail('BACKUP_INTEGRITY');
    const st = store.getState();
    const proven = await proveExport(st, opts.provenExportBytes);
    if (!proven.ok) return proven;
    const restoreId = freshId('restore', data);
    const importId = freshId('imp', data);
    const envelope = { dataSha256: p.copy.dataSha256, unsavedState: false };
    const missingAtRestore = await missingAfter(referencedLegacy(data).map((r) => r.sha256), []);
    if (!missingAtRestore.ok) return missingAtRestore;
    const built = await buildRestoredStore({ data, envelope, sourceSha256: p.copy.rawSha256, currentRevision: st.revision, restoreId, importId, now: now(), prevCopyExists: true, missingAtRestore: missingAtRestore.missing });
    if (!built.ok) return built;
    return replaceWith(exp, st, built.store, { importId, restoreId, snapshots: [], overwriteInvalid: false, keepPrev: true });
  });

  /**
   * Deleting the previous copy requires a PROVEN export of it (Revision 2): the bytes of the file the
   * user saved and re-selected must hash to the copy's rawSha256 (the export is the copy's raw text).
   */
  const deletePrevCopy = workflow('deletePrevCopy', ['open', 'absent', 'recovery'], async (exp, { id, rawSha256, provenExportBytes } = {}) => {
    if (typeof id !== 'string' || typeof rawSha256 !== 'string') return fail('RESULT_INVALID');
    const proven = provenExportBytes ? await verifyExportFile(provenExportBytes, { kind: 'raw', rawSha256 }) : fail('EXPORT_NOT_PROVEN');
    if (!proven.ok) return proven;
    const d = await sideKeys.deletePrevCopy({ id, rawSha256 });
    if (d.ok) exp.prevCopy = null;
    return d;
  });

  const reattachSource = workflow('reattachSource', ['verificationIncomplete', 'open'], async (exp, bytes) => {
    const dec = await decodeSource(bytes);
    if (!dec.ok) return dec;
    const mem = store.exportCurrentState().store;
    const wanted = new Set(referencedLegacy(mem).map((r) => r.sha256));
    if (!wanted.has(dec.sha256)) return fail('SOURCE_MISMATCH');
    const leg = await sideKeys.putLegacy(dec.text, dec.sha256);
    if (!leg.ok) return leg;
    exp.legacyList = [...new Set([...(exp.legacyList ? exp.legacyList.split(',').filter(Boolean) : []), dec.sha256])].sort().join(',');
    if (gate.gate === 'verificationIncomplete') {
      const r = await autoRecover(exp);
      if (!r.ok) return r;
    }
    return { ok: true, sha256: dec.sha256 };
  });

  /** Explicit decisions on the verification-incomplete screen (R3-3, R4-2). */
  function decide(flag) {
    return async (exp, { confirm } = {}) => {
      if (confirm !== true) return fail('CONFIRMATION_REQUIRED');
      const mem = store.exportCurrentState().store;
      const pend = mem.meta.importLog.find((e) => e.status === 'pending');
      if (!pend || !V1_KINDS.includes(pend.kind)) return fail('IMPORT_NOT_PENDING');
      const source = await legacyStatus(pend.sourceSha256);
      if (flag === 'sourceUnavailable' && source === 'ok') return fail('CONFLICT', { reason: 'source_available' });
      const opts = { sourceUnavailable: source !== 'ok', candidateUnproven: flag === 'candidateUnproven' };
      if (flag === 'sourceUnavailable' && pend.kind === 'v1_migration') {
        const p = await sideKeys.getProof();
        if (p.ok && p.present && p.valid && p.proof.importId === pend.importId) opts.expectedCandidateSha256 = p.proof.candidateSha256;
      }
      const v = await store.markImportVerified(pend.importId, opts);
      if (!v.ok) return v;
      exp.v2 = v2Fingerprint();
      return cleanupProof(exp);
    };
  }
  const continueWithoutSource = workflow('continueWithoutSource', ['verificationIncomplete'], decide('sourceUnavailable'));
  const acceptUnproven = workflow('acceptUnproven', ['verificationIncomplete'], decide('candidateUnproven'));

  const retryVerification = workflow('retryVerification', ['verificationIncomplete'], async (exp) => autoRecover(exp));
  const retryCleanup = workflow('retryCleanup', ['cleanupPending'], async (exp) => cleanupProof(exp));
  const retryInspection = workflow('retryInspection', ['inspectionFailed'], async () => ({ ok: true }), { requireSaved: false });

  /** Screen R: a manual rebuild of an unreadable store, only after its raw text was exported and the user confirmed. */
  const manualRebuild = workflow('manualRebuild', ['recovery'], async (exp, { confirm } = {}) => {
    if (confirm !== true) return fail('CONFIRMATION_REQUIRED');
    if (!rawExported) return fail('EXPORT_NOT_PROVEN');
    return rebuildInvalid(exp, { manual: true });
  });

  /** Re-reads storage (needed after an external change); unsaved changes must be discarded explicitly. */
  const reload = workflow('reload', ['open', 'absent', 'verificationIncomplete', 'cleanupPending', 'recovery'], async () => ({ ok: true }), {
    requireSaved: false,
    // Unsaved changes are discarded only on explicit request; the refusal happens before settle().
    precheck: ({ discardUnsaved } = {}) => (store.getState().unsaved && discardUnsaved !== true ? fail('UNSAVED_STATE', { gate: gate.gate }) : null),
  });

  // ---- normal writes (gate `open` only) ----------------------------------------------------------
  let normalTail = Promise.resolve();
  function normal(op) {
    if (busy) return Promise.resolve(out(fail('WRITES_BUSY', { gate: 'busy' })));
    if (gate.gate !== 'open') return Promise.resolve(out(fail('WRITES_NOT_ALLOWED', { gate: gate.gate })));
    const p = normalTail.then(async () => {
      // Checked again when the queued operation starts (GATE4/WF5).
      if (busy) return fail('WRITES_BUSY', { gate: 'busy' });
      if (gate.gate !== 'open') return fail('WRITES_NOT_ALLOWED', { gate: gate.gate });
      // known.v2 is not refreshed here: its only reader (workflow(), `exp`) replaces v2 with a fresh
      // v2Fingerprint() when the workflow starts, and settle() rebuilds `known` from storage (O1).
      return op();
    });
    normalTail = p.catch(() => {});
    p.then(notifyChange, notifyChange);
    return p.then(out, (err) => {
      if (err?.gateClosed) return out(fail('WRITES_BUSY', { gate: currentGate() }));
      // A domain rule refused the change (src/core): nothing was written.
      if (err?.domainCode) return out(fail(err.domainCode, { details: structuredClone(err.details ?? {}) }));
      return out(fail('WORKFLOW_FAILED', { message: String(err?.message ?? err) }));
    });
  }

  // ---- read-only -------------------------------------------------------------------------------
  function getState() {
    const st = store.getState();
    return out({ ...gate, gate: currentGate(), busy, store: st });
  }

  // ---- read API for the UI (Step 2d.0) --------------------------------------------------------------
  // snapshot(): the in-memory store as a deep-frozen, detached object. The clone is made once per
  // Store change (store.getState().seq is bumped by every memory replacement, including writes that
  // end unsaved), so a stale snapshot cannot be returned. While a workflow is running the last
  // stable snapshot is returned with busy: true — never a workflow's half-written candidate.
  let snapCache = null; // { seq, store }
  function snapshot() {
    const st = store.getState();
    if (busy) {
      if (!snapCache) return out(fail('EXPORT_UNAVAILABLE_BUSY'));
      return deepFreeze({ ok: true, store: snapCache.store, seq: snapCache.seq, revision: snapCache.store.meta.dataRevision, unsaved: st.unsaved, stale: st.stale, persisted: false, busy: true });
    }
    if (!snapCache || snapCache.seq !== st.seq) {
      const e = store.exportCurrentState();
      if (!e.ok) {
        snapCache = null;
        return out(e);
      }
      snapCache = { seq: st.seq, store: deepFreeze(e.store) };
    }
    return deepFreeze({ ok: true, store: snapCache.store, seq: snapCache.seq, revision: st.revision, unsaved: st.unsaved, stale: st.stale, persisted: !st.unsaved && !st.stale, busy: false });
  }

  function storageUsage() {
    const u = sideKeys.usage();
    if (!u.ok) return out(u);
    return out({ ok: true, keys: u.keys, totalChars: u.keys.reduce((n, k) => n + k.chars, 0) });
  }

  // ---- input draft (Step 2d.0) ----------------------------------------------------------------------
  // Synchronous. Writing is allowed only while the gate is open (the same condition as commits);
  // reading is always allowed. A draft is never deleted automatically (only by clearInputDraft with
  // the exact text that was read).
  function readInputDraft() {
    const r = sideKeys.getInputDraft();
    if (!r.ok) return out(r);
    if (r.raw === null) return out({ ok: true, raw: null, doc: null });
    let doc;
    try {
      doc = JSON.parse(r.raw);
    } catch {
      return out({ ok: true, raw: r.raw, doc: null, problem: 'not JSON' });
    }
    const problem = draftProblem(doc);
    return out(problem ? { ok: true, raw: r.raw, doc: null, problem } : { ok: true, raw: r.raw, doc });
  }

  function writeInputDraft(doc, { expectedRaw } = {}) {
    if (busy) return out(fail('WRITES_BUSY', { gate: 'busy' }));
    if (gate.gate !== 'open') return out(fail('WRITES_NOT_ALLOWED', { gate: gate.gate }));
    if (!(expectedRaw === null || typeof expectedRaw === 'string')) throw new TypeError('writeInputDraft requires { expectedRaw } (the text that was read, or null)');
    const problem = draftProblem(doc);
    if (problem) return out(fail('INPUT_DRAFT_INVALID', { message: problem }));
    if (doc.entries.length === 0) return out(fail('INPUT_DRAFT_INVALID', { message: 'an empty draft is removed with clearInputDraft' }));
    const raw = JSON.stringify(doc);
    if (raw.length > INPUT_DRAFT_MAX_CHARS) return out(fail('INPUT_DRAFT_INVALID', { message: `the draft exceeds ${INPUT_DRAFT_MAX_CHARS} characters` }));
    return out(sideKeys.putInputDraft(raw, expectedRaw));
  }

  function clearInputDraft(expectedRaw) {
    if (typeof expectedRaw !== 'string') throw new TypeError('clearInputDraft requires the draft text that was read');
    return out(sideKeys.removeInputDraft(expectedRaw));
  }

  function exportCurrentState() {
    if (busy) return out(fail('EXPORT_UNAVAILABLE_BUSY'));
    const e = store.exportCurrentState();
    if (!e.ok) return out(e);
    return out({ ok: true, json: JSON.stringify(e.store), revision: e.revision, unsaved: e.unsaved, stale: e.stale, persisted: !e.unsaved && !e.stale });
  }

  function rawForExport() {
    if (busy) return out(fail('EXPORT_UNAVAILABLE_BUSY'));
    const r = store.rawForExport();
    if (r.ok) rawExported = true;
    return out(r);
  }

  async function exportLegacy(sha256) {
    if (typeof sha256 !== 'string') return out(fail('NOT_FOUND'));
    const r = await sideKeys.getLegacy(sha256);
    if (!r.ok) return out(r);
    if (!r.present) return out(fail('NOT_FOUND'));
    return out({ ok: true, source: 'stored', sha256, raw: r.raw, hashValid: r.hashValid });
  }

  async function exportPrevCopy() {
    const r = await sideKeys.getPrevCopy();
    if (!r.ok) return out(r);
    if (!r.present) return out(fail('NOT_FOUND'));
    if (!r.valid) return out({ ok: true, source: 'stored', valid: false, raw: r.raw });
    const { kind, id, capturedAt, rawSha256, dataSha256, raw } = r.copy;
    return out({ ok: true, source: 'stored', valid: true, kind, id, capturedAt, rawSha256, dataSha256, raw });
  }

  /** Builds a backup file (writes nothing). recordBackup is a separate call after the file was saved. */
  async function createBackup({ partial = false } = {}) {
    if (busy) return out(fail('EXPORT_UNAVAILABLE_BUSY'));
    const e = store.exportCurrentState();
    if (!e.ok) return out(e);
    const b = await buildBackup({ exported: e, readLegacy: (sha) => sideKeys.getLegacy(sha), now: now(), appVersion, partial });
    if (!b.ok) return out(b);
    return out({ ok: true, json: b.json, fileName: b.fileName, complete: b.complete, missing: b.missing, revision: b.envelope.dataRevision, unsavedState: b.envelope.unsavedState });
  }

  async function makePlan(text) {
    if (busy) return fail('WRITES_BUSY');
    if (gate.gate !== 'open') return fail('WRITES_NOT_ALLOWED', { gate: gate.gate });
    const st = store.getState();
    if (st.unsaved || st.stale) return fail(st.unsaved ? 'UNSAVED_STATE' : 'EXTERNAL_CHANGE');
    const cur = store.exportCurrentState().store;
    const r = await planLate({ text, store: cur, seedDoc, importId: freshId('imp', cur), importedAt: now(), readLegacy: (sha) => sideKeys.getLegacy(sha) });
    if (!r.ok) return r;
    planSeq += 1;
    const planId = `plan_${planSeq}_${r.plan.importId}`;
    plans.set(planId, { plan: r.plan, gate: 'open' });
    return { ok: true, planId, summary: { sourceSha256: r.plan.sourceSha256, structure: r.plan.structure, items: r.plan.items, draftPresent: r.plan.draftPresent, warnings: [...r.plan.mapping.warnings, ...r.plan.extraWarnings] } };
  }

  /** Step 2f: reads gymlog-personal.json and checks each item against the current data. Writes nothing. */
  async function planPersonalSeed(bytes) {
    if (busy) return out(fail('WRITES_BUSY'));
    if (gate.gate !== 'open') return out(fail('WRITES_NOT_ALLOWED', { gate: gate.gate }));
    const st = store.getState();
    if (st.unsaved || st.stale) return out(fail(st.unsaved ? 'UNSAVED_STATE' : 'EXTERNAL_CHANGE'));
    const dec = await decodeSource(new Uint8Array(bytes));
    if (!dec.ok) return out(dec);
    const p = parsePersonalSeed(dec.text);
    if (!p.ok) return out(p);
    const cur = store.exportCurrentState().store;
    if (cur.meta.importLog.some((e) => e.kind === 'personal_seed' && e.sourceSha256 === dec.sha256)) return out(fail('ALREADY_IMPORTED', { sourceSha256: dec.sha256 }));
    const checks = await checkPersonalItems(p.items, cur, { importedAt: now(), sourceSha256: dec.sha256 });
    planSeq += 1;
    const planId = `plan_${planSeq}_personal`;
    plans.set(planId, { kind: 'personal_seed', items: p.items, sourceSha256: dec.sha256, storeCanonical: canonicalize(cur) });
    return out({ ok: true, planId, sourceSha256: dec.sha256, items: p.items, checks, defaults: defaultPersonalDecisions(p.items) });
  }

  /** Step 2f: reads a Garmin CSV and describes the decisions it needs. Writes nothing. */
  async function planGarminCsv(bytes, fileName = 'unified_workouts.csv') {
    if (busy) return out(fail('WRITES_BUSY'));
    if (gate.gate !== 'open') return out(fail('WRITES_NOT_ALLOWED', { gate: gate.gate }));
    const st = store.getState();
    if (st.unsaved || st.stale) return out(fail(st.unsaved ? 'UNSAVED_STATE' : 'EXTERNAL_CHANGE'));
    let copy;
    try {
      copy = new Uint8Array(bytes); // the bytes are copied at the call
    } catch {
      return out(fail('SOURCE_EMPTY'));
    }
    const dec = await decodeSource(copy);
    if (!dec.ok) return out(dec);
    const cur = store.exportCurrentState().store;
    const an = await analyzeGarminCsv({ text: dec.text, fileSha256: dec.sha256, fileName: String(fileName), store: cur });
    if (!an.ok) return out(an);
    if (an.analysis.alreadyFile) return out(fail('ALREADY_IMPORTED', { sourceSha256: dec.sha256 }));
    planSeq += 1;
    const planId = `plan_${planSeq}_csv`;
    plans.set(planId, { kind: 'garmin_csv', bytes: copy, analysis: an.analysis, storeCanonical: canonicalize(cur) });
    return out({ ok: true, planId, analysis: an.analysis, defaults: defaultDecisions(an.analysis) });
  }

  /** Step 2f: the additions a plan + decisions would write (for the preview). Writes nothing. */
  async function previewGarminCsv(planId, decisions) {
    const plan = plans.get(planId);
    if (!plan || plan.kind !== 'garmin_csv') return out(fail('PLAN_INVALID', { reason: 'unknown' }));
    let d;
    try {
      d = structuredClone(decisions);
    } catch {
      return out(fail('RESULT_INVALID'));
    }
    const cur = store.exportCurrentState().store;
    const missing = missingDecisions(plan.analysis, d, cur);
    if (missing.length) return out({ ok: true, complete: false, missing, counts: null, warnings: [], unresolved: [], reconciliation: null, sessions: [] });
    const b = await buildGarminImport(plan.analysis, d, { store: cur, importedAt: now() });
    if (!b.ok) return out(b);
    return out({ ok: true, complete: true, missing: [], counts: b.additions?.entry.counts ?? null, warnings: b.additions?.entry.warnings ?? [], unresolved: b.additions?.entry.unresolvedExercises ?? [], newExercises: (b.additions?.exercises ?? []).filter((x) => x.id.startsWith('ex_csvn_')).map((x) => x.name), reconciliation: b.report.reconciliation, sessions: b.additions?.sessions ?? [] });
  }

  async function planLateImport(bytes) {
    const dec = await decodeSource(bytes);
    if (!dec.ok) return out(dec);
    return out(await makePlan(dec.text));
  }

  async function planLateImportFromLegacy(sha256) {
    const r = await sideKeys.getLegacy(sha256);
    if (!r.ok) return out(r);
    if (!r.present || !r.hashValid) return out(fail('SOURCE_MISMATCH'));
    return out(await makePlan(r.raw));
  }

  // ---- launch ------------------------------------------------------------------------------------
  await store.load();
  const first = await stableSnapshot();
  if (!first.failedReads && !first.unstable) await autoRecover(null); // SG7i: never on a partial read
  await settle(null);

  const app = Object.freeze({
    // read-only
    getState,
    exportCurrentState,
    rawForExport,
    exportLegacy,
    exportPrevCopy,
    createBackup,
    planImportV1,
    planLateImport,
    planLateImportFromLegacy,
    planGarminCsv,
    previewGarminCsv,
    planPersonalSeed,
    onGateChange(cb) {
      if (typeof cb !== 'function') throw new TypeError('onGateChange(cb) requires a function');
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    handleStorageEvent(e) {
      store.handleStorageEvent(e && typeof e === 'object' ? { key: e.key ?? null, newValue: e.newValue ?? null } : e);
      notifyChange();
    },
    snapshot,
    storageUsage,
    onChange(cb) {
      if (typeof cb !== 'function') throw new TypeError('onChange(cb) requires a function');
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    // input draft (synchronous, tiny, outside the store; Step 2d.0)
    readInputDraft,
    writeInputDraft,
    clearInputDraft,
    // normal writes
    /**
     * User-data change. fn(draft, ctx) returns the next store; ctx = { now, newId } for the domain
     * functions in src/core (e.g. app.commit((s, c) => startNew(s, { date }, c))). A DomainError
     * thrown by fn is returned as { ok: false, code } and nothing is written.
     */
    commit: (fn) => {
      if (typeof fn !== 'function') throw new TypeError('commit(fn) requires a function');
      return normal(() => store.commit(async (draft) => {
        if (busy || gate.gate !== 'open') throw Object.assign(new Error('gate closed'), { gateClosed: true });
        // No copy here: Store.commit copies the returned object before any check (O2).
        return fn(draft, { now: now(), newId });
      }));
    },
    retrySave: () => normal(() => store.retrySave()),
    recordBackup: (args) => normal(() => store.recordBackup(structuredClone(args ?? {}))),
    updateOnboarding: (patch) => normal(() => store.updateOnboarding(structuredClone(patch))),
    markImportReportSeen: (importId, at) => normal(() => store.markImportReportSeen(importId, at)),
    /** Deletes one saved workout (imported ones need confirmImported). Propagates to the other devices as a deletion. */
    deleteSession: (sessionId, opts) => normal(() => store.deleteSession(sessionId, { confirmImported: opts?.confirmImported === true })),
    // workflows
    startFresh,
    importV1,
    applyLateImport,
    applyGarminCsv,
    applyPersonalSeed,
    restoreBackup,
    revertToPrevCopy,
    deletePrevCopy,
    reattachSource,
    continueWithoutSource,
    acceptUnproven,
    retryVerification,
    retryCleanup,
    retryInspection,
    manualRebuild,
    reload,
  });

  // Narrow port for the sync engine (src/sync/engine.js): read the stored state, and the two sync-only writes.
  const syncPort = Object.freeze({
    read: () => store.exportCurrentState(),
    applySync: (fn) => store.applySync(fn),
    enableSync: (section) => store.enableSync(section),
  });

  return { state: getState(), app, store, syncPort };
}

/** Facade methods that are multi-step workflows (static test WF10 / GATE-S3). */
export const WORKFLOW_METHODS = Object.freeze([
  'startFresh', 'importV1', 'applyLateImport', 'applyGarminCsv', 'applyPersonalSeed', 'restoreBackup', 'revertToPrevCopy', 'deletePrevCopy', 'reattachSource',
  'continueWithoutSource', 'acceptUnproven', 'retryVerification', 'retryCleanup', 'retryInspection', 'manualRebuild', 'reload',
]);
/** Facade methods that are normal (gated) writes. */
export const NORMAL_WRITE_METHODS = Object.freeze(['commit', 'retrySave', 'recordBackup', 'updateOnboarding', 'markImportReportSeen', 'deleteSession']);
/** Synchronous input-draft methods (side key gymlog.v2.input; Step 2d.0). */
export const INPUT_DRAFT_METHODS = Object.freeze(['readInputDraft', 'writeInputDraft', 'clearInputDraft']);
