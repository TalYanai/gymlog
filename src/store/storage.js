// Storage adapter — the ONLY module allowed to access localStorage.
// Wraps a Web Storage-compatible backend and classifies failures explicitly.
// It never retries, never swallows errors, and never deletes anything on its own.

export class StorageWriteError extends Error {
  /** @param {'quota'|'unavailable'|'other'} kind */
  constructor(kind, key, cause) {
    super(`Storage write failed (${kind}) for key "${key}"`);
    this.name = 'StorageWriteError';
    this.kind = kind;
    this.key = key;
    this.cause = cause;
  }
}

export class StorageReadError extends Error {
  /** @param {'unavailable'|'other'} kind */
  constructor(kind, key, cause) {
    super(`Storage read failed (${kind}) for key "${key}"`);
    this.name = 'StorageReadError';
    this.kind = kind;
    this.key = key;
    this.cause = cause;
  }
}

/** Recognizes quota errors across browsers (Safari/Chrome: QuotaExceededError / code 22, Firefox: NS_ERROR_DOM_QUOTA_REACHED / 1014). */
export function isQuotaError(err) {
  if (!err || typeof err !== 'object') return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  );
}

function isUnavailableError(err) {
  return !!err && typeof err === 'object' && (err.name === 'SecurityError' || err.code === 18);
}

function classifyWrite(err) {
  if (isQuotaError(err)) return 'quota';
  if (isUnavailableError(err)) return 'unavailable';
  return 'other';
}

/**
 * @param {Storage} [backend] defaults to globalThis.localStorage. Tests inject a memory storage.
 */
export function createStorage(backend) {
  const resolveBackend = () => {
    const b = backend ?? globalThis.localStorage;
    if (!b) throw Object.assign(new Error('No storage backend available'), { name: 'SecurityError' });
    return b;
  };

  const requireStringKey = (key) => {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('Storage key must be a non-empty string');
  };

  return {
    /** @returns {string|null} */
    get(key) {
      requireStringKey(key);
      try {
        return resolveBackend().getItem(key);
      } catch (err) {
        throw new StorageReadError(isUnavailableError(err) ? 'unavailable' : 'other', key, err);
      }
    },

    /** Writes a string value. Throws StorageWriteError; never partially succeeds silently. */
    set(key, value) {
      requireStringKey(key);
      if (typeof value !== 'string') throw new TypeError('Storage value must be a string (no implicit conversion)');
      try {
        resolveBackend().setItem(key, value);
      } catch (err) {
        throw new StorageWriteError(classifyWrite(err), key, err);
      }
    },

    /** Removes one key. Callers decide when removal is permitted; the adapter has no bulk delete. */
    remove(key) {
      requireStringKey(key);
      try {
        resolveBackend().removeItem(key);
      } catch (err) {
        throw new StorageWriteError(classifyWrite(err), key, err);
      }
    },

    /** @returns {string[]} all keys (for storage-usage reporting). */
    keys() {
      try {
        const b = resolveBackend();
        const out = [];
        for (let i = 0; i < b.length; i++) {
          const k = b.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      } catch (err) {
        throw new StorageReadError(isUnavailableError(err) ? 'unavailable' : 'other', '*', err);
      }
    },
  };
}
