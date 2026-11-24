// Source bytes → text, file identification, and the JSON literal scan (Step 2c.1).
//
// Byte handling (Revision 2 §8):
// - Input is the file's raw bytes (Uint8Array or ArrayBuffer). The UI must read files with
//   file.arrayBuffer(), never file.text() (which silently replaces invalid sequences).
// - Decoding is fatal UTF-8 with ignoreBOM: true, so a BOM is kept as U+FEFF and line endings
//   are kept exactly. Invalid UTF-8 → rejected: storage holds text only, so invalid bytes could
//   not be preserved exactly.
// - Round-trip check: TextEncoder.encode(text) must equal the input bytes. Only then is the text
//   a byte-exact representation of the file, and sha256Hex(text) (UTF-8 of the text) equals the
//   SHA-256 of the original bytes.
// - For parsing only, one leading U+FEFF is removed from a copy. The returned text keeps it.
//
// Literal scan (Revision 6 §B2, Revision 7 §C2): runs on text that JSON.parse already accepted
// and reports, for the WHOLE file: duplicate keys (compared after unescaping), non-finite
// numbers, integer values beyond the safe range (any spelling), precision loss, and strings
// that are not well-formed Unicode. Value-preserving textual differences (1.0, 1e2, 0.10, -0)
// are not reported.

import { FORMATS, SCHEMA_VERSION } from '../schema/constants.js';
import { sha256Hex } from '../schema/canonical.js';

const BOM = '﻿';

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('decodeSource expects a Uint8Array or ArrayBuffer');
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * @returns {Promise<{ok:true, text:string, sha256:string, hasBom:boolean, byteLength:number}
 *   | {ok:false, code:'SOURCE_EMPTY'|'SOURCE_ENCODING_INVALID', reason?:string}>}
 */
export async function decodeSource(input) {
  const bytes = toBytes(input);
  if (bytes.length === 0) return { ok: false, code: 'SOURCE_EMPTY' };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'SOURCE_ENCODING_INVALID', reason: 'invalid_utf8' };
  }
  if (!sameBytes(new TextEncoder().encode(text), bytes)) {
    return { ok: false, code: 'SOURCE_ENCODING_INVALID', reason: 'round_trip_mismatch' };
  }
  return { ok: true, text, sha256: await sha256Hex(text), hasBom: text.startsWith(BOM), byteLength: bytes.length };
}

/** JSON.parse of a copy without one leading BOM. */
export function parseSourceText(text) {
  if (typeof text !== 'string') throw new TypeError('parseSourceText expects a string');
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (err) {
    return { ok: false, code: 'SOURCE_NOT_JSON', message: String(err?.message ?? err) };
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Approved identification table (Phase 2a, corrected):
 *   format "gymlog-backup" + formatVersion 1 + schemaVersion 2 → gymlog_backup
 *   format "gymlog-backup" with any other version              → unsupported_backup (rejected in full)
 *   format "gymlog-import-package"                              → import_package (Phase 3)
 *   object with workouts[] and no format field                  → v1
 *   anything else                                               → unknown ("סוג הקובץ לא מזוהה")
 */
export function identifyFile(text) {
  const parsed = parseSourceText(text);
  if (!parsed.ok) return { kind: 'not_json', code: 'SOURCE_NOT_JSON', message: parsed.message };
  const v = parsed.value;
  if (isPlainObject(v) && 'format' in v) {
    if (v.format === FORMATS.backup) {
      if (v.formatVersion === FORMATS.backupVersion && v.schemaVersion === SCHEMA_VERSION) return { kind: 'gymlog_backup', parsed: v };
      return {
        kind: 'unsupported_backup',
        code: 'BACKUP_UNSUPPORTED',
        formatVersion: v.formatVersion ?? null,
        schemaVersion: v.schemaVersion ?? null,
      };
    }
    if (v.format === FORMATS.importPackage) return { kind: 'import_package', parsed: v };
    return { kind: 'unknown', code: 'FILE_UNKNOWN' };
  }
  if (isPlainObject(v) && Array.isArray(v.workouts)) return { kind: 'v1', parsed: v };
  return { kind: 'unknown', code: 'FILE_UNKNOWN' };
}

// ---- literal scan ------------------------------------------------------------------------------

/** Exact decimal value of a JSON/JS number literal as "sign digits e exponent", zero as "0". */
function normalizeDecimal(literal) {
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!m) throw new Error(`not a decimal literal: ${literal}`);
  const frac = m[3] ?? '';
  let digits = (m[2] + frac).replace(/^0+/, '');
  if (digits === '') return '0'; // -0 and 0 have the same decimal value
  let exp = BigInt(m[4] ?? '0') - BigInt(frac.length);
  const trailing = /0+$/.exec(digits);
  if (trailing) {
    exp += BigInt(trailing[0].length);
    digits = digits.slice(0, -trailing[0].length);
  }
  return `${m[1] ? '-' : ''}${digits}e${exp}`;
}

/** @returns {null|'non_finite'|'unsafe_integer'|'precision_loss'} */
export function classifyNumberLiteral(token) {
  const v = Number(token); // the same rounding JSON.parse applies
  if (!Number.isFinite(v)) return 'non_finite';
  if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) return 'unsafe_integer';
  if (normalizeDecimal(token) !== normalizeDecimal(JSON.stringify(v))) return 'precision_loss';
  return null;
}

