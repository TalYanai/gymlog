// Garmin Archive & FIT Parser (June 1, 2026+ complete history import).
// Pure Node/ES module that reads Garmin Connect exports (summarizedActivities.json + UploadedFiles ZIPs
// containing binary .fit files + optional unified_workouts.csv user-edited overrides) and converts
// them into canonical GymLog V2 csv_import rows and store additions.
import { sha256Hex } from '../schema/canonical.js';
import { REQUIRED_COLUMNS, CHOOSE, RUN_NAME, NEW, IGNORE, analyzeGarminCsv, buildGarminImport, parseCsv } from './garmin-csv.js';

export const GARMIN_EPOCH_OFFSET = 631065600; // Seconds between 1970-01-01T00:00:00Z and 1989-12-31T00:00:00Z

export const ARCHIVE_CSV_COLUMNS = Object.freeze([
  ...REQUIRED_COLUMNS,
  'Activity Type',
  'Start Time UTC',
  'Start Time Local',
  'Source File',
  'FIT Category',
  'FIT SubCategory',
  'Avg HR',
  'Max HR',
]);

/**
 * Standard Garmin FIT Profile exercise_category + exercise_category_subtype -> Garmin Connect display name.
 * Unknown/unclassified categories (65534 / null) map to 'Choose an Exercise'.
 */
export const FIT_CATEGORY_TO_GARMIN_NAME = Object.freeze({
  '65534:null': CHOOSE,
  'null:null': CHOOSE,
  '0:null': 'Bench Press',
  '0:0': 'Barbell Bench Press',
  '2:6': 'Jump Rope',
  '2:12': 'Jumping Jacks',
  '7:null': 'Curl',
  '8:0': 'Barbell Deadlift',
  '8:null': 'Deadlift',
  '9:2': 'Dumbbell Flye',
  '9:null': 'Flye',
  '14:null': 'Lateral Raise',
  '21:null': 'Pull-up',
  '21:21': 'Weighted Pull-up',
  '22:null': 'Push-up',
  '23:null': 'Row',
  '27:null': 'Sit-up',
  '28:null': 'Squat',
  '30:null': 'Triceps Extension',
  '30:6': 'Dumbbell Kickback',
  '30:8': 'Cable Overhead Triceps Extension',
});

export function fitCategoryToGarminName(catField, subField) {
  const c0 = Array.isArray(catField) ? catField[0] : catField;
  const s0 = Array.isArray(subField) ? subField[0] : subField;
  const key = `${c0 ?? null}:${s0 ?? null}`;
  if (Object.hasOwn(FIT_CATEGORY_TO_GARMIN_NAME, key)) return FIT_CATEGORY_TO_GARMIN_NAME[key];
  const fallbackKey = `${c0 ?? null}:null`;
  if (Object.hasOwn(FIT_CATEGORY_TO_GARMIN_NAME, fallbackKey)) return FIT_CATEGORY_TO_GARMIN_NAME[fallbackKey];
  return CHOOSE;
}

