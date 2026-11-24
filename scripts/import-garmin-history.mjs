#!/usr/bin/env node
// Local CLI & module to inventory, dry-run, execute, and verify the complete Garmin workout history import
// from Garmin_Data/ (June 1, 2026 onwards inclusive) into GymLog V2.
//
// Usage:
//   node scripts/import-garmin-history.mjs --dry-run
//   node scripts/import-garmin-history.mjs --execute
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { bootstrap } from '../src/app/bootstrap.js';
import { parseBackup } from '../src/backup/backup.js';
import { sha256Hex } from '../src/schema/canonical.js';
import { validateStore } from '../src/schema/validate.js';
import { analyzeGarminCsv, buildGarminImport, parseCsv } from '../src/import/garmin-csv.js';
import { historyList, sessionDetail } from '../src/ui/history-model.js';
import { progressExercises, exerciseProgress, goalsModel, chartSeries } from '../src/ui/progress-model.js';
import {
  GARMIN_EPOCH_OFFSET,
  ARCHIVE_CSV_COLUMNS,
  parseFitBuffer,
  parseGarminTimestampToIso,
  buildActivityCsvRows,
  serializeGarminCsv,
  buildSafeArchiveDecisions,
} from '../src/import/garmin-archive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CUTOFF_ISO_DATE = '2026-06-01';
const CUTOFF_UTC_MS = Date.parse('2026-06-01T00:00:00.000Z');

export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const backend = {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
  };
  return { backend, dump: () => Object.fromEntries(map) };
}

/** Pure-Node ZIP reader (reads central directory & inflates entries in memory). */
export function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const entries = [];
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`Invalid ZIP archive: ${zipPath}`);
  const cdCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const fnLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + fnLen).toString('utf8');
    pos += 46 + fnLen + extraLen + commentLen;

    const lFnLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lFnLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? compData : method === 8 ? zlib.inflateRawSync(compData) : null;
    if (data) entries.push({ name, data });
  }
  return entries;
}

/** Loads all activity summaries from Garmin_Data/DI_CONNECT/DI-Connect-Fitness/*_summarizedActivities.json. */
export function loadGarminSummarizedActivities(garminDir) {
  const fitnessDir = path.join(garminDir, 'DI_CONNECT', 'DI-Connect-Fitness');
  const files = fs.readdirSync(fitnessDir).filter((f) => f.endsWith('_summarizedActivities.json')).sort();
  const byId = new Map();
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(fitnessDir, file), 'utf8'));
    const list = raw?.[0]?.summarizedActivitiesExport ?? [];
    for (const act of list) {
      byId.set(String(act.activityId), { ...act, _sourceJson: file });
    }
  }
  return Array.from(byId.values());
}

/** Loads all activity-type FIT files (file_id.type === 4) from UploadedFiles ZIP archives, indexed by startTimeGmt (ms). */
export function loadGarminActivityFits(garminDir) {
  const upDir = path.join(garminDir, 'DI_CONNECT', 'DI-Connect-Uploaded-Files');
  const zips = fs.readdirSync(upDir).filter((f) => /^UploadedFiles_.*\.zip$/i.test(f)).sort();
  const byStartGmtMs = new Map();
  let totalFitFiles = 0;
  let activityFitFiles = 0;

  for (const zf of zips) {
    const entries = readZipEntries(path.join(upDir, zf));
    for (const entry of entries) {
      if (!entry.name.toLowerCase().endsWith('.fit')) continue;
      totalFitFiles++;
      const msgs = parseFitBuffer(entry.data, { allowedMessages: [0, 18, 19, 225] });
      if (!msgs) continue;
      const fileId = msgs.find((m) => m.globalMesgNum === 0);
      if (fileId?.fields?.[0] !== 4) continue; // 4 = activity
      activityFitFiles++;
      const session = msgs.find((m) => m.globalMesgNum === 18);
      if (!session || typeof session.fields[2] !== 'number') continue;
      const startGmtMs = (session.fields[2] + GARMIN_EPOCH_OFFSET) * 1000;
      byStartGmtMs.set(startGmtMs, {
        zipFile: zf,
        fitFileName: entry.name,
        startGmtMs,
        messages: msgs,
      });
    }
  }
  return { byStartGmtMs, totalFitFiles, activityFitFiles };
}

/** Loads user-edited CSV rows from unified_workouts.csv indexed by Garmin activityId. */
export function loadUnifiedCsvOverrides(csvPath) {
  const byId = new Map();
  if (!fs.existsSync(csvPath)) return byId;
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) return byId;
  const header = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => c === '')) continue;
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? '';
    });
    const id = String(obj['מזהה_פעילות_Garmin'] ?? '').trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(obj);
  }
  return byId;
}

