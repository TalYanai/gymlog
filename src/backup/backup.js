// Backups (Step 2c.7): create, parse/verify, prove an export, re-attach a missing source file.
// Pure apart from the injected `readLegacy`; nothing here writes storage. `recordBackup` is the
// caller's, and only after the file was really saved (Phase 2a §C).
//
// Envelope (approved, plus the R2-9 completeness fields):
//   { format, formatVersion: 1, schemaVersion: 2, exportedAt, appVersion, dataRevision, unsavedState,
//     legacyComplete, missingLegacySnapshots, data, dataSha256, legacySnapshots: [{ sha256, capturedAt, raw }] }
// dataSha256 = SHA-256 of canonical(data). legacySnapshots hold the raw v1 text byte-exactly (D13).

import { FORMATS, SCHEMA_VERSION, QUARANTINE_REASONS } from '../schema/constants.js';
import { canonicalSha256, sha256Hex } from '../schema/canonical.js';
import { validateStore, isIsoTimestamp } from '../schema/validate.js';
import { decodeSource, identifyFile } from '../import/source-bytes.js';

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const V1_KINDS = ['v1_migration', 'v1_late_import'];
const ENVELOPE_FIELDS = ['format', 'formatVersion', 'schemaVersion', 'exportedAt', 'appVersion', 'dataRevision', 'unsavedState', 'legacyComplete', 'missingLegacySnapshots', 'data', 'dataSha256', 'legacySnapshots'];

/**
 * Every legacy snapshot (raw v1 source) the data refers to — the required set R of a backup.
 * Sources, each only when it is a valid 64-hex hash of a v1 origin:
 *   1. meta.importLog[].sourceSha256 of v1_migration / v1_late_import entries;
 *   2. sessions[].provenance.snapshotSha256 of v1-origin sessions;
 *   3. Q-REMOVED quarantine entries: context.sessionProvenance.snapshotSha256 when context.sessionOrigin is v1;
 *   4. activeSession.session.provenance.snapshotSha256 when that session's origin is v1 (edit of a v1 session).
 * Not included: Q-IMPORT raw values, CSV hashes, backup_restore source hashes, proof / previous-copy keys.
 *
 * `importIds` lists only the import-log entries whose OWN sourceSha256 is this hash (the imports
 * that "use" the snapshot). A provenance or quarantine reference never associates its importId
 * with a different hash; such references are reported separately in `referencedBy`.
 * @returns {{sha256:string, importIds:string[], referencedBy:{importLog:number, sessions:number, quarantine:number, activeSession:number}}[]}
 */
export function referencedLegacy(store) {
  const out = new Map();
  const entry = (sha) => {
    if (!out.has(sha)) out.set(sha, { importIds: new Set(), referencedBy: { importLog: 0, sessions: 0, quarantine: 0, activeSession: 0 } });
    return out.get(sha);
  };
  const add = (sha, kind) => {
    if (typeof sha === 'string' && HEX64.test(sha)) entry(sha).referencedBy[kind]++;
  };
  for (const e of store.meta?.importLog ?? []) {
    if (!V1_KINDS.includes(e?.kind) || typeof e.sourceSha256 !== 'string' || !HEX64.test(e.sourceSha256)) continue;
    add(e.sourceSha256, 'importLog');
    entry(e.sourceSha256).importIds.add(e.importId);
  }
  for (const s of store.sessions ?? []) if (V1_KINDS.includes(s?.origin)) add(s.provenance?.snapshotSha256, 'sessions');
  for (const q of store.quarantine ?? []) {
    if (QUARANTINE_REASONS.removed.includes(q?.reason) && V1_KINDS.includes(q?.context?.sessionOrigin)) add(q.context.sessionProvenance?.snapshotSha256, 'quarantine');
  }
  const a = store.activeSession?.session;
  if (a && V1_KINDS.includes(a.origin)) add(a.provenance?.snapshotSha256, 'activeSession');
  return [...out.keys()].sort().map((sha256) => ({ sha256, importIds: [...out.get(sha256).importIds].sort(), referencedBy: out.get(sha256).referencedBy }));
}

const ymd = (iso) => iso.slice(0, 10);

