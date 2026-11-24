// Commit-time transition rules (Phase 2b design: TR-P1b, TR-P1e, TR-PP6 / QM, TR-QV1–QV3,
// edit-conflict rules, TR-CANCEL, TR-SAVENEW; write-boundary remediation A, B1–B4, D8).
// validateStore checks every STATE invariant; these rules need the previous store and are checked on
// every user-data commit (Store.commit) and on the dedicated late-import write (Store.appendLateImport).
//
// checkTransition(prev, next, auth) → null when allowed, or { code, message } (the write is refused).
// Pure and synchronous; it never modifies either store. Every rule compares the complete previous
// store with the complete candidate, so the order of changes inside a mutator does not matter.
//
// `auth` is null for an ordinary commit. Only Store.appendLateImport passes
// { lateImport: { entry, sessionIds, quarantineIds } }, built inside the Store from additions it has
// already checked. Calling this function never writes anything, so exporting it grants nothing.
//
// Rules (ordinary commit):
//   A1  meta.importLog is unchanged (no add, edit, delete, reorder or replacement).
//   A2  no exemption from TR-P1b for imported sessions (the late-import exemption needs `auth`).
//   A3  a session added by a commit has origin "app", except the recovered copy of TR-SAVENEW; origin
//       and provenance of an existing session never change.
//   B1  a saved session with a protected performance is never removed.
//   B2  a protected performance stays identical (excluding `order`, as in PP6).
//   B3  a protected performance leaves its saved session only when an edit of that session (no
//       conflict) is finalized, it was already removed from the active copy (TR-PP6 / QM required a
//       new verified entry then), and exactly one verified Q-REMOVED entry holds the original.
//   R1  (2d.0 follow-up) `recovery` of an existing session never changes; a new session may carry a
//       non-null `recovery` only as the TR-SAVENEW copy (edit conflict, active workout saved as new);
//       that copy is exactly the previous active session apart from new IDs, `recovery` and updatedAt.
//   R2  (2d.0 follow-up) no saved session is removed by an ordinary commit (SESSION_REMOVED). Restore
//       and late import are separate write paths; workout deletion will need its own operation.
//   B4  quarantine only grows: existing entries are unchanged, in place; a new entry must be the one a
//       removal in this same commit consumed (TR-PP6 / QM).
//   D8  an unresolved exercise, or an exercise a protected performance references, is unchanged.
// A protected performance is a performance of a saved session in `prev` that references an unresolved
// exercise in `prev` (snapshot or catalog), so changing the exercise in the same commit cannot unprotect it.

import { canonicalize } from '../schema/canonical.js';
import { QUARANTINE_REASONS } from '../schema/constants.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => {
  try {
    return canonicalize(v);
  } catch {
    return null;
  }
};
const withoutOrder = (perf) => {
  if (!isObj(perf)) return perf;
  const { order, ...rest } = perf;
  return rest;
};
const fail = (code, message) => ({ code, message });
/** A session without the fields TR-SAVENEW changes: its IDs (performances and sets by position), recovery, updatedAt. */
function copyContent(s) {
  if (!isObj(s)) return s;
  const { id, recovery, updatedAt, performances, ...rest } = s;
  return {
    ...rest,
    performances: arr(performances).map((p) => {
      if (!isObj(p)) return p;
      const { id: pid, sets, ...prest } = p;
      return { ...prest, sets: arr(sets).map((x) => {
        if (!isObj(x)) return x;
        const { id: xid, ...xrest } = x;
        return xrest;
      }) };
    }),
  };
}
const arr = (v) => (Array.isArray(v) ? v : []);

/** Edit-conflict state of an active session against a store's saved sessions (INV-PP2, redefined). */
export function editConflict(store) {
  const a = store?.activeSession;
  if (!isObj(a) || a.mode !== 'edit') return null;
  const original = arr(store.sessions).find((s) => s?.id === a.editsSessionId);
  if (!original) return 'target_missing';
  if (original.updatedAt !== a.baseUpdatedAt) return 'target_changed';
  return null;
}

function exerciseIsUnresolved(store, perf) {
  if (perf?.measurement?.type === 'unresolved') return true;
  return arr(store.exercises).find((e) => e?.id === perf?.exerciseId)?.measurement?.type === 'unresolved';
}

/** Every performance in saved sessions and the active session: Map key → { perf, session }. */
function performanceIndex(store) {
  const out = new Map();
  for (const s of arr(store.sessions)) for (const p of arr(s?.performances)) if (isObj(p)) out.set(`saved:${p.id}`, { perf: p, session: s });
  const a = store.activeSession?.session;
  if (a) for (const p of arr(a.performances)) if (isObj(p)) out.set(`active:${p.id}`, { perf: p, session: a });
  return out;
}
const knownIds = (store) => {
  const ids = new Set();
  for (const k of performanceIndex(store).keys()) ids.add(k.slice(k.indexOf(':') + 1));
  return ids;
};
function prevSetIds(store) {
  const ids = new Set();
  for (const { perf } of performanceIndex(store).values()) for (const s of arr(perf.sets)) ids.add(s?.id);
  return ids;
}

