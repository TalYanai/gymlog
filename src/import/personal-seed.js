// Step 2f — the private personal-data file (gymlog-personal.json, format "gymlog-personal-seed" v1).
// Separate from the CSV import (different file, write and import-log kind). Pure and deterministic.
//
// File:
//   { "format": "gymlog-personal-seed", "formatVersion": 1,
//     "items": [ { "key": "goal-10k", "kind": "goal" | "manual_record" | "prefill" | "bodyweight",
//                  "needsReview": true|false, "reviewNote": "…"|null, "value": { … } } ] }
//   goal:          { exerciseId, metric, target, deadline }
//   manual_record: { exerciseId, metric, load, loadUnit, loadBasis, reps, repsText, durationSec, distanceM, timeBasis, date, note }
//   prefill:       { exerciseId, load }
//   bodyweight:    { value, unit }
// Review (2a S7): every item is confirmed, edited (the user's value replaces the file's) or skipped by the
// user; nothing is defaulted — items marked needsReview have no decision until the user makes one; items
// not marked needsReview start as "confirm" and can still be skipped. Invalid items are listed and
// cannot be imported; the valid ones can (F20). An item already present with the same content is skipped.
import { sha256Hex, canonicalize } from '../schema/canonical.js';
import { FORMATS, GOAL_METRICS, MANUAL_RECORD_METRICS, LOAD_UNITS } from '../schema/constants.js';
import { createGoal, createManualRecord } from '../schema/factories.js';
import { validateStore } from '../schema/validate.js';

export const PERSONAL_KINDS = Object.freeze(['goal', 'manual_record', 'prefill', 'bodyweight']);
const hex16 = async (s) => (await sha256Hex(s)).slice(0, 16);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const RECORD_FIELDS = ['load', 'loadUnit', 'loadBasis', 'reps', 'repsText', 'durationSec', 'distanceM', 'timeBasis', 'date', 'note'];

/** Parses the file; every item gets { key, kind, needsReview, reviewNote, value, problem|null }. */
export function parsePersonalSeed(text) {
  let root;
  try {
    root = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    return fail('SOURCE_NOT_JSON');
  }
  if (!isObj(root) || root.format !== FORMATS.personalSeed) return fail('PERSONAL_FORMAT_UNKNOWN');
  if (root.formatVersion !== FORMATS.personalSeedVersion) return fail('PERSONAL_VERSION_UNSUPPORTED');
  if (!Array.isArray(root.items)) return fail('PERSONAL_FORMAT_UNKNOWN');
  const keys = new Set();
  const items = root.items.map((it, i) => {
    const key = isObj(it) && typeof it.key === 'string' && it.key.trim() ? it.key : `#${i + 1}`;
    let problem = null;
    if (!isObj(it) || !PERSONAL_KINDS.includes(it.kind) || !isObj(it.value)) problem = 'shape';
    else if (keys.has(key)) problem = 'duplicate_key';
    keys.add(key);
    return { index: i, key, kind: it?.kind ?? null, needsReview: it?.needsReview === true, reviewNote: typeof it?.reviewNote === 'string' ? it.reviewNote : null, value: isObj(it?.value) ? it.value : null, problem };
  });
  return { ok: true, items };
}

/** Default decisions: needsReview items undecided; the others "confirm". */
export const defaultPersonalDecisions = (items) => Object.fromEntries(items.filter((x) => !x.problem && !x.needsReview).map((x) => [x.key, { action: 'confirm' }]));

const contentOf = (x) => canonicalize(Object.fromEntries(Object.entries(x).filter(([k]) => !['id', 'createdAt', 'updatedAt'].includes(k))));

/** Applies one item to a copy of the store. Returns { store, change } or { problem }. */
async function applyItem(store, item, value, { importedAt, idBase }) {
  const s = structuredClone(store);
  const v = value;
  try {
    if (item.kind === 'goal') {
      if (!GOAL_METRICS.includes(v.metric)) return { problem: 'metric' };
      const g = createGoal({ id: `goal_ps_${await hex16(idBase)}`, exerciseId: v.exerciseId, metric: v.metric, target: v.target, deadline: v.deadline ?? null, source: 'personal_seed', now: importedAt });
      if (s.goals.some((x) => contentOf(x) === contentOf(g))) return { already: true };
      if (s.goals.some((x) => x.id === g.id)) return { problem: 'id_taken' };
      s.goals.push(g);
    } else if (item.kind === 'manual_record') {
      if (!MANUAL_RECORD_METRICS.includes(v.metric)) return { problem: 'metric' };
      const args = { id: `rec_ps_${await hex16(idBase)}`, exerciseId: v.exerciseId, metric: v.metric, source: 'personal_seed', now: importedAt };
      for (const f of RECORD_FIELDS) if (f in v) args[f] = v[f];
      if (v.metric === 'time_for_distance' && !('timeBasis' in v)) return { problem: 'timeBasis' };
      const r = createManualRecord(args);
      if (s.manualRecords.some((x) => contentOf(x) === contentOf(r))) return { already: true };
      if (s.manualRecords.some((x) => x.id === r.id)) return { problem: 'id_taken' };
      s.manualRecords.push(r);
    } else if (item.kind === 'prefill') {
      const ex = s.exercises.find((e) => e.id === v.exerciseId);
      if (!ex) return { problem: 'exercise' };
      if (ex.measurement.type === 'unresolved') return { problem: 'exercise' };
      if (ex.prefill && ex.prefill.load === v.load && ex.prefill.source === 'personal_seed') return { already: true };
      ex.prefill = { load: v.load, source: 'personal_seed' };
      ex.updatedAt = importedAt;
    } else if (item.kind === 'bodyweight') {
      if (!(typeof v.value === 'number' && v.value > 20 && v.value < 400) || !LOAD_UNITS.includes(v.unit)) return { problem: 'value' };
      const b = s.settings.bodyweight;
      if (b.confirmed && b.value === v.value && b.unit === v.unit) return { already: true };
      s.settings.bodyweight = { value: v.value, unit: v.unit, confirmed: true, updatedAt: importedAt };
    }
  } catch {
    return { problem: 'value' };
  }
  const val = await validateStore(s);
  if (!val.valid) return { problem: 'invalid', errors: val.errors.slice(0, 5) };
  return { store: s };
}