/** Minimal pure-JS Garmin FIT binary parser (supports normal and compressed-timestamp records + dev fields). */
export function parseFitBuffer(buf, { allowedMessages = null } = {}) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < 14) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerSize = dv.getUint8(0);
  const sig = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  if (sig !== '.FIT') return null;
  const dataSize = dv.getUint32(4, true);
  const end = Math.min(u8.byteLength, headerSize + dataSize);
  const allowSet = allowedMessages ? new Set(allowedMessages) : null;

  const defs = new Map();
  const messages = [];
  let offset = headerSize;
  const td = new TextDecoder('utf-8');

  function readVal(baseType, pos, size, littleEndian) {
    const typeNum = baseType & 0x1f;
    if (typeNum === 7) {
      let s = td.decode(u8.subarray(pos, pos + size));
      const nul = s.indexOf('\0');
      if (nul >= 0) s = s.slice(0, nul);
      return s;
    }
    const elemSize = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8][typeNum] ?? 1;
    const count = Math.floor(size / elemSize);
    const readOne = (p) => {
      switch (typeNum) {
        case 0:
        case 2:
        case 10:
        case 13: {
          if (elemSize === 1) {
            const v = dv.getUint8(p);
            const inv = typeNum === 10 ? 0x00 : 0xff;
            return v === inv ? null : v;
          }
          return null;
        }
        case 1: {
          const v = dv.getInt8(p);
          return v === 0x7f ? null : v;
        }
        case 3: {
          const v = dv.getInt16(p, littleEndian);
          return v === 0x7fff ? null : v;
        }
        case 4:
        case 11: {
          const v = dv.getUint16(p, littleEndian);
          const inv = typeNum === 11 ? 0x0000 : 0xffff;
          return v === inv ? null : v;
        }
        case 5: {
          const v = dv.getInt32(p, littleEndian);
          return v === 0x7fffffff ? null : v;
        }
        case 6:
        case 12: {
          const v = dv.getUint32(p, littleEndian);
          const inv = typeNum === 12 ? 0x00000000 : 0xffffffff;
          return v === inv ? null : v;
        }
        case 8: {
          const u = dv.getUint32(p, littleEndian);
          if (u === 0xffffffff) return null;
          return dv.getFloat32(p, littleEndian);
        }
        case 9:
          return dv.getFloat64(p, littleEndian);
        default:
          return null;
      }
    };
    if (count === 1) return readOne(pos);
    const arr = [];
    for (let i = 0; i < count; i++) arr.push(readOne(pos + i * elemSize));
    return arr;
  }

  while (offset < end) {
    const recHeader = dv.getUint8(offset++);
    const isCompressedTs = (recHeader & 0x80) !== 0;
    if (isCompressedTs) {
      const localMesgNum = (recHeader >> 5) & 0x03;
      const def = defs.get(localMesgNum);
      if (!def) break;
      if (allowSet && !allowSet.has(def.globalMesgNum)) {
        offset += def.totalSize;
        continue;
      }
      const fields = {};
      for (const f of def.fields) {
        if (offset + f.size > end) break;
        fields[f.num] = readVal(f.baseType, offset, f.size, def.littleEndian);
        offset += f.size;
      }
      for (const df of def.devFields) offset += df.size;
      messages.push({ globalMesgNum: def.globalMesgNum, fields });
      continue;
    }

    const isDefinition = (recHeader & 0x40) !== 0;
    const hasDevData = (recHeader & 0x20) !== 0;
    const localMesgNum = recHeader & 0x0f;

    if (isDefinition) {
      if (offset + 5 > end) break;
      offset += 1; // reserved
      const arch = dv.getUint8(offset++);
      const littleEndian = arch === 0;
      const globalMesgNum = dv.getUint16(offset, littleEndian);
      offset += 2;
      const numFields = dv.getUint8(offset++);
      const fields = [];
      let totalSize = 0;
      for (let i = 0; i < numFields; i++) {
        const num = dv.getUint8(offset++);
        const size = dv.getUint8(offset++);
        const baseType = dv.getUint8(offset++);
        fields.push({ num, size, baseType });
        totalSize += size;
      }
      const devFields = [];
      if (hasDevData) {
        const numDev = dv.getUint8(offset++);
        for (let i = 0; i < numDev; i++) {
          const num = dv.getUint8(offset++);
          const size = dv.getUint8(offset++);
          const devIdx = dv.getUint8(offset++);
          devFields.push({ num, size, devIdx });
          totalSize += size;
        }
      }
      defs.set(localMesgNum, { globalMesgNum, littleEndian, fields, devFields, totalSize });
    } else {
      const def = defs.get(localMesgNum);
      if (!def) break;
      if (allowSet && !allowSet.has(def.globalMesgNum)) {
        offset += def.totalSize;
        continue;
      }
      const fields = {};
      for (const f of def.fields) {
        if (offset + f.size > end) break;
        fields[f.num] = readVal(f.baseType, offset, f.size, def.littleEndian);
        offset += f.size;
      }
      for (const df of def.devFields) offset += df.size;
      messages.push({ globalMesgNum: def.globalMesgNum, fields });
    }
  }
  return messages;
}

