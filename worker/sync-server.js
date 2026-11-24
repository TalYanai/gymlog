// GymLog sync server logic (runs in a Cloudflare Worker with a D1 binding `DB`; pure over `env`).
//
// Protocol (matches src/sync/local.js):
//   GET  /api/sync/status                      → { epoch, maxSeq, entities }
//   GET  /api/sync/pull?since=N&limit=L        → { epoch, changes:[{seq,type,id,version,deleted,payload,opId}], more, maxSeq }
//   POST /api/sync/push { deviceId, epoch, ops:[{opId,type,id,base,deleted,payload}] }
//                                              → { epoch, results:[{opId,status:'applied'|'duplicate'|'conflict',version,current}] }
//   GET  /api/sync/export                      → { epoch, maxSeq, entities:[{type,id,version,deleted,payload}] } (server-side backup)
// Every call needs `Authorization: Bearer <SYNC_TOKEN>` (a Worker secret, never in the repository).
// A push whose epoch differs from the server's is refused (EPOCH_MISMATCH): the server database was
// replaced or the device belongs to another history, and the client must reconcile first.
import { ENTITY_TYPES } from '../src/sync/local.js';

export const LIMITS = Object.freeze({ bodyBytes: 4_000_000, payloadBytes: 1_500_000, ops: 100, pull: 200 });
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const err = (status, code, extra = {}) => reply(status, { error: code, ...extra });

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
async function tokenOk(request, secret) {
  const h = request.headers.get('authorization') ?? '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [a, b] = await Promise.all([digest(given), digest(String(secret).trim())]); // trim: a piped secret may carry a trailing newline
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const parseRow = (r) => ({ seq: r.seq, type: r.type, id: r.id, version: r.version, deleted: r.deleted === 1, payload: r.payload === null ? null : JSON.parse(r.payload), opId: r.op_id });
const currentOf = (r) => (r ? { version: r.version, deleted: r.deleted === 1, payload: r.payload === null ? null : JSON.parse(r.payload) } : null);

let epochCache = null; // per isolate; the value never changes for a given database
async function getEpoch(db) {
  if (epochCache) return epochCache;
  await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', ?)").bind(`ep_${crypto.randomUUID()}`).run();
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'epoch'").first();
  epochCache = row.value;
  return epochCache;
}
export const _resetEpochCacheForTests = () => { epochCache = null; };

const validOp = (op) => op && typeof op === 'object' && typeof op.opId === 'string' && op.opId.length > 0 && op.opId.length <= 200
  && ENTITY_TYPES.includes(op.type) && typeof op.id === 'string' && op.id.length > 0 && op.id.length <= 200
  && Number.isSafeInteger(op.base) && op.base >= 0 && typeof op.deleted === 'boolean'
  && (op.deleted ? op.payload === null : op.payload !== null && typeof op.payload === 'object' && !Array.isArray(op.payload));

async function applyOp(db, op, deviceId, at) {
  const dup = await db.prepare('SELECT version FROM changes WHERE op_id = ?').bind(op.opId).first();
  if (dup) return { opId: op.opId, status: 'duplicate', version: dup.version };
  const cur = await db.prepare('SELECT version, deleted, payload FROM changes WHERE type = ? AND id = ? ORDER BY version DESC LIMIT 1').bind(op.type, op.id).first();
  const curVersion = cur?.version ?? 0;
  if (curVersion !== op.base) return { opId: op.opId, status: 'conflict', version: null, current: currentOf(cur) };
  const text = op.deleted ? null : JSON.stringify(op.payload);
  if (text !== null && text.length > LIMITS.payloadBytes) return { opId: op.opId, status: 'rejected', reason: 'PAYLOAD_TOO_LARGE' };
  try {
    await db.prepare('INSERT INTO changes (type, id, version, deleted, payload, op_id, device_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(op.type, op.id, op.base + 1, op.deleted ? 1 : 0, text, op.opId, deviceId, at).run();
  } catch {
    // A concurrent writer took this version (or this very op just arrived twice): decide again from the data.
    const again = await db.prepare('SELECT version FROM changes WHERE op_id = ?').bind(op.opId).first();
    if (again) return { opId: op.opId, status: 'duplicate', version: again.version };
    const now = await db.prepare('SELECT version, deleted, payload FROM changes WHERE type = ? AND id = ? ORDER BY version DESC LIMIT 1').bind(op.type, op.id).first();
    return { opId: op.opId, status: 'conflict', version: null, current: currentOf(now) };
  }
  return { opId: op.opId, status: 'applied', version: op.base + 1 };
}

export async function handleSync(request, env, { now = () => new Date().toISOString() } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/sync/')) return err(404, 'NOT_FOUND');
  if (!env.SYNC_TOKEN) return err(503, 'NOT_CONFIGURED');
  if (!(await tokenOk(request, env.SYNC_TOKEN))) return err(401, 'UNAUTHORIZED');
  const db = env.DB;
  if (!db) return err(503, 'NOT_CONFIGURED');
  const epoch = await getEpoch(db);
  const route = url.pathname.slice('/api/sync/'.length);

  if (request.method === 'GET' && route === 'status') {
    const r = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq, COUNT(DISTINCT type || char(0) || id) AS entities FROM changes').first();
    return reply(200, { epoch, maxSeq: r.maxSeq, entities: r.entities });
  }
  if (request.method === 'GET' && route === 'pull') {
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? LIMITS.pull), LIMITS.pull);
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1) return err(400, 'BAD_REQUEST');
    const rows = (await db.prepare('SELECT seq, type, id, version, deleted, payload, op_id FROM changes WHERE seq > ? ORDER BY seq LIMIT ?').bind(since, limit + 1).all()).results;
    const max = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM changes').first();
    return reply(200, { epoch, changes: rows.slice(0, limit).map(parseRow), more: rows.length > limit, maxSeq: max.m });
  }
  if (request.method === 'GET' && route === 'export') {
    // maxSeq is read BEFORE the entities: a change landing in between is then re-delivered by the next pull
    // (harmless: its version is already known) instead of being skipped.
    const max = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM changes').first();
    const rows = (await db.prepare('SELECT c.seq, c.type, c.id, c.version, c.deleted, c.payload, c.op_id FROM changes c JOIN (SELECT type, id, MAX(version) AS v FROM changes GROUP BY type, id) m ON c.type = m.type AND c.id = m.id AND c.version = m.v ORDER BY c.seq').all()).results;
    return reply(200, { epoch, maxSeq: max.m, entities: rows.map((r) => { const { opId, seq, ...rest } = parseRow(r); return rest; }) });
  }
  if (request.method === 'POST' && route === 'push') {
    const text = await request.text();
    if (text.length > LIMITS.bodyBytes) return err(413, 'TOO_LARGE');
    let body;
    try { body = JSON.parse(text); } catch { return err(400, 'BAD_REQUEST'); }
    if (!body || typeof body.deviceId !== 'string' || !body.deviceId || body.deviceId.length > 200 || !Array.isArray(body.ops) || body.ops.length > LIMITS.ops) return err(400, 'BAD_REQUEST');
    if (body.epoch !== epoch) return err(409, 'EPOCH_MISMATCH', { epoch });
    if (!body.ops.every(validOp)) return err(400, 'BAD_REQUEST');
    const at = now();
    const results = [];
    for (const op of body.ops) results.push(await applyOp(db, op, body.deviceId, at));
    return reply(200, { epoch, results });
  }
  return err(404, 'NOT_FOUND');
}