const isRemovedEntry = (q) => QUARANTINE_REASONS.removed.includes(q?.reason);

/** Protected performances of saved sessions in `store`: Map sessionId → protected performances. */
function protectedBySession(store) {
  const out = new Map();
  for (const s of arr(store.sessions)) {
    const list = arr(s?.performances).filter((p) => isObj(p) && exerciseIsUnresolved(store, p));
    if (list.length) out.set(s.id, list);
  }
  return out;
}

/**
 * @param {object} prev  the store before the write (in memory)
 * @param {object} next  the candidate store
 * @param {null | {lateImport: {entry:object, sessionIds:Set<string>, quarantineIds:Set<string>}}} [auth]
 */
export function checkTransition(prev, next, auth = null) {
  const late = auth?.lateImport ?? null;
  const prevLog = arr(prev.meta?.importLog);
  const nextLog = arr(next.meta?.importLog);

  // ---- A1: importLog ------------------------------------------------------------------------------
  if (!late) {
    if (canon(prevLog) !== canon(nextLog)) return fail('IMPORT_LOG_PROTECTED', 'the import log cannot be changed by an ordinary write');
  } else if (nextLog.length !== prevLog.length + 1 || canon(nextLog.slice(0, prevLog.length)) !== canon(prevLog) || canon(nextLog.at(-1)) !== canon(late.entry)) {
    return fail('IMPORT_LOG_PROTECTED', 'a late import appends exactly its own entry');
  }

  const pa = prev.activeSession;
  const na = next.activeSession;
  const prevConflict = editConflict(prev);
  const prevSessionIds = new Set(arr(prev.sessions).map((s) => s?.id));
  const prevById = new Map(arr(prev.sessions).map((s) => [s?.id, s]));
  // The TR-SAVENEW copy exists only in the commit that resolves the conflict (active workout → null).
  const isRecoveredCopy = (s) => isObj(s?.recovery) && isObj(pa) && pa.mode === 'edit' && !!prevConflict && na === null && s.recovery.recoveredFromSessionId === pa.editsSessionId;

  // ---- A3: origin and provenance --------------------------------------------------------------------
  for (const s of arr(next.sessions)) {
    if (!isObj(s)) continue;
    const before = prevById.get(s.id);
    if (before) {
      if (s.origin !== before.origin || canon(s.provenance ?? null) !== canon(before.provenance ?? null)) return fail('ORIGIN_PROTECTED', `origin and provenance of ${s.id} cannot change`);
    } else if (typeof s.origin === 'string' && s.origin !== 'app' && !(late && late.sessionIds.has(s.id)) && !isRecoveredCopy(s)) {
      return fail('ORIGIN_PROTECTED', `a new session (${s.id}) must have origin "app"`);
    }
  }

  // ---- TR-P1b / TR-P1e: no NEW reference to an unresolved exercise ------------------------------
  // A2: the only exemption is the imported history appended by Store.appendLateImport (INV-P1c).
  const prevIds = knownIds(prev);
  const prevByKey = performanceIndex(prev);
  for (const [key, { perf, session }] of performanceIndex(next)) {
    const id = key.slice(key.indexOf(':') + 1);
    const before = prevByKey.get(key) ?? prevByKey.get(`saved:${id}`) ?? prevByKey.get(`active:${id}`);
    const importedNow = !!late && key.startsWith('saved:') && late.sessionIds.has(session.id);
    if (!exerciseIsUnresolved(next, perf) || importedNow) continue;
    if (!prevIds.has(id)) return fail('UNRESOLVED_EXERCISE', `new performance ${id} references an unresolved exercise`);
    if (before && before.perf.exerciseId !== perf.exerciseId) return fail('UNRESOLVED_EXERCISE', `performance ${id} was changed to an unresolved exercise`);
  }

  // ---- D8: unresolved exercise definitions ------------------------------------------------------------
  const protectedPrev = protectedBySession(prev);
  const guardedExercises = new Set(arr(prev.exercises).filter((e) => e?.measurement?.type === 'unresolved').map((e) => e.id));
  for (const list of protectedPrev.values()) for (const p of list) guardedExercises.add(p.exerciseId);
  const nextExercises = new Map(arr(next.exercises).map((e) => [e?.id, e]));
  for (const e of arr(prev.exercises)) {
    if (!guardedExercises.has(e?.id)) continue;
    const after = nextExercises.get(e.id);
    if (!after || canon(after) !== canon(e)) return fail('UNRESOLVED_EXERCISE_PROTECTED', `exercise ${e.id} (unresolved or used by a protected performance) cannot be changed or removed`);
  }

  // ---- B4 (part 1): existing quarantine entries are unchanged, in place ------------------------------
  const prevQ = arr(prev.quarantine);
  const nextQ = arr(next.quarantine);
  if (nextQ.length < prevQ.length || canon(nextQ.slice(0, prevQ.length)) !== canon(prevQ)) return fail('QUARANTINE_PROTECTED', 'existing quarantine entries cannot be changed or removed');
  const addedQ = nextQ.slice(prevQ.length);
  const consumed = new Set(); // new entries used by a removal in this write

  // ---- B1–B3: protected performances of saved sessions --------------------------------------------------
  const nextById = new Map(arr(next.sessions).map((s) => [s?.id, s]));
  for (const [sid, list] of protectedPrev) {
    const after = nextById.get(sid);
    if (!after) return fail('PROTECTED_SESSION_REMOVED', `session ${sid} contains an unresolved performance and cannot be removed`);
    for (const p of list) {
      const kept = arr(after.performances).find((x) => x?.id === p.id);
      if (kept) {
        if (canon(withoutOrder(kept)) !== canon(withoutOrder(p))) return fail('PRESERVED_PERFORMANCE_MODIFIED', `protected performance ${p.id}`);
        continue;
      }
      // B3: only when an edit of this session (no conflict) is finalized after an authorized removal.
      const finalizing = isObj(pa) && pa.mode === 'edit' && pa.editsSessionId === sid && !prevConflict && na === null;
      const removedEarlier = finalizing && !arr(pa.session?.performances).some((x) => x?.id === p.id);
      const holders = nextQ.filter((q) => isRemovedEntry(q) && q.context?.sessionId === sid && q.context?.performanceId === p.id && q.context?.verifiedAgainstOriginal === true && canon(q.raw) === canon(p));
      if (!removedEarlier || holders.length !== 1) return fail('PRESERVED_PERFORMANCE_REMOVED', `protected performance ${p.id} can leave session ${sid} only through quarantine during an edit`);
    }
  }

  // ---- edit rules (TR-PP6 / QM / QV, edit conflict, TR-CANCEL, TR-SAVENEW) -----------------------------
  const newRemoved = addedQ.filter(isRemovedEntry);
  /** A preserved performance removed from the active copy in THIS write needs exactly one new matching entry. */
  const authorizeRemoval = (pid, originalPerf, verified) => {
    const m = newRemoved.filter((q) => q.context?.sessionId === pa.editsSessionId && q.context?.performanceId === pid);
    if (m.length !== 1) return fail('QUARANTINE_MISMATCH', `removal of ${pid} needs exactly one new quarantine entry`);
    const q = m[0];
    if (q.context.verifiedAgainstOriginal !== verified) return fail('QUARANTINE_MISMATCH', `verifiedAgainstOriginal must be ${verified}`);
    if (canon(q.raw) === null || canon(q.raw) !== canon(originalPerf)) return fail('QUARANTINE_MISMATCH', `quarantined content of ${pid} is not the complete ${verified ? 'original' : 'active'} performance`);
    consumed.add(q.id);
    return null;
  };

  if (isObj(pa) && pa.mode === 'edit') {
    const original = arr(prev.sessions).find((s) => s.id === pa.editsSessionId);
    const preserved = Array.isArray(pa.preservedPerformanceIds) ? pa.preservedPerformanceIds : [];
    const prevActivePerf = new Map(arr(pa.session?.performances).map((p) => [p.id, p]));
    const sameEdit = isObj(na) && na.mode === 'edit' && na.editsSessionId === pa.editsSessionId;

    if (prevConflict) {
      // ---- edit conflict: the active workout may change only by quarantining preserved performances.
      if (sameEdit) {
        const nextIds = new Set(arr(na.session?.performances).map((p) => p.id));
        const removed = [...prevActivePerf.keys()].filter((id) => !nextIds.has(id));
        for (const id of removed) {
          if (!preserved.includes(id)) return fail('EDIT_CONFLICT', 'the active workout cannot be changed during an edit conflict');
          const r = authorizeRemoval(id, prevActivePerf.get(id), false);
          if (r) return r;
        }
        const strip = (a, drop) => ({ ...a, session: { ...a.session, performances: arr(a.session.performances).filter((p) => !drop.includes(p.id)).sort((x, y) => x.order - y.order).map(withoutOrder) } });
        if (canon(strip(pa, removed)) !== canon(strip(na, []))) return fail('EDIT_CONFLICT', 'the active workout cannot be changed during an edit conflict');
      } else if (na === null) {
        // Only cancel (TR-CANCEL) or save-as-new (TR-SAVENEW); existing sessions are untouched.
        const prevSessions = new Map(arr(prev.sessions).map((s) => [s.id, canon(s)]));
        const added = arr(next.sessions).filter((s) => !prevSessions.has(s.id));
        for (const s of arr(next.sessions)) if (prevSessions.has(s.id) && prevSessions.get(s.id) !== canon(s)) return fail('EDIT_CONFLICT', 'a saved session cannot be changed while resolving an edit conflict');
        if (arr(prev.sessions).some((s) => !arr(next.sessions).some((x) => x.id === s.id))) return fail('EDIT_CONFLICT', 'a saved session cannot be removed while resolving an edit conflict');
        const recovered = added.filter((s) => s.recovery?.recoveredFromSessionId === pa.editsSessionId);
        if (added.length > 1 || added.length !== recovered.length) return fail('EDIT_CONFLICT', 'only one recovered session may be added');
        if (recovered.length === 1) {
          const s = recovered[0];
          if (s.performances.some((p) => exerciseIsUnresolved(next, p))) return fail('UNRESOLVED_NOT_PRESERVED', 'move every unresolved performance to quarantine before saving as new');
          if (s.origin !== pa.session.origin || canon(s.provenance) !== canon(pa.session.provenance)) return fail('EDIT_CONFLICT', 'origin and provenance must be kept');
          if (s.recovery.conflictKind !== prevConflict) return fail('EDIT_CONFLICT', 'recovery.conflictKind must match the conflict');
          const oldIds = new Set([...prevIds, ...prevSessionIds]);
          const oldSets = prevSetIds(prev);
          if (oldIds.has(s.id) || s.performances.some((p) => oldIds.has(p.id) || p.sets.some((x) => oldIds.has(x.id) || oldSets.has(x.id)))) {
            return fail('EDIT_CONFLICT', 'a recovered session needs new IDs');
          }
          // R1: the copy is exactly the active workout (positions kept), apart from new IDs, recovery, updatedAt.
          if (canon(copyContent(s)) === null || canon(copyContent(s)) !== canon(copyContent(pa.session))) {
            return fail('EDIT_CONFLICT', 'the recovered session must be an exact copy of the active workout');
          }
        } else {
          // TR-CANCEL: every preserved performance must already exist as an identical copy.
          for (const id of preserved) {
            const p = prevActivePerf.get(id);
            if (!p) continue; // already moved to quarantine in an earlier commit
            const inSessions = arr(next.sessions).some((s) => s.performances.some((x) => canon(withoutOrder(x)) === canon(withoutOrder(p))));
            const inQuarantine = nextQ.filter(isRemovedEntry).some((q) => canon(q.raw) === canon(p));
            if (!inSessions && !inQuarantine) return fail('CANCEL_WOULD_LOSE_PRESERVED', `preserved performance ${id} has no copy`);
          }
        }
      } else return fail('EDIT_CONFLICT', 'the active workout cannot be replaced during an edit conflict');
    } else if (original && sameEdit) {
      // ---- no conflict: preserved performances leave the active copy only through a new, verified entry.
      const nextIds = new Set(arr(na.session?.performances).map((p) => p.id));
      for (const id of preserved) {
        if (prevActivePerf.has(id) && !nextIds.has(id)) {
          const r = authorizeRemoval(id, original.performances.find((p) => p.id === id), true);
          if (r) return r;
        }
      }
    }
    // Finalizing the edit (na === null, no conflict) is covered by B1–B3 above.
  }

  // ---- B4 (part 2): every new entry is accounted for --------------------------------------------------
  for (const q of addedQ) {
    if (consumed.has(q?.id) || (late && late.quarantineIds.has(q?.id))) continue;
    return fail('QUARANTINE_PROTECTED', `quarantine entry ${q?.id ?? '?'} can only be added by moving a preserved performance or by an import`);
  }

  // R1 and R2 come last, so every earlier rule keeps its refusal code.
  // ---- R1: the recovery marker --------------------------------------------------------------------------
  for (const s of arr(next.sessions)) {
    if (!isObj(s)) continue;
    const before = prevById.get(s.id);
    if (before) {
      if (canon(s.recovery ?? null) !== canon(before.recovery ?? null)) return fail('RECOVERY_PROTECTED', `the recovery marker of ${s.id} cannot change`);
    } else if (s.recovery !== null && s.recovery !== undefined && !isRecoveredCopy(s)) {
      return fail('RECOVERY_PROTECTED', `a new session (${s.id}) can carry a recovery marker only as the copy saved to resolve an edit conflict`);
    }
  }
  // ---- R2: saved sessions are not removed by an ordinary commit ----------------------------------------
  if (!late) {
    for (const s of arr(prev.sessions)) {
      if (isObj(s) && !nextById.has(s.id) && s.id !== auth?.deleteSessionId) return fail('SESSION_REMOVED', `saved session ${s.id} cannot be removed`);
    }
  }
  return null;
}
