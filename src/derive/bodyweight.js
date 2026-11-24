// Bodyweight basis (Step 2b.7, §1.1 / D3 / D3a / D11).
import { toKg } from './units.js';

/** 'measured' (official) | 'assumed' (user_estimate / settings_default; separate section) | 'none'. */
export function bodyweightBasis(snapshot) {
  if (!snapshot || snapshot.value === null || snapshot.value === undefined) return 'none';
  if (snapshot.source === 'measured') return 'measured';
  if (snapshot.source === 'user_estimate' || snapshot.source === 'settings_default') return 'assumed';
  return 'none';
}

/** Bodyweight in kg, independent of the load unit (D11); null when unknown. */
export function bodyweightKg(snapshot) {
  return bodyweightBasis(snapshot) === 'none' ? null : toKg(snapshot.value, snapshot.unit);
}
