// A D1-shaped adapter over node:sqlite (tests only): prepare().bind().first()/all()/run().
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createFakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8'));
  const wrap = (sql) => {
    let args = [];
    const st = {
      bind: (...a) => { args = a; return st; },
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    };
    return st;
  };
  return { prepare: wrap, _raw: db };
}