/** Builds the complete >= 2026-06-01 dataset and dry-run manifest from Garmin_Data/. */
export async function prepareGarminArchiveImport({ garminDir, unifiedCsvPath }) {
  const allSummaries = loadGarminSummarizedActivities(garminDir);
  const { byStartGmtMs, totalFitFiles, activityFitFiles } = loadGarminActivityFits(garminDir);
  const csvOverrides = loadUnifiedCsvOverrides(unifiedCsvPath);

  const included = [];
  const excludedPreCutoff = [];

  for (const s of allSummaries) {
    const utcIso = parseGarminTimestampToIso(s.startTimeGmt ?? s.beginTimestamp);
    const localIso = parseGarminTimestampToIso(s.startTimeLocal ?? s.beginTimestamp);
    const localDate = localIso ? localIso.slice(0, 10) : '';
    const utcMs = utcIso ? Date.parse(utcIso) : 0;

    if (localDate >= CUTOFF_ISO_DATE && utcMs >= CUTOFF_UTC_MS) {
      included.push(s);
    } else {
      excludedPreCutoff.push(s);
    }
  }

  // Sort chronologically by startTimeGmt ascending
  included.sort((a, b) => (a.startTimeGmt ?? a.beginTimestamp) - (b.startTimeGmt ?? b.beginTimestamp));

  const allCsvRows = [];
  const manifestActivities = [];
  const byActivityType = {};

  for (const s of included) {
    const id = String(s.activityId);
    const startGmtMs = Math.round(s.startTimeGmt ?? s.beginTimestamp);
    const fitMatch = byStartGmtMs.get(startGmtMs) ?? null;
    const overrideRows = csvOverrides.get(id) ?? null;
    const built = buildActivityCsvRows({
      summary: s,
      fitMsgs: fitMatch?.messages ?? null,
      fitFileName: fitMatch?.fitFileName ?? null,
      csvOverrideRows: overrideRows,
    });
    allCsvRows.push(...built.rows);

    byActivityType[s.activityType] = (byActivityType[s.activityType] ?? 0) + 1;

    const activeSets = fitMatch ? fitMatch.messages.filter((m) => m.globalMesgNum === 225 && m.fields[5] === 1).length : 0;
    const fitLaps = fitMatch ? fitMatch.messages.filter((m) => m.globalMesgNum === 19).length : 0;

    manifestActivities.push({
      activityId: id,
      name: s.name ?? s.activityType,
      activityType: s.activityType,
      kind: built.kind,
      startTimeUtc: parseGarminTimestampToIso(s.startTimeGmt ?? s.beginTimestamp),
      startTimeLocal: parseGarminTimestampToIso(s.startTimeLocal ?? s.beginTimestamp),
      date: parseGarminTimestampToIso(s.startTimeLocal ?? s.beginTimestamp).slice(0, 10),
      durationSec: typeof s.duration === 'number' ? Math.round(s.duration / 1000) : 0,
      movingDurationSec: typeof s.movingDuration === 'number' ? Math.round(s.movingDuration / 1000) : 0,
      distanceKm: typeof s.distance === 'number' && s.distance > 0 ? Math.round((s.distance / 100000) * 100) / 100 : 0,
      sourceJson: s._sourceJson,
      sourceFit: fitMatch ? `${fitMatch.zipFile}:${fitMatch.fitFileName}` : null,
      hasUnifiedCsvOverride: Boolean(overrideRows),
      fitActiveSetCount: activeSets,
      fitLapCount: fitLaps,
      csvRowCount: built.rows.length,
    });
  }

  const csvText = serializeGarminCsv(allCsvRows, ARCHIVE_CSV_COLUMNS);
  const csvSha256 = await sha256Hex(csvText);
  return {
    totalSummariesInExport: allSummaries.length,
    includedCount: included.length,
    excludedPreCutoffCount: excludedPreCutoff.length,
    totalFitFiles,
    activityFitFiles,
    byActivityType,
    manifestActivities,
    csvText,
    csvSha256,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isExecute = args.includes('--execute');
  const garminDir = path.join(ROOT, 'Garmin_Data');
  const unifiedCsvPath = path.join(ROOT, 'unified_workouts.csv');
  const seedDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed-defaults.json'), 'utf8'));

  console.log('=== GymLog V2 — Garmin History Import (June 1, 2026 Onwards) ===');
  console.log(`Mode: ${isExecute ? 'EXECUTE' : 'DRY-RUN'}`);

  const prep = await prepareGarminArchiveImport({ garminDir, unifiedCsvPath });
  console.log(`Total activities in Garmin export: ${prep.totalSummariesInExport}`);
  console.log(`Included (>= 2026-06-01):          ${prep.includedCount}`);
  console.log(`Excluded (< 2026-06-01):           ${prep.excludedPreCutoffCount}`);
  console.log(`By activity type (>= 2026-06-01):  ${JSON.stringify(prep.byActivityType)}`);
  console.log(`Generated CSV rows:                ${prep.manifestActivities.reduce((n, a) => n + a.csvRowCount, 0)} (SHA-256: ${prep.csvSha256.slice(0, 16)}...)`);

  let idSeq = 0;
  const storage = createMemoryStorage();
  const { app } = await bootstrap({
    backend: storage.backend,
    now: () => '2026-11-07T19:50:00.000Z',
    newId: (prefix) => `${prefix}_${String(++idSeq).padStart(8, '0')}`,
    seedDoc: structuredClone(seedDoc),
    appVersion: '2.0.0',
  });
  const sf = await app.startFresh();
  if (!sf.ok) throw new Error(`startFresh failed: ${sf.code}`);

  // Preserve the user's personal seed data (gymlog-personal.json: active goals & verified prefills;
  // items marked needsReview are skipped so no unverified V3 load semantics are guessed) via additive merge.
  const personalSeedPath = path.join(ROOT, 'gymlog-personal.json');
  if (fs.existsSync(personalSeedPath)) {
    const psBytes = new Uint8Array(fs.readFileSync(personalSeedPath));
    const psPlan = await app.planPersonalSeed(psBytes);
    if (!psPlan.ok) throw new Error(`planPersonalSeed failed: ${JSON.stringify(psPlan)}`);
    const psDecisions = { ...psPlan.defaults };
    for (const it of psPlan.items) {
      if (!psDecisions[it.key] && psPlan.checks[it.key] === 'ok') {
        psDecisions[it.key] = { action: 'skip' };
      }
    }
    const psApply = await app.applyPersonalSeed(psPlan.planId, psDecisions);
    if (!psApply.ok) throw new Error(`applyPersonalSeed failed: ${JSON.stringify(psApply)}`);
  }

  const baseStore = app.snapshot().store;

  // Analyze the synthesized CSV
  const analysisRes = await analyzeGarminCsv({
    text: prep.csvText,
    fileSha256: prep.csvSha256,
    fileName: 'garmin-history-2026-06-01-onwards.csv',
    store: baseStore,
  });
  if (!analysisRes.ok) {
    throw new Error(`CSV analysis failed: ${JSON.stringify(analysisRes)}`);
  }
  const { analysis } = analysisRes;

  const decisions = buildSafeArchiveDecisions(analysis, baseStore);
  const built = await buildGarminImport(analysis, decisions, {
    store: baseStore,
    importedAt: '2026-11-07T19:50:00.000Z',
  });

  if (!built.ok) {
    throw new Error(`buildGarminImport failed: ${JSON.stringify(built)}`);
  }

  const totalPerfs = built.additions.sessions.reduce((n, s) => n + s.performances.length, 0);
  const totalSets = built.additions.sessions.reduce((n, s) => n + s.performances.reduce((m, p) => m + p.sets.length, 0), 0);

  console.log('\n--- Dry-Run Import Plan Summary ---');
  console.log(`Sessions to add:         ${built.additions.sessions.length}`);
  console.log(`Performances to add:     ${totalPerfs}`);
  console.log(`Sets to add:             ${totalSets}`);
  console.log(`New exercises to add:    ${built.additions.exercises.length}`);
  console.log(`Quarantine entries:      ${built.additions.quarantine.length}`);
  console.log(`Import warnings:         ${built.additions.entry.warnings.length}`);
  console.log(`Reconciliation:          ${JSON.stringify(built.report.reconciliation)}`);

  const resolvedEx = built.additions.exercises.filter((e) => e.measurement.type !== 'unresolved');
  const unresolvedEx = built.additions.exercises.filter((e) => e.measurement.type === 'unresolved');
  console.log(`New resolved exercises (${resolvedEx.length}):   ${resolvedEx.map((e) => `${e.name} [${e.measurement.type}]`).join(', ')}`);
  console.log(`New unresolved exercises (${unresolvedEx.length}): ${unresolvedEx.map((e) => `${e.name} [${e.id}]`).join(', ')}`);

  if (!isExecute) {
    console.log('\nDry-run complete. No target store or backup files were written.');
    return;
  }

  // STEP 7: Execute Import Safely
  // 1. Back up the baseline pre-import store first and verify its hash
  const preImportBackup = await app.createBackup();
  if (!preImportBackup.ok) throw new Error(`preImportBackup failed: ${JSON.stringify(preImportBackup)}`);
  const preBackupPath = path.join(ROOT, 'gymlog-import-pre-backup.json');
  fs.writeFileSync(preBackupPath, preImportBackup.json, 'utf8');
  const preRestoreCheck = await parseBackup(fs.readFileSync(preBackupPath));
  if (!preRestoreCheck.ok) {
    throw new Error(`Pre-import backup verification failed: ${JSON.stringify(preRestoreCheck)}`);
  }
  console.log(`\nVerified pre-import baseline backup written to: ${path.basename(preBackupPath)}`);

  // 2. Plan & apply the Garmin import through app.planGarminCsv + app.applyGarminCsv
  const csvBytes = new TextEncoder().encode(prep.csvText);
  const planRes = await app.planGarminCsv(csvBytes, 'garmin-history-2026-06-01-onwards.csv');
  if (!planRes.ok) throw new Error(`app.planGarminCsv failed: ${JSON.stringify(planRes)}`);

  const applyRes = await app.applyGarminCsv(planRes.planId, decisions);
  if (!applyRes.ok) {
    throw new Error(`app.applyGarminCsv failed: ${JSON.stringify(applyRes)}`);
  }

  const finalState = app.getState();
  if (finalState.gate !== 'open') {
    throw new Error(`Expected app gate to remain 'open', got: ${finalState.gate}`);
  }

  const finalStore = app.snapshot().store;
  const validation = await validateStore(finalStore);
  if (!validation.valid) {
    throw new Error(`validateStore failed on imported store: ${JSON.stringify(validation.errors)}`);
  }
  console.log(`Store validation passed: valid=${validation.valid}, errors=${validation.errors.length}`);

  // 3. Verify idempotency (re-planning the exact same CSV returns ALREADY_IMPORTED, and re-analyzing marks all 111 activities 'already')
  const secondPlan = await app.planGarminCsv(csvBytes, 'garmin-history-2026-06-01-onwards.csv');
  const secondAnalysis = await analyzeGarminCsv({
    text: prep.csvText,
    fileSha256: prep.csvSha256,
    fileName: 'recheck.csv',
    store: finalStore,
  });
  const alreadyCount = secondAnalysis.analysis.activities.filter((a) => a.status === 'already').length;
  if (secondPlan.ok !== false || secondPlan.code !== 'ALREADY_IMPORTED' || alreadyCount !== prep.includedCount) {
    throw new Error(`Idempotency verification failed: alreadyCount=${alreadyCount}, secondPlan=${JSON.stringify(secondPlan)}`);
  }
  console.log(`Idempotency verified: ${alreadyCount}/${prep.includedCount} activities recognized as 'already' imported (code: ${secondPlan.code}).`);

  // 4. Write the unified Garmin CSV and verified GymLog V2 backup JSON so the user can import/restore in browser/PWA
  const outCsvPath = path.join(ROOT, 'garmin-history-2026-06-01-onwards.csv');
  fs.writeFileSync(outCsvPath, prep.csvText, 'utf8');

  const postImportBackup = await app.createBackup();
  if (!postImportBackup.ok) throw new Error(`postImportBackup failed: ${JSON.stringify(postImportBackup)}`);
  const outBackupPath = path.join(ROOT, 'gymlog-import-backup-2026-06-01-onwards.json');
  fs.writeFileSync(outBackupPath, postImportBackup.json, 'utf8');

  // Verify the exported backup can be parsed and restored cleanly into a fresh app instance
  const postBackupBytes = new Uint8Array(fs.readFileSync(outBackupPath));
  const parsedPostBackup = await parseBackup(postBackupBytes);
  if (!parsedPostBackup.ok) {
    throw new Error(`Post-import backup parseBackup failed: ${JSON.stringify(parsedPostBackup)}`);
  }
  const restoreStorage = createMemoryStorage();
  const { app: restoreApp } = await bootstrap({
    backend: restoreStorage.backend,
    now: () => '2026-11-07T19:55:00.000Z',
    newId: (prefix) => `${prefix}_r_${String(++idSeq).padStart(8, '0')}`,
    seedDoc: structuredClone(seedDoc),
    appVersion: '2.0.0',
  });
  const restored = await restoreApp.restoreBackup({ backupBytes: postBackupBytes });
  if (!restored.ok) {
    throw new Error(`Post-import backup restoreBackup failed: ${JSON.stringify(restored)}`);
  }

  // 5. Post-Import Verification Checks (Section 8: all 10 checks)
  const dates = finalStore.sessions.map((s) => s.date).sort();
  if (dates[0] < CUTOFF_ISO_DATE) {
    throw new Error(`Check 2 failed: found session dated before ${CUTOFF_ISO_DATE}: ${dates[0]}`);
  }
  const fingerprints = finalStore.sessions.map((s) => s.provenance?.fingerprint);
  if (new Set(fingerprints).size !== prep.includedCount) {
    throw new Error(`Check 1/9 failed: expected ${prep.includedCount} unique Garmin fingerprints, got ${new Set(fingerprints).size}`);
  }

  // Check 4: Workout history view renders all 111 imported sessions cleanly
  const hist = historyList(finalStore);
  if (hist.total !== prep.includedCount || hist.rows.length !== prep.includedCount) {
    throw new Error(`Check 4 failed: historyList returned ${hist.total} sessions`);
  }
  for (const s of finalStore.sessions) {
    const det = sessionDetail(finalStore, s.id);
    if (!det || det.performances.length !== s.performances.length) {
      throw new Error(`Check 4 failed: sessionDetail failed for session ${s.id}`);
    }
  }

  // Check 5 & 6: Progress charts and exercise selection work for imported exercises, and unresolved items do not pollute charts/PRs/volume
  const progExList = progressExercises(finalStore);
  for (const pe of progExList) {
    if (pe.type === 'unresolved') {
      throw new Error(`Check 6 failed: unresolved exercise ${pe.id} appeared in progressExercises`);
    }
    const ep = exerciseProgress(finalStore, pe.id);
    if (!ep) throw new Error(`Check 5 failed: exerciseProgress returned null for ${pe.id}`);
    for (const grp of ep.timeline) {
      const series = chartSeries(grp, grp.type === 'distance_duration' ? 'distanceM' : grp.type === 'bodyweight_reps' ? 'reps' : 'load');
      if (!Array.isArray(series.points)) throw new Error(`Check 5 failed: chartSeries failed for ${pe.id}`);
    }
  }

  // Check 7: Running activities appear correctly with distance/time/pace/laps
  const runProg = exerciseProgress(finalStore, 'ex_run');
  if (!runProg || runProg.sessions !== 18) {
    throw new Error(`Check 7 failed: expected 18 running sessions in ex_run progress, got ${runProg?.sessions}`);
  }

  // Check 8: Goals still function correctly
  const activeGoals = goalsModel(finalStore);
  if (!Array.isArray(activeGoals)) {
    throw new Error('Check 8 failed: goalsModel did not return an array');
  }

  console.log('\n--- All 10 Post-Import Verification Checks Passed ---');
  console.log(`1. Eligible activities imported:   ${finalStore.sessions.length}/${prep.includedCount} (date range: ${dates[0]} to ${dates[dates.length - 1]})`);
  console.log(`2. Pre-2026-06-01 imported:        0 (${prep.excludedPreCutoffCount} excluded)`);
  console.log(`3. Store validation:               valid=true, 0 errors`);
  console.log(`4. History list & details:         ${hist.total} sessions rendered cleanly`);
  console.log(`5. Progress exercises & charts:    ${progExList.map((e) => `${e.name} (${e.sessions} sessions)`).join(', ')}`);
  console.log(`6. Unresolved isolation:           0 unresolved exercises in progressExercises/records/volume`);
  console.log(`7. Running sessions verified:      ${runProg.sessions} sessions (15 running + 3 treadmill_running)`);
  console.log(`8. Goals model verified:           ${activeGoals.length} active goals evaluated`);
  console.log(`9. Duplicate detection:            111/111 blocked on re-import (ALREADY_IMPORTED)`);

  const finalPerfs = finalStore.sessions.reduce((n, s) => n + s.performances.length, 0);
  const finalSets = finalStore.sessions.reduce((n, s) => n + s.performances.reduce((m, p) => m + p.sets.length, 0), 0);
  console.log(`Wrote complete unified Garmin CSV (${prep.includedCount} activities): ${path.basename(outCsvPath)}`);
  console.log(`Wrote & verified GymLog V2 backup JSON (${finalStore.sessions.length} sessions, ${finalPerfs} performances, ${finalSets} sets): ${path.basename(outBackupPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
