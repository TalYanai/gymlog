// Step 2f — Garmin unified workout CSV (unified_workouts.csv) → GymLog sessions. Pure and deterministic:
// the same file bytes, the same decisions and the same store give the same additions, byte for byte.
//
// Rules (2f; the approved Phase 3 draft adapted to the real file — see REPORT-2f.md):
//  - The file is read exactly (RFC 4180, UTF-8, BOM stripped). Every data row keeps its spreadsheet row
//    number (header = row 1) and its original strings. Nothing is guessed from similar names.
//  - Rows are grouped by Garmin activity ID (one activity → at most one session). Each activity is one
//    of: strength sets ("Set"), HIIT rounds ("Round"), or a run with laps ("Laps" + one Summary row).
//  - Exercise mapping is decided by the user per Garmin exercise name (and may be overridden per row).
//    Only an exact name/alias match (including a previously accepted custom Garmin exercise) is pre-selected.
//    "Choose an Exercise" is never mapped by name. Any other Garmin name requires an explicit user choice:
//    map to an existing exercise, accept under its ORIGINAL name as a new custom exercise (decision 'new')
//    with explicit load-basis confirmation when weights exist, or keep UNRESOLVED (values kept in sourceRaw only).
//  - The weight column is used as a load only when the user confirmed how to read it for that exercise
//    (or explicitly selected the load basis for a new custom Garmin exercise).
//    Otherwise load stays null and the raw value is kept. Nothing is converted between units.
//  - A run is one set: Summary distance and the user-chosen time column (Moving Time = moving, Time =
//    elapsed). Laps are kept verbatim in sourceRaw (Schema v2 gives CSV sets no splits: SPLIT_ORIGINS).
//  - HIIT: each exercise row ("1-1") is a set; its round row ("1") is kept with it in sourceRaw. A round
//    without an exercise row becomes an unresolved set of its own.
//  - Activities already imported (same Garmin ID) are skipped and listed; activities the user sets aside
//    go to quarantine with all their rows. Every data row is accounted for exactly once (reconcile()).
import { sha256Hex, canonicalize } from '../schema/canonical.js';
import { createExercise, snapshotMeasurement, emptyBodyweight } from '../schema/factories.js';
import { derivedPerformanceId, derivedSetId } from '../schema/ids.js';

export const GARMIN_RULES_VERSION = 1;
export const SOURCE_APP = 'garmin';
export const CHOOSE = 'Choose an Exercise';
/** Decision value: import the Garmin name as a new exercise under that name. */
export const NEW = 'new';
export const NEW_PREFIX = 'new:';
/** Decision value: ignore a minor/ambiguous Garmin exercise (do not create an exercise or performance; retain session). */
export const IGNORE = 'ignore';
export const NEW_LOAD_BASES = Object.freeze(['total', 'per_hand', 'per_side', 'implement', 'added']);
const COL = Object.freeze({ title: 'שם_אימון_תאריך', name: 'שם_האימון', date: 'תאריך', id: 'מזהה_פעילות_Garmin' });
/** Columns the importer reads; every other column is kept verbatim only. */
export const REQUIRED_COLUMNS = Object.freeze([COL.title, COL.name, COL.date, COL.id, 'Set', 'Exercise Name', 'Time', 'Rest', 'Reps', 'Weight', 'Volume', 'Round', 'Laps', 'Distance km', 'Moving Time']);
/** Measurement types a strength/HIIT row may be mapped to, and a run. */
export const ROW_TYPES = Object.freeze(['weight_reps', 'bodyweight_plus_load', 'bodyweight_reps', 'duration']);
export const RUN_TYPES = Object.freeze(['distance_duration']);
export const RUN_NAME = 'Running (Garmin)'; // the mapping key of run activities (not an exercise name)
const LOAD_TYPES = ['weight_reps', 'bodyweight_plus_load'];

const hex16 = async (s) => (await sha256Hex(s)).slice(0, 16);
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

