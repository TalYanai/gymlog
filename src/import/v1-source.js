// v1 adapter (Step 2c.3): parse, literal scan, root normalization and structure detection.
// Pure functions; nothing here reads or writes storage.
//
// Normalization never invents values (Phase 2a §1.2): a missing `custom` → [], a missing `bw` →
// no bodyweight setting, a missing workout `name` → no template snapshot. A broken root (`draft`
// not an object/null, `custom` not an array, `bw` not a number/null) rejects the whole file.
// `bw: null` is what v3 writes after a non-finite input (JSON.stringify(Infinity) → null), so it is
// treated like an unusable value (setting left empty + V1_BAD_VALUE), not as a broken root.

import { parseSourceText, scanJsonLiterals } from './source-bytes.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Literal-scan reasons whose value cannot be stored faithfully → the enclosing item is quarantined as text. */
export const TEXT_QUARANTINE_REASONS = Object.freeze(['unsafe_integer', 'non_finite', 'precision_loss', 'invalid_string']);

/** Top-level item a finding path belongs to: { kind: 'workout'|'custom'|'draft'|'bw'|'other', index? }. */
export function findingTarget(path) {
  let m = /^\$\.workouts\[(\d+)\]/.exec(path);
  if (m) return { kind: 'workout', index: Number(m[1]) };
  m = /^\$\.custom\[(\d+)\]/.exec(path);
  if (m) return { kind: 'custom', index: Number(m[1]) };
  if (/^\$\.draft(?:$|[.[])/.test(path)) return { kind: 'draft' };
  if (/^\$\.bw(?:$|[.[])/.test(path)) return { kind: 'bw' };
  return { kind: 'other' };
}

/**
 * Parses and prepares a v1 source text (already decoded byte-exactly).
 * @returns {{ok:true, root, structure:'A'|'B_or_C'|'C', findings, spans, textItems:Set<string>, text}
 *   | {ok:false, code:'SOURCE_NOT_JSON'|'FILE_UNKNOWN'|'V1_ROOT_INVALID', field?:string, message?:string}}
 */
export function prepareV1Source(text) {
  const parsed = parseSourceText(text);
  if (!parsed.ok) return { ok: false, code: 'SOURCE_NOT_JSON', message: parsed.message };
  const root = parsed.value;
  if (!isObj(root) || has(root, 'format') || !Array.isArray(root.workouts)) return { ok: false, code: 'FILE_UNKNOWN' };
  if (has(root, 'draft') && root.draft !== null && !isObj(root.draft)) return { ok: false, code: 'V1_ROOT_INVALID', field: 'draft' };
  if (has(root, 'custom') && !Array.isArray(root.custom)) return { ok: false, code: 'V1_ROOT_INVALID', field: 'custom' };
  if (has(root, 'bw') && root.bw !== null && typeof root.bw !== 'number') return { ok: false, code: 'V1_ROOT_INVALID', field: 'bw' };

  const { findings, spans } = scanJsonLiterals(text);
  // Items whose literals can't be stored faithfully: "workout:3", "custom:0", "draft", "bw".
  const textItems = new Set();
  for (const f of findings) {
    if (!TEXT_QUARANTINE_REASONS.includes(f.reason)) continue;
    const t = findingTarget(f.path);
    if (t.kind === 'workout' || t.kind === 'custom') textItems.add(`${t.kind}:${t.index}`);
    else if (t.kind === 'draft' || t.kind === 'bw') textItems.add(t.kind);
  }

  const draft = has(root, 'draft') ? root.draft : null;
  const structure = !has(root, 'custom') && !has(root, 'bw') && !has(root, 'lastBackup')
    ? 'A'
    : has(root, 'lastBackup') || (isObj(draft) && has(draft, 'editId'))
      ? 'C'
      : 'B_or_C';

  return {
    ok: true,
    text,
    structure,
    findings,
    spans,
    textItems,
    root: {
      workouts: root.workouts,
      draft,
      custom: has(root, 'custom') ? root.custom : [],
      bw: has(root, 'bw') ? root.bw : undefined,
    },
  };
}

/** Exact source text of a depth ≤ 2 item, e.g. sourceSlice(src, '$.workouts[3]'). */
export function sourceSlice(src, path) {
  const span = src.spans[path];
  if (!span) throw new Error(`no source span for ${path}`);
  return src.text.slice(span.start, span.end);
}

/** Number of sets in a v1 workout, counted as robustly as its shape allows (reconciliation). */
export function countWorkoutSets(w) {
  if (!isObj(w) || !Array.isArray(w.entries)) return 0;
  return w.entries.reduce((n, e) => n + (isObj(e) && Array.isArray(e.sets) ? e.sets.length : 0), 0);
}
