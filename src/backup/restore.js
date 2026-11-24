// Restore (Step 2c.8, design "C"): builds the restored store in memory. Writes nothing; the write
// sequence R1–R6 (previous copy, legacy snapshots, replaceStore, markImportVerified) is in the
// application layer.

import { validateStore } from '../schema/validate.js';

const sumPerf = (sessions) => sessions.reduce((n, s) => n + s.performances.length, 0);
const sumSets = (sessions) => sessions.reduce((n, s) => n + s.performances.reduce((m, p) => m + p.sets.length, 0), 0);

/**
 * Full replacement only. Revision = max(current, backup) + 1 (a new complete backup is then required).
 * The backup's protected values (lastBackup*, userVerifiedAt) are kept as history (R4-5).
 * @param {object} a
 * @param {object} a.data            verified backup data (parseBackup().data)
 * @param {object} a.envelope        the verified envelope
 * @param {string} a.sourceSha256    SHA-256 of the backup file bytes
 * @param {number|null} a.currentRevision  null when the current store is absent or invalid
 * @param {string[]} a.missingAtRestore  required legacy hashes that will NOT be available after the
 *   restore (computed by the caller before any write: required − valid backup snapshots − valid keys
 *   already on the device). One RESTORE_INCOMPLETE warning per hash; the envelope's own claim is not used.
 */
export async function buildRestoredStore({ data, envelope, sourceSha256, currentRevision, restoreId, importId, now, prevCopyExists, missingAtRestore }) {
  if (!Array.isArray(missingAtRestore)) throw new TypeError('buildRestoredStore requires missingAtRestore');
  const next = structuredClone(data);
  next.meta.dataRevision = Math.max(currentRevision ?? 0, data.meta.dataRevision) + 1;
  next.meta.updatedAt = now;
  const warnings = [];
  for (const sha of [...new Set(missingAtRestore)].sort()) warnings.push({ code: 'RESTORE_INCOMPLETE', ref: sha });
  next.meta.importLog.push({
    importId,
    kind: 'backup_restore',
    status: 'pending',
    at: now,
    reportSeenAt: null,
    sourceSha256,
    packageSha256: null,
    counts: { sessions: next.sessions.length, performances: sumPerf(next.sessions), sets: sumSets(next.sessions), quarantined: next.quarantine.length },
    unresolvedExercises: [],
    warnings,
    calculationChanges: [],
    restoreId,
    backupDataSha256: envelope.dataSha256,
    sourceUnsavedState: envelope.unsavedState,
    prevCopyExists,
  });
  const v = await validateStore(next);
  if (!v.valid) return { ok: false, code: 'RESULT_INVALID', errors: v.errors };
  return { ok: true, store: next };
}