// ---- RFC 4180 -------------------------------------------------------------------------------------------
/** Records with their 1-based record number. Throws on an unterminated quote. */
export function parseCsv(text) {
  const records = [];
  let rec = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let sawAny = false;
  const endField = () => { rec.push(field); field = ''; };
  const endRecord = () => { endField(); records.push(rec); rec = []; sawAny = false; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"' && field === '') { quoted = true; sawAny = true; i += 1; continue; }
    if (c === ',') { endField(); sawAny = true; i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') { endRecord(); i += 2; continue; }
    if (c === '\n' || c === '\r') { endRecord(); i += 1; continue; }
    field += c; sawAny = true; i += 1;
  }
  if (quoted) throw new SyntaxError('unterminated quoted field');
  if (sawAny || field !== '' || rec.length) endRecord();
  return records;
}

// ---- value parsing (never guesses; null + the raw string when not parseable) -----------------------------
/** "8:48", "0:57.8", "03:08.0", "33:16", "1:02:03", "0" → seconds (may be fractional), or null. */
export function parseClock(s) {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const sec = Number(m[3]);
  if (sec >= 60 || Number(m[2]) >= 60 && m[1] !== undefined) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + sec;
}
/** "12.5 kg" → { kind:'number', value, unit }; "Bodyweight" / "Add Weight" / "--" / "" → kinds without a value. */
export function parseWeight(s) {
  const t = (s ?? '').trim();
  if (t === '') return { kind: 'empty', value: null, unit: null };
  if (t === '--') return { kind: 'none', value: null, unit: null };
  if (t === 'Bodyweight') return { kind: 'bodyweight', value: null, unit: null };
  if (t === 'Add Weight') return { kind: 'add_weight', value: null, unit: null };
  const m = /^(\d+(?:\.\d+)?) (kg|lbs?)$/.exec(t);
  if (!m) return { kind: 'unparsed', value: null, unit: null };
  return { kind: 'number', value: Number(m[1]), unit: m[2] === 'kg' ? 'kg' : 'lb' };
}
/** "10.0" → 10; "0.0" → 0; anything that is not a whole number → null. */
export function parseReps(s) {
  const t = (s ?? '').trim();
  if (!/^\d+(\.0+)?$/.test(t)) return null;
  return Number(t);
}
/** "27-10-2026" → "2026-10-27" (a real calendar date), else null. */
export function parseDate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((s ?? '').trim());
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

// ---- analysis -------------------------------------------------------------------------------------------
const nonEmptyCells = (header, cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']).filter(([, v]) => v !== ''));

const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Name key: lower case, everything except a-z, 0-9 and Hebrew letters removed ("Lat Pull-down" = "lat pulldown"). */
export const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9א-ת]/g, '');
/** Garmin names that are known to be an existing exercise (squashed Garmin name → exercise id). Nothing else is guessed. */
export const GARMIN_ALIASES = Object.freeze({
  weightedpullup: 'ex_weighted_pull_up',
  latpulldown: 'ex_lat_pulldown',
  cableoverheadtricepsextension: 'ex_overhead_extension',
  overheaddumbbelltricepsextension: 'ex_db_skull_crusher',
});

/** Exercises a Garmin name maps to automatically: equal after squashing (case/space/hyphen-insensitive), or a known alias; never "similar". */
function exactMatches(store, name, types) {
  const key = squash(name);
  if (!key) return [];
  return store.exercises
    .filter((e) => !e.archived && e.mergedInto === null && types.includes(e.measurement.type)
      && (squash(e.name) === key || GARMIN_ALIASES[key] === e.id || (Array.isArray(e.aliases) && e.aliases.some((al) => squash(al) === key))))
    .map((e) => e.id);
}

/**
 * Reads the file and describes everything the user must decide. Read-only.
 * @returns {Promise<{ok:true, analysis:object} | {ok:false, code:string, ...}>}
 */