/**
 * @param {object} a
 * @param {{store:object, unsaved:boolean, stale:boolean}} a.exported  the Store's exportCurrentState()
 * @param {(sha:string) => Promise<object>} a.readLegacy  side-keys getLegacy
 * @param {string} a.now  ISO timestamp
 * @param {boolean} [a.partial]  explicit partial backup (R2-9)
 * @returns {Promise<{ok:true, envelope, json, fileName, complete:boolean, missing:string[]}
 *   | {ok:false, code:'BACKUP_SNAPSHOT_MISSING', missing:{sha256, importIds}[]} | {ok:false, code:'IMPORT_PENDING'|'STORAGE_READ_FAILED'}>}
 */
export async function createBackup({ exported, readLegacy, now, appVersion, partial = false }) {
  const data = structuredClone(exported.store);
  delete data.sync; // device-local sync state is never part of a backup
  if (data.meta.importLog.some((e) => e.status === 'pending')) return { ok: false, code: 'IMPORT_PENDING' };
  const refs = referencedLegacy(data);
  const snapshots = [];
  const missing = [];
  for (const r of refs) {
    const got = await readLegacy(r.sha256);
    if (!got.ok) return { ok: false, code: got.code ?? 'STORAGE_READ_FAILED' };
    if (got.present && got.hashValid) {
      const first = data.meta.importLog.filter((e) => e.sourceSha256 === r.sha256).map((e) => e.at).sort()[0];
      snapshots.push({ sha256: r.sha256, capturedAt: first ?? now, raw: got.raw });
    } else missing.push(r);
  }
  if (missing.length && partial !== true) return { ok: false, code: 'BACKUP_SNAPSHOT_MISSING', missing };
  const unsavedState = exported.unsaved === true || exported.stale === true;
  const envelope = {
    format: FORMATS.backup,
    formatVersion: FORMATS.backupVersion,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    appVersion,
    dataRevision: data.meta.dataRevision,
    unsavedState,
    legacyComplete: missing.length === 0,
    missingLegacySnapshots: missing.map((m) => m.sha256),
    data,
    dataSha256: await canonicalSha256(data),
    legacySnapshots: snapshots,
  };
  const fileName = unsavedState ? `gymlog-unsaved-state-${ymd(now)}.json` : missing.length ? `gymlog-backup-partial-${ymd(now)}.json` : `gymlog-backup-${ymd(now)}.json`;
  return { ok: true, envelope, json: JSON.stringify(envelope), fileName, complete: missing.length === 0, missing: missing.map((m) => m.sha256) };
}

/**
 * Parses and verifies a backup file from its bytes. Writes nothing.
 * @returns {Promise<{ok:true, envelope, data, sourceSha256, text, goodSnapshots, rejectedSnapshots}
 *   | {ok:false, code, ...}>}
 */
