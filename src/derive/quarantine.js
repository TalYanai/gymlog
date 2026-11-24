// Quarantine listing for the report and Manage (UI-QV4). A Q-REMOVED entry created during an edit
// conflict is 'unverified_conflict': it preserves the active-workout content captured before removal
// and is never presented as verified against the original. Q-IMPORT entries carry no verification.
import { QUARANTINE_REASONS } from '../schema/constants.js';

export function quarantineVerification(entry) {
  if (!QUARANTINE_REASONS.removed.includes(entry?.reason)) return null;
  return entry.context?.verifiedAgainstOriginal === true ? 'verified_against_original' : 'unverified_conflict';
}

export function listQuarantine(store) {
  return store.quarantine.map((q) => ({
    id: q.id,
    reason: q.reason,
    kind: QUARANTINE_REASONS.removed.includes(q.reason) ? 'removed_performance' : 'import',
    importId: q.importId,
    verification: quarantineVerification(q),
    sessionId: q.context?.sessionId ?? null,
    performanceId: q.context?.performanceId ?? null,
  }));
}