export async function analyzeGarminCsv({ text, fileSha256, fileName, store }) {
  let records;
  try {
    records = parseCsv(text.startsWith('﻿') ? text.slice(1) : text);
  } catch (err) {
    return fail('CSV_UNREADABLE', { message: err.message });
  }
  if (records.length < 2) return fail('CSV_EMPTY');
  const header = records[0];
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return fail('CSV_UNSUPPORTED', { missingColumns: missing });
  if (new Set(header).size !== header.length) return fail('CSV_UNSUPPORTED', { reason: 'duplicate column names' });
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const problems = [];
  const rows = [];
  records.slice(1).forEach((cells, k) => {
    const row = k + 2;
    if (cells.length === 1 && cells[0] === '') return problems.push({ row, problem: 'empty_line' }); // a blank line is still reported
    if (cells.length !== header.length) return problems.push({ row, problem: 'column_count' });
    const get = (c) => cells[col[c]] ?? '';
    rows.push({ row, get, cells: nonEmptyCells(header, cells) });
  });
  if (problems.length) return fail('CSV_ROWS_INVALID', { problems });

  // activities by Garmin ID, in order of first appearance
  const byId = new Map();
  for (const r of rows) {
    const id = r.get(COL.id).trim();
    if (!/^\d+$/.test(id)) { problems.push({ row: r.row, problem: 'activity_id' }); continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  }
  const activities = [];
  for (const [id, list] of byId) {
    const first = list[0];
    const same = (c) => list.every((r) => r.get(c) === first.get(c));
    if (!same(COL.date) || !same(COL.name) || !same(COL.title)) problems.push({ row: first.row, problem: 'activity_inconsistent', activityId: id });
    const date = parseDate(first.get(COL.date));
    if (!date) problems.push({ row: first.row, problem: 'date', activityId: id });
    const contiguous = list.every((r, i) => i === 0 || r.row === list[i - 1].row + 1);
    const hasLaps = list.some((r) => r.get('Laps') !== '');
    const hasRound = list.some((r) => r.get('Round') !== '');
    const hasSet = list.some((r) => r.get('Set') !== '');
    const kind = hasLaps && !hasRound && !hasSet ? 'run' : hasRound && !hasLaps && !hasSet ? 'rounds' : hasSet && !hasLaps && !hasRound ? 'sets' : null;
    if (!kind) { problems.push({ row: first.row, problem: 'activity_kind', activityId: id }); continue; }
    const items = [];
    if (kind === 'sets') {
      for (const r of list) items.push({ rows: [r.row], primary: r, name: r.get('Exercise Name').trim() });
    } else if (kind === 'rounds') {
      const roundRows = new Map();
      for (const r of list) {
        const rd = r.get('Round').trim();
        if (/^\d+$/.test(rd)) roundRows.set(rd, r);
        else if (!/^\d+-\d+$/.test(rd)) problems.push({ row: r.row, problem: 'round' });
      }
      const used = new Set();
      for (const r of list) {
        const rd = r.get('Round').trim();
        if (/^\d+-\d+$/.test(rd)) {
          const parent = roundRows.get(rd.split('-')[0]);
          // a round row travels with its first exercise row; later exercise rows of the same round refer to it
          const carry = parent && !used.has(parent.row);
          if (parent) used.add(parent.row);
          items.push({ rows: carry ? [r.row, parent.row] : [r.row], primary: r, round: parent ?? null, name: r.get('Exercise Name').trim() });
        }
      }
      for (const r of roundRows.values()) if (!used.has(r.row)) items.push({ rows: [r.row], primary: r, round: r, name: r.get('Exercise Name').trim(), roundOnly: true });
      items.sort((a, b) => a.rows[0] - b.rows[0]);
    } else {
      const summaries = list.filter((r) => r.get('Laps') === 'Summary');
      if (summaries.length !== 1) { problems.push({ row: first.row, problem: 'run_summary', activityId: id }); continue; }
      const laps = list.filter((r) => r.get('Laps') !== 'Summary');
      if (!laps.every((r) => /^\d+$/.test(r.get('Laps')))) problems.push({ row: first.row, problem: 'laps', activityId: id });
      items.push({ rows: [summaries[0].row, ...laps.map((r) => r.row)], primary: summaries[0], laps, name: RUN_NAME, run: true });
    }
    const describe = (it) => {
      const p = it.primary;
      const w = parseWeight(p.get('Weight'));
      return {
        rows: it.rows, row: p.row, name: it.name, run: !!it.run, roundOnly: !!it.roundOnly,
        set: p.get('Set') || null, round: it.round ? it.round.get('Round') : null,
        reps: parseReps(p.get('Reps')), repsRaw: p.get('Reps'),
        weight: w, weightRaw: p.get('Weight'),
        timeSec: parseClock(p.get('Time')), timeRaw: p.get('Time'), restRaw: p.get('Rest'), volumeRaw: p.get('Volume'),
        distanceKm: it.run ? (/^\d+(\.\d+)?$/.test(p.get('Distance km')) ? Number(p.get('Distance km')) : null) : null,
        movingSec: it.run ? parseClock(p.get('Moving Time')) : null, movingRaw: it.run ? p.get('Moving Time') : null,
        laps: it.run ? it.laps.length : 0,
        source: { rows: it.rows.map((n) => ({ row: n, cells: list.find((r) => r.row === n).cells })) },
      };
    };
    const its = items.map(describe);
    // "empty": nothing but unidentified rows without reps or a weight value (e.g. an activity started by mistake)
    const empty = its.every((x) => (x.name === CHOOSE || x.name === '') && !x.reps && x.weight.kind !== 'number');
    const fingerprint = `garmin:${id}`;
    const already = store.sessions.some((s) => s.origin === 'csv_import' && s.provenance?.fingerprint === fingerprint)
      || store.quarantine.some((q) => q.raw?.source === 'garmin_csv' && q.raw?.activityId === id);
    const sameDate = date ? store.sessions.filter((s) => s.date === date && !(s.origin === 'csv_import' && s.provenance?.fingerprint === fingerprint)).map((s) => s.id) : [];
    activities.push({
      id, fingerprint, title: first.get(COL.title), workoutName: first.get(COL.name), dateRaw: first.get(COL.date), date, kind, contiguous,
      rowStart: Math.min(...list.map((r) => r.row)), rowEnd: Math.max(...list.map((r) => r.row)), rowCount: list.length,
      items: its, empty, status: already ? 'already' : empty ? 'empty' : sameDate.length ? 'same_date' : 'new', sameDate,
    });
  }
  if (problems.length) return fail('CSV_ROWS_INVALID', { problems });

  // names to decide (strength / HIIT rows; runs share one key); "Choose an Exercise" is never mapped by name
  const names = new Map();
  for (const a of activities) {
    if (a.status === 'already') continue;
    for (const it of a.items) {
      const key = it.run ? RUN_NAME : it.name;
      if (key === CHOOSE || key === '' || it.roundOnly) continue;
      const n = names.get(key) ?? { name: key, run: it.run, rows: 0, suggested: null };
      n.rows += it.rows.length;
      names.set(key, n);
    }
  }
  for (const n of names.values()) {
    const m = n.run ? [] : exactMatches(store, n.name, ROW_TYPES);
    n.suggested = m.length === 1 ? m[0] : null;
  }
  const units = [...new Set(activities.flatMap((a) => a.items.map((x) => x.weight.unit)).filter(Boolean))].sort();
  const alreadyFile = store.meta.importLog.some((e) => e.kind === 'csv_import' && e.sourceSha256 === fileSha256);
  return {
    ok: true,
    analysis: {
      rulesVersion: GARMIN_RULES_VERSION, sourceApp: SOURCE_APP, fileName, fileSha256, header, dataRows: rows.length,
      constants: { runName: RUN_NAME, choose: CHOOSE, rowTypes: [...ROW_TYPES], runTypes: [...RUN_TYPES] },
      activities, names: [...names.values()], units, alreadyFile,
      hasRuns: activities.some((a) => a.kind === 'run' && a.status !== 'already'),
    },
  };
}

// ---- decisions --------------------------------------------------------------------------------------------
/** Default decisions: exact/alias matches pre-selected; any other non-run name defaults to NEW (kept under its own Garmin name,
 *  nothing guessed; the load basis is still asked); runs and the load/unit questions stay open; empty activities set aside. */
export function defaultDecisions(analysis) {
  return {
    datesConfirmed: false,
    unit: null,
    runTimeBasis: null,
    names: Object.fromEntries(analysis.names.filter((n) => n.suggested || !n.run).map((n) => [n.name, n.suggested ?? NEW])),
    rows: {},
    load: {},
    activities: Object.fromEntries(analysis.activities.filter((a) => a.status === 'new' || a.status === 'empty').map((a) => [a.id, a.status === 'empty' ? 'aside' : 'import'])),
  };
}

const exerciseOf = (store, id) => store.exercises.find((e) => e.id === id) ?? null;

export const SWIM_ID = 'ex_swim_freestyle';
export const HIIT_ID = 'ex_hiit';
export const SWIM_TITLE = 'שחייה';

/**
 * Pool Swim / HIIT activities: the exercise data they map to, or null when the file does not hold what is needed.
 * Swim: the row with a distance and an elapsed time. HIIT: total = sum of Time + Rest of every "Round N" row.
 * @returns {{kind:'swim'|'hiit', durationSec:number, distanceM:number|null, rows:number[], sourceRows:{row:number,cells:object}[]}|null}
 */
function special(a) {
  const name = String(a.workoutName ?? '').trim();
  if (a.kind === 'sets' && /^(pool swim|חתירה|שחייה)$/i.test(name)) {
    for (const it of a.items) {
      const r = it.source.rows[0];
      const km = Number(r?.cells?.['Distance km']);
      if (r && r.cells['Distance km'] !== undefined && Number.isFinite(km) && it.timeSec !== null) {
        return { kind: 'swim', durationSec: Math.round(it.timeSec), distanceM: Math.round(km * 1000), rows: it.rows, sourceRows: it.source.rows };
      }
    }
    return null;
  }
  if (a.kind === 'rounds' && /hiit/i.test(name)) {
    const seen = new Map();
    for (const it of a.items) for (const r of it.source.rows) seen.set(r.row, r);
    const sourceRows = [...seen.values()].sort((x, y) => x.row - y.row);
    const rounds = sourceRows.filter((r) => /^Round \d+$/.test(String(r.cells?.['Exercise Name'] ?? '').trim()));
    if (!rounds.length) return null;
    const parts = rounds.map((r) => [parseClock(r.cells.Time ?? ''), parseClock(r.cells.Rest ?? '') ?? 0]);
    if (parts.some(([t]) => t === null)) return null;
    return { kind: 'hiit', durationSec: Math.round(parts.reduce((s, [t, rest]) => s + t + rest, 0)), distanceM: null, rows: sourceRows.map((r) => r.row), sourceRows };
  }
  return null;
}

/** The target of one item: an exercise id, 'ignore', or null (unresolved). Undefined = still undecided. */
function targetOf(item, decisions) {
  const pick = (v) => (v === IGNORE ? IGNORE : v === 'unresolved' ? null : v === NEW ? (item.run || item.name === CHOOSE || item.name === '' || item.roundOnly ? null : `${NEW_PREFIX}${item.name}`) : v);
  if (Object.hasOwn(decisions.rows, item.row)) return pick(decisions.rows[item.row]);
  if (item.name === CHOOSE || item.name === '' || item.roundOnly) {
    const key = item.roundOnly ? 'Round' : item.name;
    if (Object.hasOwn(decisions.names, key) && decisions.names[key] === IGNORE) return IGNORE;
    return null;
  }
  const key = item.run ? RUN_NAME : item.name;
  if (!Object.hasOwn(decisions.names, key)) return undefined;
  return pick(decisions.names[key]);
}

/**
 * What is still missing before an import can be built. Every entry is a user decision; nothing is defaulted.
 * @returns {{kind:string, ref:string|null}[]}
 */
export function missingDecisions(analysis, decisions, store) {
  const out = [];
  if (decisions.datesConfirmed !== true) out.push({ kind: 'dates', ref: null });
  const imported = analysis.activities.filter((a) => a.status !== 'already' && decisions.activities[a.id] === 'import');
  for (const a of analysis.activities) if (a.status !== 'already' && !['import', 'aside'].includes(decisions.activities[a.id])) out.push({ kind: 'activity', ref: a.id });
  const usedLoad = new Set();
  for (const a of imported) {
    for (const it of a.items) {
      const t = targetOf(it, decisions);
      if (t === undefined) { out.push({ kind: 'name', ref: it.run ? RUN_NAME : it.name }); continue; }
      if (t === null || t === IGNORE) continue;
      if (t.startsWith(NEW_PREFIX)) {
        if (it.weight.kind === 'number') usedLoad.add(t);
        continue;
      }
      const ex = exerciseOf(store, t);
      const allowed = it.run ? RUN_TYPES : ROW_TYPES;
      if (!ex || ex.archived || ex.mergedInto !== null || !allowed.includes(ex.measurement.type)) { out.push({ kind: 'invalid_target', ref: String(it.row) }); continue; }
      if (LOAD_TYPES.includes(ex.measurement.type) && it.weight.kind === 'number') usedLoad.add(t);
      if (it.run && !['moving', 'elapsed'].includes(decisions.runTimeBasis)) out.push({ kind: 'run_time', ref: null });
    }
  }
  for (const id of usedLoad) {
    const valid = id.startsWith(NEW_PREFIX) ? [...NEW_LOAD_BASES, 'unknown'] : ['basis', 'unknown'];
    if (!valid.includes(decisions.load[id])) out.push({ kind: 'load', ref: id });
  }
  for (const a of imported) {
    for (const it of a.items) {
      const t = targetOf(it, decisions);
      if (typeof t === 'string' && t.startsWith(NEW_PREFIX)) {
        const rawName = t.slice(NEW_PREFIX.length);
        const existingConflict = store.exercises.find((e) => sameName(e.name, rawName) && (e.archived || e.mergedInto !== null));
        if (existingConflict) { out.push({ kind: 'invalid_target', ref: String(it.row) }); continue; }
        const existingActive = store.exercises.find((e) => !e.archived && e.mergedInto === null && sameName(e.name, rawName));
        const loadChoice = decisions.load[t];
        if (existingActive && it.weight.kind === 'number' && NEW_LOAD_BASES.includes(loadChoice)) {
          const expectedType = loadChoice === 'added' ? 'bodyweight_plus_load' : 'weight_reps';
          if (existingActive.measurement.type !== expectedType || existingActive.measurement.loadBasis !== loadChoice) {
            out.push({ kind: 'invalid_target', ref: String(it.row) });
          }
        }
      }
    }
  }
  // The weight unit is always confirmed by the user (provenance.weightUnitConfirmed): the unit written in
  // the file when there is one, the user's choice when the file has no weights at all.
  if (analysis.units.length > 1) out.push({ kind: 'mixed_units', ref: analysis.units.join(',') });
  else if (analysis.units.length === 1 ? decisions.unit !== analysis.units[0] : !['kg', 'lb'].includes(decisions.unit)) out.push({ kind: 'unit', ref: null });
  const seen = new Set();
  return out.filter((m) => { const k = `${m.kind}|${m.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Normalized decisions (only the parts that matter), for the package hash. */
function normalized(analysis, decisions) {
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const norm = {
    datesConfirmed: decisions.datesConfirmed === true,
    unit: decisions.unit ?? null,
    runTimeBasis: decisions.runTimeBasis ?? null,
    names: sortObj(decisions.names ?? {}),
    rows: sortObj(Object.fromEntries(Object.entries(decisions.rows ?? {}).map(([k, v]) => [String(k), v]))),
    load: sortObj(decisions.load ?? {}),
    activities: sortObj(Object.fromEntries(analysis.activities.filter((a) => a.status !== 'already').map((a) => [a.id, decisions.activities[a.id]]))),
  };
  if (decisions.rowLoad && Object.keys(decisions.rowLoad).length > 0) {
    norm.rowLoad = sortObj(Object.fromEntries(Object.entries(decisions.rowLoad).map(([k, v]) => [String(k), v])));
  }
  return norm;
}

// ---- build ------------------------------------------------------------------------------------------------
const W = (code, ref) => ({ code, ref });

/**
 * Builds the additions for Store.appendCsvImport. Pure, deterministic.
 * @returns {Promise<{ok:true, additions:object|null, report:object} | {ok:false, code:string, missing?:object[]}>}
 */
export async function buildGarminImport(analysis, decisions, { store, importedAt }) {
  if (analysis.alreadyFile) return fail('ALREADY_IMPORTED');
  const missing = missingDecisions(analysis, decisions, store);
  if (missing.length) return fail('DECISIONS_INCOMPLETE', { missing });
  const norm = normalized(analysis, decisions);
  const packageSha256 = await sha256Hex(canonicalize({ format: 'gymlog-garmin-csv-plan', rulesVersion: GARMIN_RULES_VERSION, fileSha256: analysis.fileSha256, decisions: norm }));
  const importId = `imp_csv_${packageSha256.slice(0, 16)}`;
  const unit = decisions.unit ?? null;
  const warnings = [];
  const sessions = [];
  const quarantine = [];
  const newExercises = new Map();
  const unresolvedUsed = [];
  const accounted = new Map(); // row → where it went

  async function unresolvedExercise(name) {
    const label = name === '' ? '(ללא שם)' : name;
    const id = `ex_csvu_${await hex16(`${SOURCE_APP}\u0000${label}`)}`;
    const existing = exerciseOf(store, id) ?? newExercises.get(id);
    const ex = existing ?? createExercise({ id, name: label, measurement: { type: 'unresolved' }, isCustom: true, now: importedAt });
    if (!existing) newExercises.set(id, ex);
    if (!unresolvedUsed.includes(id)) unresolvedUsed.push(id);
    return ex;
  }

  // A name accepted as-is: a normal custom exercise (deterministic id from the Garmin name). If an earlier
  // import already created an active, unmerged exercise for this name, it is reused only if its load semantics
  // match; if the user selected 'unknown' load semantics for a weighted NEW exercise, it MUST NOT fabricate a
  // bodyweight_reps exercise (AUD-01) and is instead preserved as an unresolved exercise (ex_csvu_*) so no
  // numeric weight is misinterpreted or lost.
  const rowsOfName = new Map();
  for (const a of analysis.activities) {
    if (a.status === 'already' || decisions.activities[a.id] !== 'import') continue;
    for (const it of a.items) {
      const t = targetOf(it, decisions);
      if (t === `${NEW_PREFIX}${it.name}`) {
        if (!rowsOfName.has(it.name)) rowsOfName.set(it.name, []);
        rowsOfName.get(it.name).push(it);
      }
    }
  }
  async function acceptedExercise(name) {
    const its = rowsOfName.get(name) ?? [];
    const hasWeight = its.some((x) => x.weight.kind === 'number');
    const loadChoice = decisions.load[`${NEW_PREFIX}${name}`];
    if (hasWeight && loadChoice === 'unknown') {
      return unresolvedExercise(name);
    }
    const id = `ex_csvn_${await hex16(`${SOURCE_APP}\u0000${name}`)}`;
    const existingById = exerciseOf(store, id);
    const existingByName = store.exercises.find((e) => !e.archived && e.mergedInto === null && sameName(e.name, name)) ?? null;
    const existing = (existingById && !existingById.archived && existingById.mergedInto === null ? existingById : existingByName) ?? newExercises.get(id);
    if (existing) {
      if (existing.measurement.type === 'unresolved' && !unresolvedUsed.includes(existing.id)) unresolvedUsed.push(existing.id);
      return existing;
    }
    const hasConfirmedLoad = hasWeight && NEW_LOAD_BASES.includes(loadChoice);
    const type = hasConfirmedLoad ? (loadChoice === 'added' ? 'bodyweight_plus_load' : 'weight_reps') : its.some((x) => x.reps !== null && x.reps > 0) || !its.some((x) => x.timeSec > 0) ? 'bodyweight_reps' : 'duration';
    const measurement = hasConfirmedLoad ? { type, loadBasis: loadChoice, loadUnit: unit } : { type };
    const ex = createExercise({ id, name, measurement, isCustom: true, now: importedAt });
    newExercises.set(id, ex);
    return ex;
  }

  for (const a of analysis.activities) {
    if (a.status === 'already') {
      warnings.push(W('CSV_ACTIVITY_ALREADY_IMPORTED', a.fingerprint));
      for (const it of a.items) for (const r of it.rows) accounted.set(r, 'already');
      continue;
    }
    if (decisions.activities[a.id] === 'aside') {
      const qid = `q_csv_${await hex16(`${SOURCE_APP}\u0000${a.id}`)}`;
      const rows = a.items.flatMap((it) => it.source.rows).sort((x, y) => x.row - y.row);
      quarantine.push({ id: qid, importId, reason: 'user_quarantined_import', raw: { source: 'garmin_csv', activityId: a.id, title: a.title, date: a.dateRaw, rows } });
      warnings.push(W('CSV_ACTIVITY_SET_ASIDE', a.fingerprint));
      for (const r of rows) accounted.set(r.row, `quarantine:${qid}`);
      continue;
    }
    const sessionId = `ses_csv_${await hex16(`${SOURCE_APP}\u0000${a.id}`)}`;
    const sw = [];
    const performances = [];
    // Pool Swim / HIIT activities are mapped at import time (same result as scripts/fix-garmin-activities.mjs): Pool Swim →
    // pool swimming in the rowing/freestyle stroke (distance + elapsed time), titled "שחייה"; HIIT → one HIIT duration = sum of
    // Time + Rest of all rounds. Applies only while no row was mapped by the user to an existing exercise (ignored, unresolved
    // "Choose an Exercise" and default NEW names are replaced; their rows stay in sourceRaw), so no clutter exercise is created.
    let swimTitle = null;
    let useSpecial = false;
    const mapped = special(a);
    if (mapped && a.items.every((it) => { const t = targetOf(it, decisions); return t === IGNORE || t === null || (typeof t === 'string' && t.startsWith(NEW_PREFIX)); })) {
      const exId = mapped.kind === 'swim' ? SWIM_ID : HIIT_ID;
      const found = exerciseOf(store, exId) ?? newExercises.get(exId) ?? null;
      const ex = found ?? (mapped.kind === 'swim'
        ? createExercise({ id: SWIM_ID, name: 'שחייה – חתירה', group: 'קרדיו', equipment: 'בריכה', measurement: { type: 'distance_duration' }, isCustom: true, now: importedAt })
        : createExercise({ id: HIIT_ID, name: 'HIIT', group: 'קרדיו', equipment: 'משקל גוף', measurement: { type: 'duration' }, isCustom: true, now: importedAt }));
      if (ex.measurement.type === (mapped.kind === 'swim' ? 'distance_duration' : 'duration') && !ex.archived && ex.mergedInto === null) {
        useSpecial = true;
        if (!found) newExercises.set(exId, ex);
        const set = { id: derivedSetId(sessionId, 1, 1), order: 1, completed: true, load: null, reps: null, durationSec: mapped.durationSec, distanceM: mapped.distanceM, ...(mapped.kind === 'swim' ? { durationBasis: 'elapsed' } : {}), sourceRef: { row: mapped.rows[0] }, sourceRaw: { rows: mapped.sourceRows } };
        for (const r of mapped.rows) accounted.set(r, `set:${set.id}`);
        for (const it of a.items) for (const r of it.rows) if (!accounted.has(r)) accounted.set(r, 'ignored');
        performances.push({ id: derivedPerformanceId(sessionId, 1), exerciseId: ex.id, order: 1, nameSnapshot: ex.name, measurement: snapshotMeasurement(ex), note: null, sets: [set] });
        if (mapped.kind === 'swim') swimTitle = SWIM_TITLE;
      }
    }
    // group consecutive items with the same target into performances (skipping ignored minor items while retaining the session)
    const groups = [];
    for (const it of useSpecial ? [] : a.items) {
      const t = targetOf(it, decisions);
      if (t === IGNORE) {
        for (const r of it.rows) accounted.set(r, 'ignored');
        continue;
      }
      const ex = t === null ? await unresolvedExercise(it.run ? RUN_NAME : it.roundOnly ? 'Round' : it.name) : t.startsWith(NEW_PREFIX) ? await acceptedExercise(t.slice(NEW_PREFIX.length)) : exerciseOf(store, t);
      const last = groups.at(-1);
      if (last && last.ex.id === ex.id) last.items.push(it);
      else groups.push({ ex, items: [it] });
    }
    for (const [pi, g] of groups.entries()) {
      const m = snapshotMeasurement(g.ex);
      const type = m.type;
      if (LOAD_TYPES.includes(type) && unit) m.loadUnit = unit;
      const perfId = derivedPerformanceId(sessionId, pi + 1);
      const sets = [];
      for (const [si, it] of g.items.entries()) {
        const set = { id: derivedSetId(sessionId, pi + 1, si + 1), order: si + 1, completed: true, load: null, reps: null, durationSec: null, distanceM: null };
        const setW = [];
        const ref = `row:${it.row}`;
        if (type === 'distance_duration') {
          set.durationBasis = null;
          set.distanceM = it.distanceKm === null ? null : Math.round(it.distanceKm * 10000) / 10;
          const sec = decisions.runTimeBasis === 'moving' ? it.movingSec : it.timeSec;
          if (sec !== null) {
            set.durationSec = Math.round(sec);
            set.durationBasis = decisions.runTimeBasis;
            if (set.durationSec !== sec) setW.push('CSV_TIME_ROUNDED');
          }
          if (set.distanceM === null || set.durationSec === null) { set.completed = false; setW.push('CSV_VALUE_MISSING'); }
        } else if (type === 'unresolved') {
          // values stay in sourceRaw only (D8: an unresolved performance carries no metrics)
          if (it.weight.kind === 'number') {
            const newLoad = decisions.load[`${NEW_PREFIX}${it.name}`];
            if (newLoad === 'unknown') setW.push('CSV_LOAD_SEMANTICS_UNRESOLVED');
          }
        } else {
          if (type !== 'duration') {
            if (it.reps !== null && it.reps > 0) set.reps = it.reps;
            else { set.completed = false; setW.push(it.reps === 0 ? 'CSV_ZERO_REPS' : 'CSV_VALUE_MISSING'); }
          } else if (it.timeSec !== null && it.timeSec > 0) {
            set.durationSec = Math.round(it.timeSec);
            if (set.durationSec !== it.timeSec) setW.push('CSV_TIME_ROUNDED');
          } else { set.completed = false; setW.push('CSV_VALUE_MISSING'); }
          if (LOAD_TYPES.includes(type)) {
            if (it.weight.kind === 'number') {
              const newLoad = g.ex.id.startsWith('ex_csvn_') ? decisions.load[`${NEW_PREFIX}${g.ex.name}`] : null;
              const rowLoadUnknown = decisions.rowLoad?.[it.row] === 'unknown' || decisions.rowLoad?.[String(it.row)] === 'unknown';
              if (!rowLoadUnknown && (decisions.load[g.ex.id] === 'basis' || (newLoad && NEW_LOAD_BASES.includes(newLoad))) && it.weight.unit === unit) set.load = it.weight.value;
              else setW.push('CSV_LOAD_SEMANTICS_UNRESOLVED');
            } else if (type === 'weight_reps') setW.push('CSV_NO_LOAD');
          } else if (it.weight.kind === 'number') {
            const newLoad = g.ex.id.startsWith('ex_csvn_') ? decisions.load[`${NEW_PREFIX}${g.ex.name}`] : null;
            setW.push(newLoad === 'unknown' ? 'CSV_LOAD_SEMANTICS_UNRESOLVED' : 'CSV_LOAD_NOT_RECORDED');
          }
        }
        set.sourceRef = { row: it.row };
        set.sourceRaw = it.source;
        if (setW.length) set.warnings = setW;
        for (const c of setW) { warnings.push(W(c, ref)); if (!sw.includes(c)) sw.push(c); }
        for (const r of it.rows) accounted.set(r, `set:${set.id}`);
        sets.push(set);
      }
      if (type === 'unresolved') warnings.push(W('CSV_UNKNOWN_EXERCISE', `${g.ex.id}@${sessionId}`));
      performances.push({ id: perfId, exerciseId: g.ex.id, order: pi + 1, nameSnapshot: g.ex.name, measurement: m, note: null, sets });
    }
    if (a.sameDate.length) { warnings.push(W('CSV_SAME_DATE_AS_EXISTING', `${a.fingerprint}~${a.sameDate.join(',')}`)); sw.push('CSV_SAME_DATE_AS_EXISTING'); }
    if (!a.contiguous) { warnings.push(W('CSV_ACTIVITY_NOT_CONTIGUOUS', a.fingerprint)); sw.push('CSV_ACTIVITY_NOT_CONTIGUOUS'); }
    const run = a.kind === 'run';
    sessions.push({
      id: sessionId, origin: 'csv_import',
      provenance: {
        importId, sourceApp: SOURCE_APP, fileName: analysis.fileName, fileSha256: analysis.fileSha256, packageSha256,
        rowStart: a.rowStart, rowEnd: a.rowEnd, weightUnitConfirmed: unit, dateSource: 'user_confirmed',
        fingerprint: a.fingerprint, durationBasisConfirmed: run ? decisions.runTimeBasis : null,
      },
      date: a.date, startedAt: null, endedAt: null, templateId: null, templateNameSnapshot: swimTitle ?? (a.workoutName || null),
      bodyweight: emptyBodyweight(), note: swimTitle && a.title ? a.title.replace(/^(Pool Swim|חתירה)/i, SWIM_TITLE) : (a.title || null), warnings: [...new Set(sw)].sort(), recovery: null,
      createdAt: importedAt, updatedAt: importedAt, performances,
    });
  }

  const rec = reconcile(analysis, accounted);
  if (!rec.ok) return fail('RECONCILE_FAILED', rec);
  if (sessions.length === 0 && quarantine.length === 0) return { ok: true, additions: null, report: { reconciliation: rec, importId: null } };
  const counts = {
    sessions: sessions.length,
    performances: sessions.reduce((n, s) => n + s.performances.length, 0),
    sets: sessions.reduce((n, s) => n + s.performances.reduce((m, p) => m + p.sets.length, 0), 0),
    quarantined: quarantine.length,
  };
  const entry = {
    importId, kind: 'csv_import', status: 'pending', at: importedAt, reportSeenAt: null,
    sourceSha256: analysis.fileSha256, packageSha256, counts, unresolvedExercises: [...unresolvedUsed].sort(), warnings,
    calculationChanges: [],
  };
  return { ok: true, additions: { exercises: [...newExercises.values()], sessions, quarantine, entry }, report: { reconciliation: rec, importId, packageSha256, counts } };
}

/** Every data row is accounted for exactly once: imported into a set, set aside in quarantine, ignored, or already imported. */
export function reconcile(analysis, accounted) {
  const all = analysis.activities.flatMap((a) => a.items.flatMap((it) => it.rows));
  const expected = analysis.dataRows;
  const unique = new Set(all);
  const missingRows = [];
  for (let r = 2; r < 2 + expected; r++) if (!accounted.has(r)) missingRows.push(r);
  const by = { set: 0, quarantine: 0, already: 0, ignored: 0 };
  for (const v of accounted.values()) by[v.split(':')[0]] += 1;
  const ok = unique.size === all.length && all.length === expected && missingRows.length === 0 && accounted.size === expected;
  return { ok, dataRows: expected, imported: by.set, setAside: by.quarantine, ignored: by.ignored, alreadyImported: by.already, missingRows, duplicateRows: all.length - unique.size };
}

/** Rows referenced by stored CSV data of one import (sets' sourceRaw + quarantine raw), for verification after the write. */
export function storedRowsOf(store, importId) {
  const rows = [];
  for (const s of store.sessions) if (s.origin === 'csv_import' && s.provenance.importId === importId) {
    for (const p of s.performances) for (const set of p.sets) for (const r of set.sourceRaw?.rows ?? []) rows.push(r.row);
  }
  for (const q of store.quarantine) if (q.importId === importId) for (const r of q.raw?.rows ?? []) rows.push(r.row);
  return rows.sort((a, b) => a - b);
}