export async function parseBackup(bytes) {
  const dec = await decodeSource(bytes);
  if (!dec.ok) return dec;
  const id = identifyFile(dec.text);
  if (id.kind === 'unsupported_backup') return { ok: false, code: 'BACKUP_UNSUPPORTED', formatVersion: id.formatVersion, schemaVersion: id.schemaVersion };
  if (id.kind === 'not_json') return { ok: false, code: 'SOURCE_NOT_JSON' };
  if (id.kind !== 'gymlog_backup') return { ok: false, code: 'FILE_UNKNOWN', kind: id.kind };
  const env = id.parsed;
  const problem = (message) => ({ ok: false, code: 'BACKUP_INTEGRITY', message });
  if (!isObj(env) || Object.keys(env).length !== ENVELOPE_FIELDS.length || !ENVELOPE_FIELDS.every((k) => k in env)) return problem('unexpected envelope fields');
  if (!isIsoTimestamp(env.exportedAt) || typeof env.appVersion !== 'string' || typeof env.unsavedState !== 'boolean' || typeof env.legacyComplete !== 'boolean') return problem('invalid envelope values');
  if (!Array.isArray(env.missingLegacySnapshots) || !Array.isArray(env.legacySnapshots)) return problem('invalid snapshot lists');
  let dataHash;
  try {
    dataHash = await canonicalSha256(env.data);
  } catch {
    return problem('data cannot be canonicalized');
  }
  if (dataHash !== env.dataSha256) return problem('dataSha256 does not match the data (damaged or edited)');
  if (!isObj(env.data) || !isObj(env.data.meta) || env.dataRevision !== env.data.meta.dataRevision) return problem('dataRevision does not match data.meta.dataRevision');
  const v = await validateStore(env.data);
  if (!v.valid) return { ok: false, code: 'RESULT_INVALID', errors: v.errors };
  if (env.data.meta.importLog.some((e) => e.status === 'pending')) return { ok: false, code: 'RESULT_INVALID', errors: [{ code: 'BACKUP_PENDING', path: '$.data.meta.importLog', message: 'a backup cannot contain a pending import' }] };

  // ---- legacy snapshot relationships: L ∪ M = R, L ∩ M = ∅ (identity checks → BACKUP_INTEGRITY) ----
  const required = new Set(referencedLegacy(env.data).map((r) => r.sha256));
  const M = env.missingLegacySnapshots;
  if (!M.every((h) => typeof h === 'string' && HEX64.test(h))) return problem('missingLegacySnapshots must contain 64-hex hashes only');
  if (new Set(M).size !== M.length) return problem('duplicate hash in missingLegacySnapshots');
  if (!M.every((h) => required.has(h))) return problem('missingLegacySnapshots lists a hash the data does not reference');
  const L = [];
  for (const s of env.legacySnapshots) {
    if (!isObj(s) || Object.keys(s).length !== 3 || !['sha256', 'capturedAt', 'raw'].every((k) => k in s)) return problem('legacySnapshots entries must be exactly { sha256, capturedAt, raw }');
    if (typeof s.sha256 !== 'string' || !HEX64.test(s.sha256)) return problem('legacySnapshots entry with an invalid sha256');
    L.push(s.sha256);
  }
  if (new Set(L).size !== L.length) return problem('duplicate hash in legacySnapshots');
  if (!L.every((h) => required.has(h))) return problem('legacySnapshots contains a snapshot the data does not reference');
  if (L.some((h) => M.includes(h))) return problem('a hash is both included and declared missing');
  if (L.length + M.length !== required.size) return problem('a referenced snapshot is neither included nor declared missing');
  if (env.legacyComplete !== (M.length === 0)) return problem('legacyComplete does not match missingLegacySnapshots');

  // ---- content checks (RS4): a required snapshot with bad content is rejected alone; the restore continues ----
  const goodSnapshots = [];
  const rejectedSnapshots = [];
  for (const s of env.legacySnapshots) {
    const contentOk = typeof s.raw === 'string' && isIsoTimestamp(s.capturedAt) && (await sha256Hex(s.raw)) === s.sha256;
    if (contentOk) goodSnapshots.push({ sha256: s.sha256, raw: s.raw });
    else rejectedSnapshots.push(s.sha256);
  }
  return { ok: true, envelope: env, data: env.data, sourceSha256: dec.sha256, text: dec.text, required: [...required].sort(), goodSnapshots, rejectedSnapshots };
}

/**
 * Proof of a pre-restore export (Revision 2 "C"): the user re-selects the saved file and its bytes
 * are checked. Opening or finishing the share sheet proves nothing.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{kind:'store', dataSha256:string, unsavedState:boolean} | {kind:'raw', rawSha256:string}} expected
 */
export async function verifyExportFile(bytes, expected) {
  if (expected.kind === 'raw') {
    const dec = await decodeSource(bytes);
    return dec.ok && dec.sha256 === expected.rawSha256 ? { ok: true } : { ok: false, code: 'EXPORT_NOT_PROVEN' };
  }
  const p = await parseBackup(bytes);
  if (!p.ok) return { ok: false, code: 'EXPORT_NOT_PROVEN', reason: p.code };
  if (p.envelope.dataSha256 !== expected.dataSha256 || p.envelope.unsavedState !== expected.unsavedState) return { ok: false, code: 'EXPORT_NOT_PROVEN', reason: 'different_data' };
  return { ok: true };
}
