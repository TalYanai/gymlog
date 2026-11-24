// Synthetic test helpers and fixtures for GymLog V2 tests.
// Never reads or touches any personal workout data, CSV files, or personal JSON files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '../src/app/bootstrap.js';
import { createActions } from '../src/ui/actions.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_DOC = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed-defaults.json'), 'utf8'));

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
  return {
    backend,
    dump: () => Object.fromEntries(map),
  };
}

export function makeClock(startIso = '2026-05-01T10:00:00.000Z') {
  let ms = Date.parse(startIso);
  return {
    now: () => {
      const iso = new Date(ms).toISOString();
      ms += 1000;
      return iso;
    },
    peek: () => new Date(ms).toISOString(),
    advanceSec: (s) => { ms += s * 1000; },
  };
}

export function makeIdGen(tag = '') {
  let n = 0;
  return (prefix) => `${prefix}_${tag}${String(++n).padStart(8, '0')}`;
}

export async function createTestApp({ storage = createMemoryStorage(), startFresh = true, startIso, idTag = '' } = {}) {
  const clock = makeClock(startIso);
  const newId = makeIdGen(idTag);
  const { app, store, syncPort } = await bootstrap({
    backend: storage.backend,
    now: clock.now,
    newId,
    seedDoc: structuredClone(SEED_DOC),
    appVersion: '2.0.0',
  });
  if (startFresh && app.getState().gate === 'absent') {
    const r = await app.startFresh();
    if (!r.ok) throw new Error(`startFresh failed: ${r.code}`);
  }
  const actions = createActions(app);
  return { app, store, syncPort, actions, storage, clock, newId };
}

export function makeSyntheticGarminCsv(rows) {
  const header = [
    'שם_אימון_תאריך',
    'שם_האימון',
    'תאריך',
    'מזהה_פעילות_Garmin',
    'Set',
    'Exercise Name',
    'Time',
    'Rest',
    'Reps',
    'Weight',
    'Volume',
    'Round',
    'Laps',
    'Distance km',
    'Moving Time',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const line = header.map((col) => {
      const v = String(r[col] ?? '');
      return v.includes(',') || v.includes('"') ? `"${v.replaceAll('"', '""')}"` : v;
    });
    lines.push(line.join(','));
  }
  const text = lines.join('\r\n');
  return { text, bytes: new TextEncoder().encode(text) };
}
