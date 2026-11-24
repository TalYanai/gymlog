// Canonical JSON serialization aligned with RFC 8785 (JCS), plus SHA-256.
//
// Rules (approved Phase 2a §2):
// - Object keys sorted recursively by UTF-16 code units (JavaScript default string comparison).
// - Array order preserved.
// - No whitespace. Strings and numbers serialized exactly as JSON.stringify does (ES Number format).
// - Rejected (throws CanonicalizationError): undefined, functions, symbols, bigint, NaN, ±Infinity, -0,
//   sparse arrays, non-plain objects (Date, Map, class instances, ...), lone UTF-16 surrogates.
//   Rejecting -0 and lone surrogates is stricter than JCS output rules; it matches the approved design
//   and I-JSON (RFC 7493) input requirements.

export class CanonicalizationError extends Error {
  constructor(message, path) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkString(s, path) {
  if (LONE_SURROGATE.test(s)) throw new CanonicalizationError('Lone UTF-16 surrogate in string', path);
}

function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function ser(value, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError('Non-finite number', path);
      if (Object.is(value, -0)) throw new CanonicalizationError('Negative zero', path);
      return JSON.stringify(value);
    case 'string':
      checkString(value, path);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new CanonicalizationError('Sparse array', `${path}[${i}]`);
          parts.push(ser(value[i], `${path}[${i}]`));
        }
        return `[${parts.join(',')}]`;
      }
      if (!isPlainObject(value)) throw new CanonicalizationError('Non-plain object', path);
      if (Object.getOwnPropertySymbols(value).length) throw new CanonicalizationError('Symbol key', path);
      const keys = Object.keys(value).sort(); // UTF-16 code unit order
      const parts = [];
      for (const k of keys) {
        checkString(k, `${path}.${k}`);
        parts.push(`${JSON.stringify(k)}:${ser(value[k], `${path}.${k}`)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`Unsupported type ${typeof value}`, path);
  }
}

/** @returns {string} canonical JSON text */
export function canonicalize(value) {
  return ser(value, '$');
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('crypto.subtle is not available');
  return s;
}

/** SHA-256 of the UTF-8 bytes of a string, as 64 lowercase hex characters. No normalization. */
export async function sha256Hex(text) {
  if (typeof text !== 'string') throw new TypeError('sha256Hex expects a string');
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (const b of bytes) out += HEX[b];
  return out;
}

/** sha256(canonical(value)) */
export async function canonicalSha256(value) {
  return sha256Hex(canonicalize(value));
}
