// Input draft (Step 2d.0): typed-but-uncommitted set values, kept in the tiny side key
// gymlog.v2.input so that a value that appeared on screen survives an app kill before its commit.
//
// Pure functions over a plain document; storage access is the facade's (app.readInputDraft /
// writeInputDraft / clearInputDraft). The document is NOT part of the store or of backups.
//
//   { v: 1, entries: [ { sessionId, performanceId, setId,
//                        fields: { <field>: { text, base, rev, at } } } ] }
//
//   text  exactly what was typed (may be partial, e.g. "82." — parsed only when committed or recovered)
//   base  the COMMITTED value of that field when typing in it began (first pending keystroke)
//   rev   a number that increases with every keystroke written (per buffer, never reused within
//         a document); used so that clearing after a commit never removes a NEWER keystroke
//
// Several sets and several fields can be pending at the same time; each is independent.

import { editConflict } from './transitions.js';

const FIELDS = Object.freeze(['load', 'reps', 'durationSec', 'distanceM', 'durationBasis']);
const MAX_TEXT = 64;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isBase = (v) => v === null || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string';

export const INPUT_DRAFT_FIELDS = FIELDS;
export const emptyDraft = () => ({ v: 1, entries: [] });
export const draftKey = (e) => `${e.sessionId}|${e.performanceId}|${e.setId}`;

/** @returns {string|null} a problem description, or null when the document is well-formed */
export function draftProblem(doc) {
  if (!isObj(doc) || doc.v !== 1 || !Array.isArray(doc.entries) || Object.keys(doc).length !== 2) return 'expected { v: 1, entries: [] }';
  const seen = new Set();
  for (const e of doc.entries) {
    if (!isObj(e) || !isStr(e.sessionId) || !isStr(e.performanceId) || !isStr(e.setId) || !isObj(e.fields) || Object.keys(e).length !== 4) return 'invalid entry';
    if (seen.has(draftKey(e))) return 'duplicate entry';
    seen.add(draftKey(e));
    const names = Object.keys(e.fields);
    if (names.length === 0) return 'an entry needs at least one field';
    for (const f of names) {
      const x = e.fields[f];
      if (!FIELDS.includes(f)) return `unknown field ${f}`;
      if (!isObj(x) || Object.keys(x).length !== 4 || !isStr(x.text) || x.text.length > MAX_TEXT || !isBase(x.base) || !Number.isSafeInteger(x.rev) || x.rev < 1 || !isStr(x.at)) return `invalid field ${f}`;
    }
  }
  return null;
}

export const maxRev = (doc) => Math.max(0, ...doc.entries.flatMap((e) => Object.values(e.fields).map((x) => x.rev)));

/**
 * Records one keystroke. The field keeps the base of its FIRST pending keystroke (the committed value
 * the user started from); text, rev and at are replaced. Returns a new document.
 */
export function mergeDraftField(doc, { sessionId, performanceId, setId, field, text, base, rev, at }) {
  if (!FIELDS.includes(field)) throw new RangeError(`unknown field ${field}`);
  const next = structuredClone(doc);
  const key = draftKey({ sessionId, performanceId, setId });
  let e = next.entries.find((x) => draftKey(x) === key);
  if (!e) {
    e = { sessionId, performanceId, setId, fields: {} };
    next.entries.push(e);
  }
  const prev = e.fields[field];
  e.fields[field] = { text: String(text).slice(0, MAX_TEXT), base: prev ? prev.base : base, rev, at };
  return next;
}

/**
 * Removes the given fields of one set ONLY where the stored rev still equals the rev that was
 * committed; a newer keystroke (higher rev) stays. Returns { doc, removed: field[] }.
 */
export function clearDraftFields(doc, key, revs) {
  const next = structuredClone(doc);
  const e = next.entries.find((x) => draftKey(x) === key);
  const removed = [];
  if (e) {
    for (const [f, rev] of Object.entries(revs)) {
      if (e.fields[f] && e.fields[f].rev === rev) {
        delete e.fields[f];
        removed.push(f);
      }
    }
    if (Object.keys(e.fields).length === 0) next.entries = next.entries.filter((x) => x !== e);
  }
  return { doc: next, removed };
}

/**
 * What to do with each drafted field on launch. Nothing is applied here.
 * @param {(field:string, text:string) => {ok:boolean, value?:any}} parse
 * @returns {{key, sessionId, performanceId, setId, field, text, base, rev, committed, value, status}[]}
 *   status: 'already'  the committed value already equals the typed value → just clear the draft
 *           'apply'    committed still equals base → the typed value can be applied
 *           'conflict' the set changed after typing began → the user chooses (never silent)
 *           'invalid'  the text does not parse → shown, not applied
 *           'blocked'  the workout is in an edit conflict → kept until the conflict is resolved
 *           'orphan'   the target set no longer exists in the active workout → shown, then dismissible
 */
export function planDraftRecovery(store, doc, parse) {
  const a = store?.activeSession ?? null;
  const out = [];
  for (const e of doc.entries) {
    for (const [field, x] of Object.entries(e.fields)) {
      const item = { key: draftKey(e), sessionId: e.sessionId, performanceId: e.performanceId, setId: e.setId, field, text: x.text, base: x.base, rev: x.rev, committed: undefined, value: undefined, status: 'orphan' };
      out.push(item);
      if (!a || a.session?.id !== e.sessionId) continue;
      const perf = a.session.performances.find((p) => p.id === e.performanceId);
      const set = perf?.sets.find((s) => s.id === e.setId);
      if (!set || a.preservedPerformanceIds.includes(e.performanceId)) continue;
      item.committed = set[field] ?? null;
      const p = parse(field, x.text);
      if (!p.ok) {
        item.status = 'invalid';
        continue;
      }
      item.value = p.value;
      if (item.committed === p.value) item.status = 'already';
      else if (editConflict(store)) item.status = 'blocked';
      else item.status = item.committed === x.base ? 'apply' : 'conflict';
    }
  }
  return out;
}

