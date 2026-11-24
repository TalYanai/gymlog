// Side keys (Step 2c.1): every storage key other than gymlog.v2 that Step 2c writes.
//   gymlog.legacy.<sha256>   raw v1 source text, content-addressed, never overwritten or deleted
//   gymlog.migration.proof   proof of the pending first-migration candidate (Revision 3–5)
//   gymlog.v2.prev           labeled previous copy (restore "C", migration rebuild)
//   gymlog.v2.input          Step 2d.0: typed-but-uncommitted set values (synchronous, tiny, ephemeral)
//
// Uses only the storage adapter (storage.js): single get/set/remove calls. There is NO
// compare-and-swap, lock or transaction (Revision 9 §E1). Protection is check-before-act plus
// read-back-after-act; on any mismatch the operation stops and reports EXTERNAL_CHANGE (or a
// specific code) so the caller can settle().
//
// KNOWN LIMITATION (SKX10): a write by another window that lands between our check and our own
// set/remove is overwritten or deleted, and our read-back then shows exactly our result — this
// window does NOT detect it. Only a change that lands after our action is detected.
// Consequences are bounded (Revision 9): losing another window's proof only disables its
// automatic rebuild (screen R instead); losing its previous copy leaves the proven export.

import { STORAGE_KEYS } from '../schema/constants.js';
import { sha256Hex, canonicalSha256 } from '../schema/canonical.js';
import { isIsoTimestamp } from '../schema/validate.js';
import { createStorage, StorageWriteError, StorageReadError } from './storage.js';

const LEGACY_PREFIX = STORAGE_KEYS.legacyPrefix;
const PROOF_KEY = STORAGE_KEYS.migrationProof;
const PREV_KEY = STORAGE_KEYS.v2Prev;
const INPUT_KEY = STORAGE_KEYS.inputDraft;
export const INPUT_DRAFT_MAX_CHARS = 4096;

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
const legacyKey = (sha) => `${LEGACY_PREFIX}${sha}`;

const PROOF_FIELDS = ['importId', 'sourceSha256', 'candidateSha256', 'params', 'proofSha256'];
const PROOF_PARAM_FIELDS = ['importedAt', 'appVersion', 'seedSha256', 'rulesVersion'];
const PREV_FIELDS = ['kind', 'id', 'capturedAt', 'rawSha256', 'dataSha256', 'raw'];
const PREV_KINDS = ['restore', 'migration_rebuild'];

const sameKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => k in o);

function storageFailure(err) {
  if (err instanceof StorageReadError) return { ok: false, code: 'STORAGE_READ_FAILED', kind: err.kind };
  if (err instanceof StorageWriteError) return { ok: false, code: 'STORAGE_WRITE_FAILED', kind: err.kind };
  throw err;
}

/** Shape check of a proof body (without proofSha256). Returns an error string or null. */
function proofBodyProblem(b) {
  if (!sameKeys(b, PROOF_FIELDS.filter((k) => k !== 'proofSha256'))) return 'proof fields must be exactly importId, sourceSha256, candidateSha256, params';
  if (!isNonEmptyStr(b.importId) || !b.importId.startsWith('imp_')) return 'importId must start with "imp_"';
  if (!HEX64.test(b.sourceSha256)) return 'sourceSha256 must be 64 hex';
  if (!HEX64.test(b.candidateSha256)) return 'candidateSha256 must be 64 hex';
  const p = b.params;
  if (!sameKeys(p, PROOF_PARAM_FIELDS)) return 'params fields must be exactly importedAt, appVersion, seedSha256, rulesVersion';
  if (!isIsoTimestamp(p.importedAt)) return 'params.importedAt must be an ISO timestamp';
  if (!isNonEmptyStr(p.appVersion)) return 'params.appVersion must be a non-empty string';
  if (!HEX64.test(p.seedSha256)) return 'params.seedSha256 must be 64 hex';
  if (!Number.isSafeInteger(p.rulesVersion) || p.rulesVersion < 1) return 'params.rulesVersion must be an integer ≥ 1';
  return null;
}