/** Formats seconds into Garmin clock string ("MM:SS" or "H:MM:SS" or "M:SS.d"). */
export function formatGarminClock(sec, { decimals = false } = {}) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '0:00';
  const totalSec = decimals ? Math.round(sec * 10) / 10 : Math.round(sec);
  const hrs = Math.floor(totalSec / 3600);
  const rem = totalSec - hrs * 3600;
  const mins = Math.floor(rem / 60);
  const s = rem - mins * 60;
  const sStr = decimals
    ? (s < 10 ? `0${s.toFixed(1)}` : s.toFixed(1))
    : String(Math.round(s)).padStart(2, '0');
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${sStr}`;
  }
  return `${mins}:${sStr}`;
}

/** Converts YYYY-MM-DD to DD-MM-YYYY for Garmin CSV format. */
export function isoDateToGarminDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`Invalid ISO date: ${isoDate}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Converts Garmin timestamp (ms or string) to ISO string. */
export function parseGarminTimestampToIso(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return new Date(val).toISOString();
  if (typeof val === 'string' && val.trim()) {
    return new Date(val.trim().replace(' ', 'T').replace(/\.0$/, 'Z')).toISOString();
  }
  return null;
}

/** Formats weight from FIT raw uint16 (scale 16 -> kg) into Garmin CSV Weight string. */
export function formatFitWeight(rawWeight, { isHiit = false } = {}) {
  if (rawWeight === null || rawWeight === undefined) return isHiit ? 'Bodyweight' : '--';
  const kg = Math.round((rawWeight / 16) * 100) / 100;
  if (kg <= 0) return 'Bodyweight';
  return `${kg} kg`;
}

