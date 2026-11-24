// Typed-value buffer (Step 2d.0; used by the logging screens from 2d.3).
//
// Two layers (approved plan, D-input):
//  1. Every keystroke is written SYNCHRONOUSLY into the tiny side key gymlog.v2.input
//     (app.writeInputDraft), before any lifecycle event can happen.
//  2. The main store is written by a commit of the pending values of one set: after the debounce,
//     when the user moves to another set, on ✓ (values + completion in ONE commit), and on
//     flushAll() (route change, visibilitychange → hidden, pagehide — best effort only).
//
// Rules (clarification 1):
//  - Several sets and several fields can be pending at once; each keeps its own value and rev.
//  - Moving to another set flushes the previous set at once; nothing pending is dropped.
//  - After a successful commit only the fields whose rev did not change since the commit started
//    are cleared (from memory and from the draft); a newer keystroke stays pending.
//  - A failed draft write is reported (protection: 'failed'); the value stays in memory and the
//    commit still runs — it is never presented as protected.
//  - A failed commit keeps everything (memory and draft).
import { draftKey, emptyDraft, mergeDraftField, clearDraftFields, maxRev, planDraftRecovery } from '../core/input-draft.js';
import { parseFieldInput } from './input-parse.js';

/**
 * @param {object} deps
 * @param {object} deps.app             facade (readInputDraft / writeInputDraft / clearInputDraft)
 * @param {(identity, values, opts) => Promise<object>} deps.commitSet  actions.commitSetValues
 * @param {number} [deps.debounceMs]
 * @param {{set: Function, clear: Function}} [deps.timers]
 * @param {() => string} [deps.now]
 * @param {(state) => void} [deps.onState]  called after every state change (UI status)
 */
