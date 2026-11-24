// Units and duration input (Step 2b.7). Pure. Stored values are never converted; conversion
// happens only at calculation time (D6, D11). Rounding is for display only.
import { LB_TO_KG } from '../schema/constants.js';

/** A load or bodyweight in kg. `unit` is 'kg' or 'lb'; null value → null. */
export function toKg(value, unit) {
  if (value === null || value === undefined) return null;
  if (unit === 'kg') return value;
  if (unit === 'lb') return value * LB_TO_KG;
  throw new RangeError(`unknown unit ${unit}`);
}

/** Converts between kg and lb (calculation time only). */
export function convertLoad(value, from, to) {
  if (value === null) return null;
  if (from === to) return value;
  return from === 'lb' ? value * LB_TO_KG : value / LB_TO_KG;
}

/**
 * Parses a typed duration: "m:ss", "h:mm:ss", or whole seconds ("45"). Returns whole seconds or
 * null when the text is not a valid duration (never guesses). "25:30" → 1530.
 */
export function parseDurationInput(text) {
  const t = String(text ?? '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const [h, mm, ss] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (ss > 59 || (m[1] !== undefined && mm > 59)) return null;
  return h * 3600 + mm * 60 + ss;
}

/** Display: 1530 → "25:30", 3725 → "1:02:05". */
export function formatDuration(sec) {
  if (sec === null || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/**
 * Display-only average pace of ONE run (seconds per km), as v3 showed it in history. Never used for
 * records, 10K results or goals (no pace extrapolation, T15).
 */
export function displayPacePerKm(durationSec, distanceM) {
  if (!(durationSec > 0) || !(distanceM > 0)) return null;
  return Math.round((durationSec * 1000) / distanceM);
}