/** @returns {Promise<{valid:true, proof:object} | {valid:false, problem:string}>} */
async function checkProofText(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return { valid: false, problem: 'not JSON' };
  }
  if (!sameKeys(v, PROOF_FIELDS)) return { valid: false, problem: 'unexpected fields' };
  const { proofSha256, ...body } = v;
  const problem = proofBodyProblem(body);
  if (problem) return { valid: false, problem };
  if (proofSha256 !== (await canonicalSha256(body))) return { valid: false, problem: 'proofSha256 does not match' };
  return { valid: true, proof: v };
}

/** @returns {Promise<{valid:true, copy:object} | {valid:false, problem:string}>} */
async function checkPrevText(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return { valid: false, problem: 'not JSON' };
  }
  if (!sameKeys(v, PREV_FIELDS)) return { valid: false, problem: 'unexpected fields' };
  if (!PREV_KINDS.includes(v.kind)) return { valid: false, problem: 'invalid kind' };
  if (!isNonEmptyStr(v.id)) return { valid: false, problem: 'id must be a non-empty string' };
  if (!isIsoTimestamp(v.capturedAt)) return { valid: false, problem: 'capturedAt must be an ISO timestamp' };
  if (typeof v.raw !== 'string') return { valid: false, problem: 'raw must be a string' };
  if (!(v.dataSha256 === null || HEX64.test(v.dataSha256))) return { valid: false, problem: 'dataSha256 must be 64 hex or null' };
  if (v.rawSha256 !== (await sha256Hex(v.raw))) return { valid: false, problem: 'rawSha256 does not match raw' };
  return { valid: true, copy: v };
}

/**
 * @param {object} [deps]
 * @param {Storage} [deps.backend] defaults inside storage.js (tests inject a memory backend).
 */