export function createInputBuffer({ app, commitSet, debounceMs = 700, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) } /* wrapped: browsers refuse setTimeout called as a method of another object */, now = () => new Date().toISOString(), onState = () => {} }) {
  const pending = new Map(); // key → { identity, fields: Map(field → { text, rev }) }
  const timerOf = new Map();
  let activeKey = null;
  let saving = 0;
  let protection = { state: 'ok', code: null };
  const initial = app.readInputDraft();
  let counter = initial.ok && initial.doc ? maxRev(initial.doc) : 0;

  const state = () => ({ saving, protection: { ...protection }, pendingFields: [...pending.values()].reduce((n, p) => n + p.fields.size, 0) });
  const emit = () => onState(state());

  /** Layer 1: synchronous draft write. Returns true only when the keystroke is in storage. */
  function writeDraft(identity, field, text, base, rev) {
    const r = app.readInputDraft();
    if (!r.ok) return fail(r.code);
    if (r.raw !== null && !r.doc) return fail('INPUT_DRAFT_INVALID'); // an unreadable draft is never overwritten
    const doc = mergeDraftField(r.doc ?? emptyDraft(), { ...identity, field, text, base, rev, at: now() });
    const w = app.writeInputDraft(doc, { expectedRaw: r.raw });
    if (!w.ok) return fail(w.code);
    protection = { state: 'ok', code: null };
    return true;
  }
  function fail(code) {
    protection = { state: 'failed', code: code ?? 'STORAGE_WRITE_FAILED' };
    return false;
  }

  /** Removes committed fields from the draft (only where rev is unchanged). */
  function clearDraft(key, revs) {
    const r = app.readInputDraft();
    if (!r.ok || !r.doc) return;
    const { doc, removed } = clearDraftFields(r.doc, key, revs);
    if (removed.length === 0) return;
    const w = doc.entries.length === 0 ? app.clearInputDraft(r.raw) : app.writeInputDraft(doc, { expectedRaw: r.raw });
    if (!w.ok) protection = { state: 'failed', code: w.code };
  }

  /**
   * One keystroke in a set field. `base` is the committed value of that field (used only for the
   * first pending keystroke). Returns { protected } — false means the value is in memory only.
   */
  function type(identity, field, text, base) {
    const key = draftKey(identity);
    if (activeKey !== null && activeKey !== key && pending.has(activeKey)) flush(activeKey);
    activeKey = key;
    const rev = ++counter;
    if (!pending.has(key)) pending.set(key, { identity: { ...identity }, fields: new Map() });
    pending.get(key).fields.set(field, { text: String(text), rev });
    const ok = writeDraft(identity, field, String(text), base, rev);
    if (timerOf.has(key)) timers.clear(timerOf.get(key));
    timerOf.set(key, timers.set(() => flush(key), debounceMs));
    emit();
    return { protected: ok };
  }

  /** Commits the pending values of one set (plus completion, if given) in one commit. */
  async function flush(key, { completed } = {}) {
    if (timerOf.has(key)) {
      timers.clear(timerOf.get(key));
      timerOf.delete(key);
    }
    const p = pending.get(key);
    if (!p && completed === undefined) return { ok: true, outcome: 'unchanged' };
    const captured = p ? [...p.fields.entries()].map(([field, v]) => ({ field, ...v })) : [];
    const values = {};
    const revs = {};
    const invalid = [];
    for (const c of captured) {
      const parsed = parseFieldInput(c.field, c.text);
      if (!parsed.ok) {
        invalid.push(c.field);
        continue;
      }
      values[c.field] = parsed.value;
      revs[c.field] = c.rev;
    }
    if (Object.keys(values).length === 0 && completed === undefined) {
      emit();
      return { ok: false, code: 'INPUT_INVALID', invalid };
    }
    const identity = p ? p.identity : parseKey(key);
    saving += 1;
    emit();
    let r;
    try {
      r = await commitSet(identity, values, completed === undefined ? {} : { completed });
    } finally {
      saving -= 1;
    }
    if (r.outcome === 'saved' || r.outcome === 'unchanged') {
      const still = pending.get(key);
      if (still) {
        for (const [f, rev] of Object.entries(revs)) if (still.fields.get(f)?.rev === rev) still.fields.delete(f);
        if (still.fields.size === 0) pending.delete(key);
      }
      clearDraft(key, revs);
    }
    emit();
    return invalid.length ? { ...r, invalid } : r;
  }

  /** ✓: the set's pending values and its completion in ONE commit. */
  const complete = (identity, completed = true) => flush(draftKey(identity), { completed });

  /** Lifecycle / route change: commit everything pending (best effort; the draft already holds it). */
  const flushAll = () => Promise.all([...pending.keys()].map((k) => flush(k)));

  // ---- recovery on launch (applied by the UI from 2d.3; nothing is applied silently) ----------------

  /** Items of a draft found at launch, with their status (see planDraftRecovery). */
  function planRecovery(store) {
    const r = app.readInputDraft();
    if (!r.ok) return { ok: false, code: r.code };
    if (r.raw === null) return { ok: true, items: [] };
    if (!r.doc) return { ok: true, items: [], unreadable: { raw: r.raw, problem: r.problem } };
    return { ok: true, items: planDraftRecovery(store, r.doc, parseFieldInput) };
  }

  /**
   * Writes chosen recovered values (status 'apply', or a 'conflict' the user resolved as "use typed")
   * — one commit per set — and then clears exactly those draft fields.
   */
  async function applyRecovered(items) {
    const results = [];
    for (const [key, group] of groupByKey(items)) {
      const values = {};
      const revs = {};
      for (const it of group) {
        if (!['apply', 'conflict'].includes(it.status)) throw new RangeError(`cannot apply a ${it.status} item`);
        values[it.field] = it.value;
        revs[it.field] = it.rev;
      }
      const r = await commitSet(parseKey(key), values, {});
      if (r.outcome === 'saved' || r.outcome === 'unchanged') clearDraft(key, revs);
      results.push({ key, ...r });
    }
    emit();
    return results;
  }

  /** Removes items from the draft without applying them ('already', 'orphan', or a kept-saved choice). */
  function dismissRecovered(items) {
    for (const [key, group] of groupByKey(items)) clearDraft(key, Object.fromEntries(group.map((it) => [it.field, it.rev])));
    emit();
  }

  /**
   * Drops pending values and draft fields of the sets that match — ONLY after the user explicitly
   * removed those sets or cancelled their workout (never as a side effect).
   * @param {(identity) => boolean} match
   */
  function discard(match) {
    for (const [key, p] of [...pending]) {
      if (!match(p.identity)) continue;
      if (timerOf.has(key)) {
        timers.clear(timerOf.get(key));
        timerOf.delete(key);
      }
      pending.delete(key);
    }
    const r = app.readInputDraft();
    if (r.ok && r.doc) {
      for (const e of r.doc.entries) {
        if (!match(e)) continue;
        clearDraft(draftKey(e), Object.fromEntries(Object.entries(e.fields).map(([f, x]) => [f, x.rev])));
      }
    }
    if (activeKey !== null && !pending.has(activeKey)) activeKey = null;
    emit();
  }

  return Object.freeze({
    discardSet: (identity) => discard((x) => draftKey(x) === draftKey(identity)),
    discardPerformance: (sessionId, performanceId) => discard((x) => x.sessionId === sessionId && x.performanceId === performanceId),
    discardSession: (sessionId) => discard((x) => x.sessionId === sessionId),
    pendingFor: (sessionId) => [...pending.values()].filter((p) => p.identity.sessionId === sessionId).reduce((n, p) => n + p.fields.size, 0),
    planRecovery,
    applyRecovered,
    dismissRecovered,
    type,
    flush: (identity) => flush(draftKey(identity)),
    complete,
    flushAll,
    pendingText: (identity, field) => pending.get(draftKey(identity))?.fields.get(field)?.text,
    state,
  });
}

function parseKey(key) {
  const [sessionId, performanceId, setId] = key.split('|');
  return { sessionId, performanceId, setId };
}

function groupByKey(items) {
  const m = new Map();
  for (const it of items) {
    if (!m.has(it.key)) m.set(it.key, []);
    m.get(it.key).push(it);
  }
  return m;
}
