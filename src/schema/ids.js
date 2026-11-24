// ID generation (approved Phase 2b §2.2 and Phase 2a collision rules).
// - New records: `<prefix>_<uuid v4>`.
// - Seed IDs are written explicitly in seed-defaults.json (no generator here).
// - v1 import IDs are deterministic patterns.
// - Collision resolution is a pure two-pass algorithm; store lookups are injected by the caller.

import { ID_PREFIXES, MAX_COLLISION_SUFFIX, ID_HASH_HEX_LENGTH } from './constants.js';

function requirePrefix(prefix) {
  if (!ID_PREFIXES.includes(prefix)) throw new RangeError(`Unknown ID prefix "${prefix}"`);
}

/** RFC 4122 v4 UUID from 16 random bytes. */
function uuidFromBytes(b) {
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Random UUID v4. Uses crypto.randomUUID when available; otherwise crypto.getRandomValues
 * (iOS < 15.4 fallback). `cryptoImpl` is injectable for tests.
 */
export function randomUuid(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') return cryptoImpl.randomUUID();
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
    return uuidFromBytes(cryptoImpl.getRandomValues(new Uint8Array(16)));
  }
  throw new Error('No secure random source available');
}

/** New ID for a record created in the app, e.g. newId('ses') → "ses_3f8a…". */
export function newId(prefix, cryptoImpl) {
  requirePrefix(prefix);
  return `${prefix}_${randomUuid(cryptoImpl)}`;
}

// ---- Deterministic v1 session IDs ----------------------------------------

const SAFE_LEGACY_ID = /^[A-Za-z0-9-]{1,64}$/;

function legacyIdPart(legacyId) {
  const s = typeof legacyId === 'number' ? (Number.isSafeInteger(legacyId) && legacyId >= 0 ? String(legacyId) : null) : legacyId;
  if (typeof s !== 'string' || !SAFE_LEGACY_ID.test(s)) {
    throw new RangeError('legacyId must be a non-negative safe integer or a short alphanumeric string');
  }
  return s;
}

function requireHash16(hash) {
  const re = new RegExp(`^[0-9a-f]{${ID_HASH_HEX_LENGTH}}$`);
  if (typeof hash !== 'string' || !re.test(hash)) throw new RangeError(`Expected ${ID_HASH_HEX_LENGTH} lowercase hex characters`);
  return hash;
}

function requirePosition(n, name) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return n;
}

/** ses_v1_<legacyId> */
export function v1SessionId(legacyId) {
  return `ses_v1_${legacyIdPart(legacyId)}`;
}

/** ses_v1_<legacyId>_dup<n>, n ≥ 2 (the order of appearance of a duplicate legacyId within one file). */
export function v1DuplicateSessionId(legacyId, n) {
  if (!Number.isSafeInteger(n) || n < 2) throw new RangeError('dup index must be an integer ≥ 2');
  return `ses_v1_${legacyIdPart(legacyId)}_dup${n}`;
}

/** ses_v1_noid_<first 16 hex of sourceSessionSha256>_<position in file> */
export function v1NoIdSessionId(sourceSessionSha256, position) {
  return `ses_v1_noid_${requireHash16(sourceSessionSha256.slice(0, ID_HASH_HEX_LENGTH))}_${requirePosition(position, 'position')}`;
}

/** ses_v1_<legacyId>_alt<first 16 hex of sourceSessionSha256> (separate import of a conflicting session). */
export function v1AltSessionId(legacyId, sourceSessionSha256) {
  return `ses_v1_${legacyIdPart(legacyId)}_alt${requireHash16(sourceSessionSha256.slice(0, ID_HASH_HEX_LENGTH))}`;
}

// ---- Child IDs derived from the final session ID -------------------------

const pad2 = (n) => String(n).padStart(2, '0');

function sessionSuffix(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith('ses_') || sessionId.length <= 4) {
    throw new RangeError('sessionId must start with "ses_"');
  }
  return sessionId.slice(4);
}

/** prf_<session suffix>_<nn>, index is 1-based order. */
export function derivedPerformanceId(sessionId, index) {
  if (!Number.isSafeInteger(index) || index < 1) throw new RangeError('index must be ≥ 1');
  return `prf_${sessionSuffix(sessionId)}_${pad2(index)}`;
}

/** set_<session suffix>_<nn>_<mm>, both 1-based. */
export function derivedSetId(sessionId, performanceIndex, setIndex) {
  if (!Number.isSafeInteger(performanceIndex) || performanceIndex < 1) throw new RangeError('performanceIndex must be ≥ 1');
  if (!Number.isSafeInteger(setIndex) || setIndex < 1) throw new RangeError('setIndex must be ≥ 1');
  return `set_${sessionSuffix(sessionId)}_${pad2(performanceIndex)}_${pad2(setIndex)}`;
}

// ---- Two-pass collision algorithm -----------------------------------------

/** Candidate series: base, base_c2 … base_c<max>. */
export function collisionCandidates(baseId, max = MAX_COLLISION_SUFFIX) {
  const out = [baseId];
  for (let k = 2; k <= max; k++) out.push(`${baseId}_c${k}`);
  return out;
}

/**
 * Resolves the ID for an incoming record.
 *   isUsed(id)       → true if any record already has this ID
 *   isSameOrigin(id) → true if the record at this ID is the same source record (identity rules are the caller's)
 *
 * Pass 1: if ANY used candidate holds a same-origin record → { status: 'already_exists', id }.
 * Pass 2: otherwise the FIRST free candidate → { status: 'assigned', id, collisionResolved }.
 * If every candidate is used by different records → { status: 'unresolved' } (caller quarantines).
 */
export function resolveCollision({ baseId, isUsed, isSameOrigin, max = MAX_COLLISION_SUFFIX }) {
  if (typeof baseId !== 'string' || baseId.length === 0) throw new TypeError('baseId required');
  if (typeof isUsed !== 'function' || typeof isSameOrigin !== 'function') throw new TypeError('isUsed and isSameOrigin are required');
  const candidates = collisionCandidates(baseId, max);

  for (const id of candidates) {
    if (isUsed(id) && isSameOrigin(id)) return { status: 'already_exists', id };
  }
  for (const id of candidates) {
    if (!isUsed(id)) return { status: 'assigned', id, collisionResolved: id !== baseId };
  }
  return { status: 'unresolved' };
}