/** Escapes a single RFC 4180 CSV field. */
function csvCell(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

/** Serializes an array of row objects (keyed by header) into RFC 4180 CSV text. */
export function serializeGarminCsv(rowObjects, header = ARCHIVE_CSV_COLUMNS) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rowObjects) {
    lines.push(header.map((col) => csvCell(r[col] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Builds unified Garmin CSV rows for a single eligible activity from its summarizedActivities.json entry,
 * its matched binary .fit messages (if available), and optional user-reviewed CSV override rows (e.g., from
 * unified_workouts.csv where the user manually edited exercise names in Garmin Connect).
 */
export function buildActivityCsvRows({ summary, fitMsgs = null, fitFileName = null, csvOverrideRows = null }) {
  const id = String(summary.activityId);
  const utcIso = parseGarminTimestampToIso(summary.startTimeGmt ?? summary.beginTimestamp);
  const localIso = parseGarminTimestampToIso(summary.startTimeLocal ?? summary.beginTimestamp);
  const isoDate = localIso.slice(0, 10);
  const dateRaw = isoDateToGarminDate(isoDate);
  const workoutName = (summary.name && String(summary.name).trim()) || summary.activityType || 'Workout';
  const title = `${workoutName} ${dateRaw}`;
  const actType = summary.activityType;
  const sourceFile = fitFileName ? `UploadedFiles:${fitFileName}` : 'summarizedActivities.json';
  const avgHr = typeof summary.avgHr === 'number' ? String(Math.round(summary.avgHr)) : '';
  const maxHr = typeof summary.maxHr === 'number' ? String(Math.round(summary.maxHr)) : '';
  const baseMeta = {
    'Activity Type': actType,
    'Start Time UTC': utcIso ?? '',
    'Start Time Local': localIso ?? '',
    'Source File': sourceFile,
    'Avg HR': avgHr,
    'Max HR': maxHr,
  };

  // If we have exact user-exported CSV rows for this activityId AND they have non-empty sets/rounds/laps,
  // check whether to use their Exercise Name overrides or full rows.
  const activeSets = fitMsgs ? fitMsgs.filter((m) => m.globalMesgNum === 225 && m.fields[5] === 1) : [];
  const restSets = fitMsgs ? fitMsgs.filter((m) => m.globalMesgNum === 225 && m.fields[5] === 0) : [];
  const fitLaps = fitMsgs ? fitMsgs.filter((m) => m.globalMesgNum === 19) : [];

  // 1. Running & Treadmill Running -> 'run' kind (Laps 1..N + Summary)
  if (actType === 'running' || actType === 'treadmill_running') {
    const rows = [];
    for (let i = 0; i < fitLaps.length; i++) {
      const lf = fitLaps[i].fields;
      const lapDistKm = typeof lf[9] === 'number' ? (lf[9] / 100000).toFixed(2) : '0.00';
      const lapElapSec = typeof lf[7] === 'number' ? lf[7] / 1000 : 0;
      const lapMovSec = typeof lf[8] === 'number' ? lf[8] / 1000 : lapElapSec;
      rows.push({
        'שם_אימון_תאריך': title,
        'שם_האימון': workoutName,
        'תאריך': dateRaw,
        'מזהה_פעילות_Garmin': id,
        'Laps': String(i + 1),
        'Time': formatGarminClock(lapElapSec, { decimals: true }),
        'Distance km': lapDistKm,
        'Moving Time': formatGarminClock(lapMovSec, { decimals: true }),
        ...baseMeta,
      });
    }
    const totalDistKm = typeof summary.distance === 'number' ? (Math.round((summary.distance / 100000) * 100) / 100).toFixed(2) : '0.00';
    const sumElapSec = typeof summary.duration === 'number' ? summary.duration / 1000 : (typeof summary.elapsedDuration === 'number' ? summary.elapsedDuration / 1000 : 0);
    const sumMovSec = typeof summary.movingDuration === 'number' && summary.movingDuration > 0 ? summary.movingDuration / 1000 : sumElapSec;
    rows.push({
      'שם_אימון_תאריך': title,
      'שם_האימון': workoutName,
      'תאריך': dateRaw,
      'מזהה_פעילות_Garmin': id,
      'Laps': 'Summary',
      'Time': formatGarminClock(sumElapSec, { decimals: true }),
      'Distance km': totalDistKm,
      'Moving Time': formatGarminClock(sumMovSec, { decimals: true }),
      ...baseMeta,
    });
    return { kind: 'run', activityType: actType, rows };
  }

  // 2. HIIT -> 'rounds' kind (Round N + Round N-1 per active set)
  if (actType === 'hiit') {
    const rows = [];
    // Check if csvOverrideRows has matching Round rows for this activityId
    const overrideByRound = new Map();
    if (Array.isArray(csvOverrideRows)) {
      for (const r of csvOverrideRows) {
        if (r.Round) overrideByRound.set(String(r.Round).trim(), r);
      }
    }
    if (activeSets.length === 0) {
      // Fallback single round if a HIIT activity had 0 active sets
      const durSec = typeof summary.duration === 'number' ? summary.duration / 1000 : 0;
      rows.push({
        'שם_אימון_תאריך': title,
        'שם_האימון': workoutName,
        'תאריך': dateRaw,
        'מזהה_פעילות_Garmin': id,
        'Round': '1',
        'Exercise Name': 'Round 1',
        'Time': formatGarminClock(durSec, { decimals: true }),
        'Rest': '0:00',
        'Reps': '0.0',
        ...baseMeta,
      });
      return { kind: 'rounds', activityType: actType, rows };
    }
    for (let i = 0; i < activeSets.length; i++) {
      const sf = activeSets[i].fields;
      const rf = restSets[i]?.fields;
      const roundNum = String(i + 1);
      const subRound = `${i + 1}-1`;
      const durSec = typeof sf[0] === 'number' ? sf[0] / 1000 : 0;
      const restSec = typeof rf?.[0] === 'number' ? rf[0] / 1000 : 0;
      const reps = typeof sf[3] === 'number' ? sf[3] : 0;
      const ov = overrideByRound.get(subRound);
      const exName = ov?.['Exercise Name']?.trim() || fitCategoryToGarminName(sf[7], sf[8]);
      const weightStr = ov?.Weight?.trim() || formatFitWeight(sf[4], { isHiit: true });
      const timeStr = formatGarminClock(durSec, { decimals: true });
      const restStr = formatGarminClock(restSec, { decimals: true });
      const fitCat = Array.isArray(sf[7]) ? String(sf[7][0] ?? '') : String(sf[7] ?? '');
      const fitSub = Array.isArray(sf[8]) ? String(sf[8][0] ?? '') : String(sf[8] ?? '');

      rows.push({
        'שם_אימון_תאריך': title,
        'שם_האימון': workoutName,
        'תאריך': dateRaw,
        'מזהה_פעילות_Garmin': id,
        'Round': roundNum,
        'Exercise Name': `Round ${roundNum}`,
        'Time': timeStr,
        'Rest': restStr,
        'Reps': `${reps}.0`,
        'Weight': '',
        'Volume': '',
        ...baseMeta,
        'FIT Category': fitCat,
        'FIT SubCategory': fitSub,
      });
      rows.push({
        'שם_אימון_תאריך': title,
        'שם_האימון': workoutName,
        'תאריך': dateRaw,
        'מזהה_פעילות_Garmin': id,
        'Round': subRound,
        'Exercise Name': exName,
        'Time': timeStr,
        'Rest': '0:00',
        'Reps': `${reps}.0`,
        'Weight': weightStr,
        'Volume': '',
        ...baseMeta,
        'FIT Category': fitCat,
        'FIT SubCategory': fitSub,
      });
    }
    return { kind: 'rounds', activityType: actType, rows };
  }

  // 3. Strength Training -> 'sets' kind
  if (actType === 'strength_training') {
    const rows = [];
    const overrideBySet = new Map();
    if (Array.isArray(csvOverrideRows)) {
      for (const r of csvOverrideRows) {
        if (r.Set) overrideBySet.set(Number(r.Set), r);
      }
    }
    if (activeSets.length === 0) {
      // Manual strength entry in Garmin Connect without FIT set messages (e.g. 24854006411, 24854006644)
      const durSec = typeof summary.duration === 'number' ? summary.duration / 1000 : 0;
      rows.push({
        'שם_אימון_תאריך': title,
        'שם_האימון': workoutName,
        'תאריך': dateRaw,
        'מזהה_פעילות_Garmin': id,
        'Set': '1.0',
        'Exercise Name': CHOOSE,
        'Time': formatGarminClock(durSec),
        'Rest': '0:00',
        'Reps': '0.0',
        'Weight': 'Bodyweight',
        'Volume': '0.0',
        ...baseMeta,
      });
      return { kind: 'sets', activityType: actType, rows };
    }
    for (let i = 0; i < activeSets.length; i++) {
      const sf = activeSets[i].fields;
      const rf = restSets[i]?.fields;
      const setIdx = i + 1;
      const ov = overrideBySet.get(setIdx);
      const exName = ov?.['Exercise Name']?.trim() || fitCategoryToGarminName(sf[7], sf[8]);
      const durSec = typeof sf[0] === 'number' ? sf[0] / 1000 : 0;
      const restSec = typeof rf?.[0] === 'number' ? rf[0] / 1000 : 0;
      const reps = typeof sf[3] === 'number' ? sf[3] : 0;
      const wKg = typeof sf[4] === 'number' ? Math.round((sf[4] / 16) * 100) / 100 : null;
      const weightStr = ov?.Weight?.trim() || formatFitWeight(sf[4], { isHiit: false });
      const volStr = wKg && wKg > 0 && reps > 0 ? `${Math.round(wKg * reps * 100) / 100} kg` : '0.0';
      const fitCat = Array.isArray(sf[7]) ? String(sf[7][0] ?? '') : String(sf[7] ?? '');
      const fitSub = Array.isArray(sf[8]) ? String(sf[8][0] ?? '') : String(sf[8] ?? '');
      rows.push({
        'שם_אימון_תאריך': title,
        'שם_האימון': workoutName,
        'תאריך': dateRaw,
        'מזהה_פעילות_Garmin': id,
        'Set': `${setIdx}.0`,
        'Exercise Name': exName,
        'Time': formatGarminClock(durSec, { decimals: true }),
        'Rest': formatGarminClock(restSec, { decimals: true }),
        'Reps': `${reps}.0`,
        'Weight': weightStr,
        'Volume': volStr,
        ...baseMeta,
        'FIT Category': fitCat,
        'FIT SubCategory': fitSub,
      });
    }
    return { kind: 'sets', activityType: actType, rows };
  }

  // 4. Other activity types (lap_swimming, indoor_cycling, etc.) -> preserved as 'sets' with duration & raw metadata in cells
  const durSec = typeof summary.duration === 'number' ? summary.duration / 1000 : (typeof summary.elapsedDuration === 'number' ? summary.elapsedDuration / 1000 : 0);
  const movSec = typeof summary.movingDuration === 'number' && summary.movingDuration > 0 ? summary.movingDuration / 1000 : durSec;
  const distKm = typeof summary.distance === 'number' && summary.distance > 0 ? (Math.round((summary.distance / 100000) * 100) / 100).toFixed(2) : '';
  const sportLabel = actType === 'lap_swimming' ? 'Lap Swimming' : actType === 'indoor_cycling' ? 'Indoor Cycling' : workoutName;
  const rows = [
    {
      'שם_אימון_תאריך': title,
      'שם_האימון': workoutName,
      'תאריך': dateRaw,
      'מזהה_פעילות_Garmin': id,
      'Set': '1.0',
      'Exercise Name': sportLabel,
      'Time': formatGarminClock(durSec, { decimals: true }),
      'Rest': '0:00',
      'Reps': '',
      'Weight': '--',
      'Volume': '',
      'Distance km': distKm,
      'Moving Time': formatGarminClock(movSec, { decimals: true }),
      ...baseMeta,
    },
  ];
  return { kind: 'sets', activityType: actType, rows };
}

/**
 * Core-focused, non-guessing decision builder for Garmin archive imports:
 *  - Consolidates main recurring exercises and clear spelling/name variations onto existing GymLog catalog exercises:
 *      * 'Running (Garmin)' -> 'ex_run' (Run, distance_duration, runTimeBasis: 'moving')
 *      * 'Bench Press' / 'Barbell Bench Press' -> 'ex_bench_press' (Bench Press, total load for barbell sets >= 40 kg;
 *        sets < 40 kg have rowLoad = 'unknown' so per-hand dumbbell sets never mix with total barbell sets)
 *      * 'Pull-up' / 'Weighted Pull-up' -> 'ex_weighted_pull_up' (Weighted Pull-Up, added load for sets <= 45 kg;
 *        watch carry-over weights > 45 kg have rowLoad = 'unknown' so they never corrupt PRs/goals)
 *      * 'Lateral Raise' -> 'ex_lateral_raise' (Lateral Raise, per_hand load for sets <= 22.5 kg;
 *        watch carry-over weights > 22.5 kg have rowLoad = 'unknown' so they never corrupt PRs/charts)
 *      * 'Lat Pull Down' -> 'ex_lat_pulldown' (Lat Pulldown, total load)
 *      * 'Skull Crasher' -> 'ex_db_skull_crusher' (DB Skull Crusher, load = 'unknown' pending per-hand vs total review)
 *  - Ignores minor, one-off, warm-up, unclassified ('Choose an Exercise'), and ambiguous generic Garmin categories
 *    ('Curl', 'Row', 'Squat', 'Sit-up', 'Triceps Extension', 'Jump Rope', 'Dumbbell Flye', 'Barbell Deadlift' 0 kg,
 *    'Dumbbell Kickback', 'Jumping Jacks', 'WarmUp', 'Push-up', 'Lap Swimming', 'Indoor Cycling') via IGNORE ('ignore')
 *    so they do NOT create clutter in the exercise catalog or progress screen while all 111 workout sessions remain.
 */
export function buildSafeArchiveDecisions(analysis, store) {
  const decisions = {
    datesConfirmed: true,
    unit: 'kg',
    runTimeBasis: 'moving',
    names: {
      [CHOOSE]: IGNORE,
      '': IGNORE,
      Round: IGNORE,
    },
    rows: {},
    load: {},
    rowLoad: {},
    activities: {},
  };

  for (const a of analysis.activities) {
    if (a.status === 'already') continue;
    // Import all 111 activities so every workout session, date, title, and provenance is retained in history
    decisions.activities[a.id] = 'import';
  }

  for (const n of analysis.names) {
    if (n.run || n.name === RUN_NAME) {
      decisions.names[n.name] = 'ex_run';
      continue;
    }
    const name = n.name;

    if (name === 'Bench Press' || name === 'Barbell Bench Press') {
      decisions.names[name] = 'ex_bench_press';
      decisions.load.ex_bench_press = 'basis';
    } else if (name === 'Pull-up' || name === 'Weighted Pull-up' || name === 'Weighted Pull-Up') {
      decisions.names[name] = 'ex_weighted_pull_up';
      decisions.load.ex_weighted_pull_up = 'basis';
    } else if (name === 'Lateral Raise') {
      decisions.names[name] = 'ex_lateral_raise';
      decisions.load.ex_lateral_raise = 'basis';
    } else if (name === 'Lat Pull Down' || name === 'Lat Pulldown') {
      decisions.names[name] = 'ex_lat_pulldown';
      decisions.load.ex_lat_pulldown = 'basis';
    } else if (name === 'Skull Crasher' || name === 'Skull Crusher' || name === 'DB Skull Crusher') {
      decisions.names[name] = 'ex_db_skull_crusher';
      // Per gymlog-personal.json, DB Skull Crusher load basis (per_hand vs total) requires user review
      decisions.load.ex_db_skull_crusher = 'unknown';
    } else {
      // Minor, one-off, warm-up, or ambiguous generic Garmin exercise names (Curl, Row, Squat, Jump Rope,
      // Sit-up, Triceps Extension, Dumbbell Flye, Barbell Deadlift 0kg, Dumbbell Kickback, Jumping Jacks,
      // WarmUp, Push-up, Lap Swimming, Indoor Cycling): ignore so no separate or unresolved exercises clutter the catalog.
      decisions.names[name] = IGNORE;
    }
  }

  // Per-row load safety filtering for core exercises:
  // Prevent incompatible load semantics (e.g., per-hand dumbbell presses tagged by Garmin as 0:null Bench Press)
  // and Garmin watch weight carry-over bugs from contaminating volume, PRs, e1RM, or progress charts.
  for (const a of analysis.activities) {
    if (a.status === 'already' || decisions.activities[a.id] !== 'import') continue;
    for (const it of a.items) {
      if (it.weight.kind !== 'number') continue;
      const w = it.weight.value;
      const target = decisions.rows[it.row] ?? decisions.names[it.name];
      if (target === 'ex_bench_press' && w < 40) {
        // Sets < 40 kg under generic Garmin 'Bench Press' are dumbbell presses (per_hand, 10-35 kg) or unconfirmed;
        // keep set and reps in history with sourceRaw intact, but leave load unconfirmed (null).
        decisions.rowLoad[it.row] = 'unknown';
      } else if (target === 'ex_weighted_pull_up' && w > 45) {
        // Watch carry-over weights from Bench Press (55 kg, 90 kg); leave load unconfirmed (null).
        decisions.rowLoad[it.row] = 'unknown';
      } else if (target === 'ex_lateral_raise' && w > 22.5) {
        // Watch carry-over weights from Bench Press/Row (26-89 kg); leave load unconfirmed (null).
        decisions.rowLoad[it.row] = 'unknown';
      }
    }
  }

  return decisions;
}