function isWellFormedUnicode(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(k + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      k++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const childKey = (p, k) => (IDENT.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Scans JSON text (already accepted by JSON.parse) for literals whose parsed meaning is not a
 * faithful, safely storable value.
 *
 * @returns {{ findings: {reason:string, path:string, offset:number}[],
 *             spans: Record<string, {start:number, end:number}> }}
 *   findings in text order; offsets are indices into `text` (including a leading BOM).
 *   spans: exact [start, end) of the root value, every root member value and every element or
 *   member of those (depth ≤ 2, e.g. "$.workouts[3]", "$.custom[0]", "$.draft", "$.bw").
 */
export function scanJsonLiterals(text) {
  if (typeof text !== 'string') throw new TypeError('scanJsonLiterals expects a string');
  let i = text.startsWith(BOM) ? 1 : 0;
  const findings = [];
  const spans = {};
  const fail = (msg) => {
    throw new SyntaxError(`scanJsonLiterals: ${msg} at offset ${i}`);
  };
  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  function str() {
    const start = i;
    i++; // opening quote
    let out = '';
    let run = i;
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const ch = text[i];
      if (ch === '"') {
        out += text.slice(run, i);
        i++;
        return { value: out, start };
      }
      if (ch === '\\') {
        out += text.slice(run, i);
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e in ESC) {
          out += ESC[e];
          i += 2;
        } else fail('invalid escape');
        run = i;
      } else {
        if (ch.charCodeAt(0) < 0x20) fail('control character in string');
        i++;
      }
    }
  }

  function value(path, depth) {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      const seen = new Set();
      if (text[i] === '}') i++;
      else {
        for (;;) {
          ws();
          if (text[i] !== '"') fail('expected a key');
          const k = str();
          const kp = childKey(path, k.value);
          if (!isWellFormedUnicode(k.value)) findings.push({ reason: 'invalid_string', path: kp, offset: k.start });
          if (seen.has(k.value)) findings.push({ reason: 'duplicate_key', path: kp, offset: k.start });
          seen.add(k.value);
          ws();
          if (text[i] !== ':') fail('expected ":"');
          i++;
          value(kp, depth + 1);
          ws();
          if (text[i] === ',') {
            i++;
            continue;
          }
          if (text[i] === '}') {
            i++;
            break;
          }
          fail('expected "," or "}"');
        }
      }
    } else if (c === '[') {
      i++;
      ws();
      let n = 0;
      if (text[i] === ']') i++;
      else {
        for (;;) {
          value(`${path}[${n++}]`, depth + 1);
          ws();
          if (text[i] === ',') {
            i++;
            continue;
          }
          if (text[i] === ']') {
            i++;
            break;
          }
          fail('expected "," or "]"');
        }
      }
    } else if (c === '"') {
      const s = str();
      if (!isWellFormedUnicode(s.value)) findings.push({ reason: 'invalid_string', path, offset: s.start });
    } else if (text.startsWith('true', i)) i += 4;
    else if (text.startsWith('false', i)) i += 5;
    else if (text.startsWith('null', i)) i += 4;
    else {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m || m[0].length === 0) fail('unexpected character');
      i += m[0].length;
      const reason = classifyNumberLiteral(m[0]);
      if (reason) findings.push({ reason, path, offset: start });
    }
    if (depth <= 2) spans[path] = { start, end: i };
  }

  value('$', 0);
  ws();
  if (i !== text.length) fail('unexpected trailing content');
  findings.sort((a, b) => a.offset - b.offset);
  return { findings, spans };
}
