// Display formatting (Step 2d.0). Pure; Hebrew UI with English exercise names.
import { formatDuration } from '../derive/units.js';

/** "2026-11-07" → "7.11.2026"; null → "ללא תאריך". */
export function formatDate(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return 'ללא תאריך';
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d}.${m}.${y}`;
}

/** Numbers without trailing zeros: 82.5 → "82.5", 80 → "80". */
export const formatNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '');

export const unitLabel = (unit) => ({ kg: 'ק״ג', lb: 'lb' })[unit] ?? '';

export const formatLoad = (value, unit) => (typeof value === 'number' ? `${formatNumber(value)} ${unitLabel(unit)}`.trim() : '');

export const formatSeconds = (sec) => formatDuration(sec);

/** Today's local date as YYYY-MM-DD (the workout date is local, never UTC). */
export function localToday(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
