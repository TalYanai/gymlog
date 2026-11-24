// Visual check on the real merged history (not part of node --test): node test/e2e/shots.mjs <outDir> [storeJson]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import fs from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const out = process.argv[2] ?? '/tmp/shots';
const storePath = process.argv[3] ?? '/home/claude/mig/merged/merged-store.json';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = normalize(decodeURIComponent(u.pathname)).replace(/^\/+/, '') || 'index.html';
  try {
    let b = await readFile(join(ROOT, p));
    if (p === 'src/ui/config.js') b = Buffer.from(b.toString('utf8').replace("export const PRODUCTION_HOST = 'gymlog-tal.talyanai012.workers.dev';", "export const PRODUCTION_HOST = '127.0.0.1';"));
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL0 = `http://127.0.0.1:${server.address().port}/`;
const storeObj = JSON.parse(fs.readFileSync(storePath, 'utf8'));
for (const e of storeObj.meta.importLog) e.reportSeenAt ??= '2026-11-10T00:00:00.000Z'; // only so the first-run report screen does not cover the screens under check
const store = JSON.stringify(storeObj);
const browser = await chromium.launch();
const { defaultBrowserType, userAgent, ...phone } = devices['iPhone 13']; void defaultBrowserType; void userAgent;
fs.mkdirSync(out, { recursive: true });
const routes = (process.argv[4] ?? 'progress,workout,history,manage,manage/settings').split(',');
for (const [name, opts] of [['phone', { ...phone, locale: 'he-IL' }], ['desk', { viewport: { width: 1280, height: 800 }, locale: 'he-IL' }]]) {
  const ctx = await browser.newContext(opts); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript((s) => { if (!localStorage.getItem('gymlog.v2')) localStorage.setItem('gymlog.v2', s); }, store);
  for (const r of routes) {
    await page.goto(`${URL0}#/${r}`); await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${name}-${r.replaceAll('/', '_')}.png`, fullPage: true });
  }
  await page.goto(`${URL0}#/progress`); await page.waitForTimeout(500);
  for (const t of ['records', 'compare', 'goals', 'charts']) {
    await page.locator(`[data-subtab="${t}"]`).click(); await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/${name}-progress-tab-${t}.png`, fullPage: true });
  }
  console.log(name, 'screen:', await page.evaluate(() => document.body.dataset.screen), 'errors:', errs, 'hscroll:', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await ctx.close();
}
await browser.close(); server.close();