/** Each item checked alone against the store: { key: 'ok' | 'already' | problem }. */
export async function checkPersonalItems(items, store, { importedAt, sourceSha256 }) {
  const out = {};
  for (const it of items) {
    if (it.problem) { out[it.key] = it.problem; continue; }
    const r = await applyItem(store, it, it.value, { importedAt, idBase: `${sourceSha256}\u0000${it.key}` });
    out[it.key] = r.problem ?? (r.already ? 'already' : 'ok');
  }
  return out;
}

/** Undecided items (only valid, not-already-present items need a decision). */
export function missingPersonal(items, checks, decisions) {
  return items.filter((it) => checks[it.key] === 'ok' && !['confirm', 'edit', 'skip'].includes(decisions[it.key]?.action)).map((it) => it.key);
}

/**
 * Builds the additions for Store.appendPersonalSeed (items applied in file order, each validated).
 * @returns {Promise<{ok:true, additions:object|null, entry:object|null, summary:object} | {ok:false, code, ...}>}
 */
export async function buildPersonalSeed(items, decisions, { store, importedAt, sourceSha256 }) {
  if (store.meta.importLog.some((e) => e.kind === 'personal_seed' && e.sourceSha256 === sourceSha256)) return fail('ALREADY_IMPORTED');
  const checks = await checkPersonalItems(items, store, { importedAt, sourceSha256 });
  const missing = missingPersonal(items, checks, decisions);
  if (missing.length) return fail('DECISIONS_INCOMPLETE', { missing });
  const decisionsNorm = Object.fromEntries(items.map((it) => [it.key, checks[it.key] === 'ok' ? decisions[it.key] : null]));
  const packageSha256 = await sha256Hex(canonicalize({ format: 'gymlog-personal-seed-plan', sourceSha256, decisions: decisionsNorm }));
  const importId = `imp_ps_${packageSha256.slice(0, 16)}`;
  let s = structuredClone(store);
  const warnings = [];
  const summary = { confirmed: 0, edited: 0, skipped: 0, already: 0, invalid: 0 };
  for (const it of items) {
    const c = checks[it.key];
    if (c === 'already') { summary.already += 1; warnings.push({ code: 'PERSONAL_ITEM_ALREADY_PRESENT', ref: it.key }); continue; }
    if (c !== 'ok') { summary.invalid += 1; warnings.push({ code: 'PERSONAL_ITEM_INVALID', ref: `${it.key}:${c}` }); continue; }
    const d = decisions[it.key];
    if (d.action === 'skip') { summary.skipped += 1; warnings.push({ code: 'PERSONAL_ITEM_SKIPPED', ref: it.key }); continue; }
    const value = d.action === 'edit' ? d.value : it.value;
    const r = await applyItem(s, it, value, { importedAt, idBase: `${sourceSha256}\u0000${it.key}` });
    if (r.problem) return fail('PERSONAL_ITEM_INVALID', { key: it.key, problem: r.problem, errors: r.errors });
    if (r.already) { summary.already += 1; warnings.push({ code: 'PERSONAL_ITEM_ALREADY_PRESENT', ref: it.key }); continue; }
    s = r.store;
    summary[d.action === 'edit' ? 'edited' : 'confirmed'] += 1;
    warnings.push({ code: d.action === 'edit' ? 'PERSONAL_ITEM_EDITED' : 'PERSONAL_ITEM_CONFIRMED', ref: it.key });
  }
  if (summary.confirmed + summary.edited === 0) return { ok: true, additions: null, entry: null, summary };
  const entry = {
    importId, kind: 'personal_seed', status: 'pending', at: importedAt, reportSeenAt: null, sourceSha256, packageSha256,
    counts: { sessions: 0, performances: 0, sets: 0, quarantined: 0 }, unresolvedExercises: [], warnings, calculationChanges: [],
  };
  const additions = {
    goals: s.goals.filter((g) => !store.goals.some((x) => x.id === g.id)),
    manualRecords: s.manualRecords.filter((r) => !store.manualRecords.some((x) => x.id === r.id)),
    prefills: s.exercises.filter((e) => canonicalize(e.prefill) !== canonicalize(store.exercises.find((x) => x.id === e.id).prefill)).map((e) => ({ exerciseId: e.id, load: e.prefill.load })),
    bodyweight: canonicalize(s.settings.bodyweight) !== canonicalize(store.settings.bodyweight) ? { value: s.settings.bodyweight.value, unit: s.settings.bodyweight.unit } : null,
    at: importedAt,
    entry,
  };
  return { ok: true, additions, entry, summary };
}
