// Parsing of typed set values (Step 2d.0). Pure. Text exactly as typed → { ok, value }.
// Empty text means "not entered" (null). Nothing is guessed: text that does not parse is rejected.
import { parseDurationInput } from '../derive/units.js';
import { TIME_BASIS } from '../schema/constants.js';

const DECIMAL = /^\d+(?:[.,]\d+)?$/;

export function parseFieldInput(field, text) {
  const t = String(text ?? '').trim();
  if (t === '') return { ok: true, value: null };
  switch (field) {
    case 'load':
    case 'distanceM': {
      if (!DECIMAL.test(t)) return { ok: false };
      const v = Number(t.replace(',', '.'));
      return Number.isFinite(v) && v >= 0 ? { ok: true, value: v } : { ok: false };
    }
    case 'reps':
      return /^\d+$/.test(t) ? { ok: true, value: Number(t) } : { ok: false };
    case 'durationSec': {
      const v = parseDurationInput(t);
      return v === null ? { ok: false } : { ok: true, value: v };
    }
    case 'durationBasis':
      return TIME_BASIS.includes(t) ? { ok: true, value: t } : { ok: false };
    default:
      return { ok: false };
  }
}
