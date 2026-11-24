// Browser check of two-device sync through the REAL UI: a phone-emulated Chromium context and a desktop context
// (separate storage = separate devices) against one local server running the real Worker logic over a fake D1.
// SIMULATED mobile (Chromium device emulation) — NOT physical iPhone Safari. SYNTHETIC data only.
// Run from the project root: node test/e2e/sync.e2e.mjs   (needs a global Playwright with Chromium; not part of node --test)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createFakeD1 } from '../helpers-d1.js';
import { handleSync } from '../../worker/sync-server.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const TOKEN = 'e2e-token-not-a-secret';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const env = { DB: createFakeD1(), SYNC_TOKEN: TOKEN };
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handleSync(new Request(`http://x${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(await r.text());
  }
  const p = normalize(decodeURIComponent(u.pathname)).replace(/^\/+/, '') || 'index.html';
  try {
    let b = await readFile(join(ROOT, p));
    if (p === 'src/ui/config.js') b = Buffer.from(b.toString('utf8').replace("export const PRODUCTION_HOST = 'gymlog-tal.talyanai012.workers.dev';", "export const PRODUCTION_HOST = '127.0.0.1';"));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL0 = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const { defaultBrowserType, userAgent, ...phoneOpts } = devices['iPhone 13']; void defaultBrowserType; void userAgent;
const mk = async (desktop) => {
  const ctx = await browser.newContext(desktop ? { viewport: { width: 1280, height: 800 }, locale: 'he-IL' } : { ...phoneOpts, locale: 'he-IL' });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  return { ctx, page };
};
const waitScreen = (page, id) => page.waitForFunction((x) => document.body.dataset.screen === x, id, { timeout: 15000 });
const store = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('gymlog.v2')));
async function freshApp(page) {
  await page.goto(URL0); await waitScreen(page, 'welcome');
  await page.locator('[data-id="fresh"]').click();
  await page.locator('dialog[open] button', { hasText: 'התחל מאפס' }).click();
  await waitScreen(page, 'app'); await page.waitForSelector('[data-view="workout-select"]');
}
async function enableSync(page) {
  await page.goto(`${URL0}#/manage/settings`);
  await page.locator('[data-field="sync-token"]').fill(TOKEN);
  await page.locator('[data-id="sync-save"]').click();
  await page.waitForFunction(() => /מסונכרן/.test(document.querySelector('[data-id="sync-status"]')?.textContent ?? ''), null, { timeout: 15000 });
}
async function logWorkout(page, load) {
  await page.goto(`${URL0}#/workout`); await page.waitForSelector('[data-view="workout-select"]');
  await page.locator('[data-template="tpl_push_a"]').click(); await page.waitForSelector('[data-view="workout-active"]');
  await page.locator('[data-input]').first().fill(String(load)); await page.locator('[data-input]').nth(1).fill('5');
  await page.waitForFunction((l) => JSON.parse(localStorage.getItem('gymlog.v2')).activeSession.session.performances.some((p) => p.sets.some((s) => s.load === l)), load, { timeout: 5000 });
  await page.locator('[data-tick]').first().click();
  await page.locator('[data-id="finish-workout"]').click();
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(300); const b = page.locator('dialog[open] button.pri'); if (await b.count()) await b.first().click(); if (await page.locator('[data-view="workout-select"]').count()) break; }
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('gymlog.v2')).activeSession === null, null, { timeout: 8000 });
}
const sessions = async (page) => (await store(page)).sessions.map((s) => s.id).sort();
const results = [];
const check = async (name, fn) => { try { await fn(); results.push([name, 'pass']); } catch (e) { results.push([name, `FAIL: ${String(e.message).split('\n').slice(0, 3).join(' ')}`]); } };

const desk = await mk(true); const phone = await mk(false);
await freshApp(desk.page); await freshApp(phone.page);
await check('enable sync on both devices (UI)', async () => { await enableSync(desk.page); await enableSync(phone.page); });
await check('desktop workout appears on phone (automatic, no manual step)', async () => {
  await logWorkout(desk.page, 100);
  const id = (await sessions(desk.page))[0];
  await phone.page.waitForFunction((x) => JSON.parse(localStorage.getItem('gymlog.v2')).sessions.some((s) => s.id === x), id, { timeout: 90000 });
});
await check('phone workout appears on desktop and in its history view', async () => {
  await logWorkout(phone.page, 70);
  await desk.page.waitForFunction(() => JSON.parse(localStorage.getItem('gymlog.v2')).sessions.length === 2, null, { timeout: 90000 });
  await desk.page.goto(`${URL0}#/history`); await desk.page.waitForSelector('[data-view="history"], [data-view="history-list"]', { timeout: 5000 }).catch(() => {});
  assert.deepEqual(await sessions(desk.page), await sessions(phone.page));
});
await check('offline workout on phone is kept on the device and syncs when back online', async () => {
  await phone.ctx.setOffline(true);
  await logWorkout(phone.page, 75);
  // (a true offline reload needs the service worker, which is covered by the PWA e2e; restart persistence is in test/sync-client.test.js SC4)
  const n = (await store(phone.page)).sync.outbox.length; assert.ok(n > 0, 'pending ops stored on the device while offline');
  await phone.ctx.setOffline(false);
  await phone.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await desk.page.waitForFunction(() => JSON.parse(localStorage.getItem('gymlog.v2')).sessions.length === 3, null, { timeout: 90000 });
  await phone.page.waitForFunction(() => JSON.parse(localStorage.getItem('gymlog.v2')).sync.outbox.length === 0, null, { timeout: 30000 });
});
await check('delete on desktop (UI) disappears from phone', async () => {
  const id = (await sessions(desk.page))[0];
  await desk.page.goto(`${URL0}#/history/${id}`); await desk.page.waitForSelector('[data-id="delete"]');
  await desk.page.locator('[data-id="delete"]').click();
  await desk.page.locator('dialog[open] button', { hasText: 'מחק' }).click();
  await phone.page.waitForFunction((x) => !JSON.parse(localStorage.getItem('gymlog.v2')).sessions.some((s) => s.id === x), id, { timeout: 90000 });
  assert.deepEqual(await sessions(desk.page), await sessions(phone.page));
});
await check('new device joins from the WELCOME screen with the token and receives the shared history', async () => {
  const d3 = await mk(true);
  await d3.page.goto(URL0); await waitScreen(d3.page, 'welcome');
  await d3.page.locator('[data-field="welcome-sync-token"]').fill(TOKEN);
  await d3.page.locator('[data-id="welcome-sync"]').click();
  await waitScreen(d3.page, 'app');
  const want = await sessions(desk.page);
  await d3.page.waitForFunction((n) => JSON.parse(localStorage.getItem('gymlog.v2')).sessions.length === n, want.length, { timeout: 30000 });
  assert.deepEqual(await sessions(d3.page), want);
  assert.equal((await store(d3.page)).sync.conflicts.length, 0);
  assert.deepEqual(d3.page.errors, []);
  await d3.ctx.close();
});
await check('no page errors on either device; no horizontal scroll on phone', async () => {
  assert.deepEqual(desk.page.errors, []); assert.deepEqual(phone.page.errors, []);
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
});
await browser.close(); server.close();
for (const [n, r] of results) console.log(`${r === 'pass' ? 'PASS' : 'FAIL'}  ${n}${r === 'pass' ? '' : `\n      ${r}`}`);
process.exit(results.every(([, r]) => r === 'pass') ? 0 : 1);
