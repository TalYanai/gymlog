// Single-activity Garmin CSV (Garmin Connect "export CSV" of one workout) -> the wide history-CSV format,
// so the existing analyze/plan/apply pipeline (duplicate fingerprint garmin:<activityId>) is reused unchanged.
// The single file carries no date/title/activity id: the caller supplies date (DD-MM-YYYY or YYYY-MM-DD),
// title, and the activity id (normally the digits in the file name activity_<id>.csv).
import { parseCsv } from './garmin-csv.js';

const WIDE = ['שם_אימון_תאריך', 'שם_האימון', 'תאריך', 'מזהה_פעילות_Garmin', 'Set', 'Exercise Name', 'Time', 'Rest', 'Reps', 'Weight', 'Volume', 'Round', 'Laps', 'Distance km', 'Moving Time'];
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const stripBom = (t) => t.replace(/^﻿/, '');

export const activityIdFromFileName = (name) => /(\d{6,})/.exec(String(name ?? ''))?.[1] ?? null;

export function normalizeDate(s) {
  const t = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(t);
  return m ? t : null;
}

/** @returns {{ok:true, kind:'sets'|'rounds', csv:string, rows:number}|{ok:false, code:string}} */
export function singleToWide(bytes, { date, title, activityId }) {
  const d = normalizeDate(date);
  if (!d) return { ok: false, code: 'SINGLE_BAD_DATE' };
  if (!activityId || !/^\d+$/.test(String(activityId))) return { ok: false, code: 'SINGLE_BAD_ID' };
  const name = String(title ?? '').trim();
  if (!name) return { ok: false, code: 'SINGLE_BAD_TITLE' };
  const parsed = parseCsv(stripBom(new TextDecoder('utf-8').decode(bytes)));
  const table = Array.isArray(parsed) ? parsed : parsed.rows ?? parsed.records;
  if (!table || table.length < 2) return { ok: false, code: 'SINGLE_EMPTY' };
  const head = table[0].map((c) => c.trim());
  const idx = (c) => head.indexOf(c);
  const kind = idx('Set') >= 0 && idx('Exercise Name') >= 0 && idx('Round') < 0 ? 'sets' : idx('Round') >= 0 && idx('Exercise Name') >= 0 ? 'rounds' : null;
  if (!kind) return { ok: false, code: 'SINGLE_UNSUPPORTED' };
  const g = (r, c) => (idx(c) >= 0 ? (r[idx(c)] ?? '').trim() : '');
  const base = [`${name} ${d}`, name, d, activityId];
  const out = [WIDE.map(q).join(',')];
  let n = 0;
  for (const r of table.slice(1)) {
    if (r.every((c) => !String(c).trim())) continue;
    const round = g(r, 'Round');
    const isSub = kind === 'rounds' && /-/.test(round);
    const w = g(r, 'Weight');
    const row = kind === 'sets'
      ? [...base, g(r, 'Set'), g(r, 'Exercise Name'), g(r, 'Time'), g(r, 'Rest'), g(r, 'Reps'), w, g(r, 'Volume'), '', '', '', '']
      : [...base, '', g(r, 'Exercise Name'), g(r, 'Time'), isSub ? '0:00' : g(r, 'Rest'), g(r, 'Reps'), isSub ? (w && w !== 'Add Weight' ? w : 'Bodyweight') : '', '', round, '', '', ''];
    out.push(row.map(q).join(','));
    n++;
  }
  return { ok: true, kind, csv: out.join('\n') + '\n', rows: n };
}