export function createSideKeys({ backend } = {}) {
  const storage = createStorage(backend);

  // ---- legacy snapshots -----------------------------------------------------------------------

  /** Reads one legacy snapshot and checks that its content hashes to its name. */
  async function getLegacy(sha256) {
    if (!HEX64.test(sha256 ?? '')) throw new TypeError('sha256 must be 64 lowercase hex characters');
    let raw;
    try {
      raw = storage.get(legacyKey(sha256));
    } catch (err) {
      return storageFailure(err);
    }
    if (raw === null) return { ok: true, present: false };
    return { ok: true, present: true, raw, hashValid: (await sha256Hex(raw)) === sha256 };
  }

  /**
   * Stores the raw source text under its SHA-256. Absent → write + read-back. Present and
   * identical → reused. Present and different → never overwritten (LEGACY_KEY_CONFLICT).
   * @param {string} raw  decoded source text (byte-exact per decodeSource)
   * @param {string} [expectedSha256]  if given, must equal the hash of raw
   */
  async function putLegacy(raw, expectedSha256) {
    if (typeof raw !== 'string') throw new TypeError('raw must be a string');
    const sha256 = await sha256Hex(raw);
    if (expectedSha256 !== undefined && expectedSha256 !== sha256) throw new TypeError('raw does not hash to expectedSha256');
    const key = legacyKey(sha256);
    try {
      const existing = storage.get(key);
      if (existing !== null) {
        if (existing === raw) return { ok: true, sha256, reused: true };
        return { ok: false, code: 'LEGACY_KEY_CONFLICT', sha256 };
      }
      storage.set(key, raw);
      if (storage.get(key) !== raw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'legacy', sha256 };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true, sha256, reused: false };
  }

  /** All legacy snapshot hashes present in storage, sorted. */
  function listLegacy() {
    let keys;
    try {
      keys = storage.keys();
    } catch (err) {
      return storageFailure(err);
    }
    const sha256s = keys
      .filter((k) => k.startsWith(LEGACY_PREFIX))
      .map((k) => k.slice(LEGACY_PREFIX.length))
      .filter((s) => HEX64.test(s))
      .sort();
    return { ok: true, sha256s };
  }

  // ---- migration proof ------------------------------------------------------------------------

  /** @returns {Promise<{ok:true, present:false} | {ok:true, present:true, raw, valid, proof?, problem?} | storage failure>} */
  async function getProof() {
    let raw;
    try {
      raw = storage.get(PROOF_KEY);
    } catch (err) {
      return storageFailure(err);
    }
    if (raw === null) return { ok: true, present: false };
    const c = await checkProofText(raw);
    return c.valid ? { ok: true, present: true, raw, valid: true, proof: c.proof } : { ok: true, present: true, raw, valid: false, problem: c.problem };
  }

  /**
   * Writes the proof only if no proof exists; computes proofSha256; reads back.
   * @param {{importId, sourceSha256, candidateSha256, params:{importedAt, appVersion, seedSha256, rulesVersion}}} body
   * @returns {Promise<{ok:true, raw:string, proof:object} | {ok:false, code:'PROOF_PRESENT'|'EXTERNAL_CHANGE'|'RESULT_INVALID'|...}>}
   */
  async function putProof(body) {
    const problem = proofBodyProblem(body);
    if (problem) return { ok: false, code: 'RESULT_INVALID', message: problem };
    const copy = structuredClone(body);
    const proof = { ...copy, proofSha256: await canonicalSha256(copy) };
    const raw = JSON.stringify(proof);
    try {
      if (storage.get(PROOF_KEY) !== null) return { ok: false, code: 'PROOF_PRESENT' };
      storage.set(PROOF_KEY, raw);
      if (storage.get(PROOF_KEY) !== raw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'proof' };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true, raw, proof };
  }

  /**
   * Deletes the proof only if its stored text equals `expectedRaw`, then confirms it is gone.
   * The caller decides whether deleting is allowed (verified entry for its importId, or no v2).
   */
  function deleteProof(expectedRaw) {
    if (typeof expectedRaw !== 'string') throw new TypeError('expectedRaw must be the proof text that was read');
    try {
      const current = storage.get(PROOF_KEY);
      if (current !== expectedRaw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'proof', reason: current === null ? 'absent' : 'different' };
      storage.remove(PROOF_KEY);
      if (storage.get(PROOF_KEY) !== null) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'proof', reason: 'reappeared' };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true };
  }

  // ---- previous copy --------------------------------------------------------------------------

  async function getPrevCopy() {
    let raw;
    try {
      raw = storage.get(PREV_KEY);
    } catch (err) {
      return storageFailure(err);
    }
    if (raw === null) return { ok: true, present: false };
    const c = await checkPrevText(raw);
    return c.valid ? { ok: true, present: true, raw, valid: true, copy: c.copy } : { ok: true, present: true, raw, valid: false, problem: c.problem };
  }

  /**
   * Writes the previous copy only if none exists; computes rawSha256; reads back.
   * @param {{kind:'restore'|'migration_rebuild', id:string, capturedAt:string, dataSha256:string|null, raw:string}} input
   */
  async function putPrevCopy(input) {
    if (!isObj(input) || typeof input.raw !== 'string') throw new TypeError('putPrevCopy expects { kind, id, capturedAt, dataSha256, raw }');
    const copy = {
      kind: input.kind,
      id: input.id,
      capturedAt: input.capturedAt,
      rawSha256: await sha256Hex(input.raw),
      dataSha256: input.dataSha256,
      raw: input.raw,
    };
    const raw = JSON.stringify(copy);
    const check = await checkPrevText(raw);
    if (!check.valid) return { ok: false, code: 'RESULT_INVALID', message: check.problem };
    try {
      if (storage.get(PREV_KEY) !== null) return { ok: false, code: 'PREV_COPY_PRESENT' };
      storage.set(PREV_KEY, raw);
      if (storage.get(PREV_KEY) !== raw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'prevCopy' };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true, raw, copy };
  }

  /** Re-check just before the store is replaced: the stored previous copy must still be ours. */
  function confirmPrevCopy(expectedRaw) {
    if (typeof expectedRaw !== 'string') throw new TypeError('expectedRaw must be the previous-copy text that was written');
    try {
      if (storage.get(PREV_KEY) !== expectedRaw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'prevCopy' };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true };
  }

  /** Deletes the previous copy only if its id and rawSha256 match, then confirms it is gone. */
  async function deletePrevCopy({ id, rawSha256 } = {}) {
    if (!isNonEmptyStr(id) || !HEX64.test(rawSha256 ?? '')) throw new TypeError('deletePrevCopy requires { id, rawSha256 }');
    try {
      const current = storage.get(PREV_KEY);
      if (current === null) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'prevCopy', reason: 'absent' };
      const c = await checkPrevText(current);
      if (!c.valid || c.copy.id !== id || c.copy.rawSha256 !== rawSha256) {
        return { ok: false, code: 'EXTERNAL_CHANGE', key: 'prevCopy', reason: 'different' };
      }
      // No await between this re-read and the remove: the window is as small as possible.
      if (storage.get(PREV_KEY) !== current) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'prevCopy', reason: 'different' };
      storage.remove(PREV_KEY);
      if (storage.get(PREV_KEY) !== null) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'prevCopy', reason: 'reappeared' };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true };
  }

  // ---- input draft (Step 2d.0) ------------------------------------------------------------------
  // Synchronous by design: a value typed on screen reaches storage before any lifecycle event.
  // Compare-and-set within one synchronous call (no await): the write happens only if the stored
  // text is still `expectedRaw` (null = absent). Cross-window races are the documented SKX10 limit.

  /** @returns {{ok:true, raw:string|null} | storage failure} */
  function getInputDraft() {
    try {
      return { ok: true, raw: storage.get(INPUT_KEY) };
    } catch (err) {
      return storageFailure(err);
    }
  }

  /** Writes the draft text if the stored text is still expectedRaw; reads it back. */
  function putInputDraft(raw, expectedRaw) {
    if (typeof raw !== 'string' || raw.length > INPUT_DRAFT_MAX_CHARS) throw new TypeError(`input draft must be a string of at most ${INPUT_DRAFT_MAX_CHARS} characters`);
    try {
      if (storage.get(INPUT_KEY) !== expectedRaw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'inputDraft' };
      storage.set(INPUT_KEY, raw);
      if (storage.get(INPUT_KEY) !== raw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'inputDraft' };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true, raw };
  }

  /** Removes the draft only if it is still exactly expectedRaw (never a newer draft). */
  function removeInputDraft(expectedRaw) {
    if (typeof expectedRaw !== 'string') throw new TypeError('expectedRaw must be the draft text that was read');
    try {
      if (storage.get(INPUT_KEY) !== expectedRaw) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'inputDraft' };
      storage.remove(INPUT_KEY);
      if (storage.get(INPUT_KEY) !== null) return { ok: false, code: 'EXTERNAL_CHANGE', key: 'inputDraft' };
    } catch (err) {
      return storageFailure(err);
    }
    return { ok: true };
  }

  /** Characters per GymLog key (storage-usage report for banner E). Reads only. */
  function usage() {
    try {
      const keys = storage.keys().filter((k) => k.startsWith('gymlog')).sort();
      return { ok: true, keys: keys.map((key) => ({ key, chars: (storage.get(key) ?? '').length })) };
    } catch (err) {
      return storageFailure(err);
    }
  }

  return Object.freeze({
    getInputDraft,
    putInputDraft,
    removeInputDraft,
    usage,
    getLegacy,
    putLegacy,
    listLegacy,
    getProof,
    putProof,
    deleteProof,
    getPrevCopy,
    putPrevCopy,
    confirmPrevCopy,
    deletePrevCopy,
  });
}
