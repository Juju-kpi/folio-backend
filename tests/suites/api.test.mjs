// API unit tests: api/*.js with an in-memory Supabase (PostgREST subset) and a
// fake Stripe client (real webhook signature verification).
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const require = createRequire(path.join(here, '..', 'package.json'));
process.env.REAL_STRIPE = require.resolve('stripe');

// Copy api/ + lib/ next to a fake "stripe" package
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-api-'));
fs.cpSync(path.join(repo, 'api'), path.join(tmp, 'api'), { recursive: true });
fs.cpSync(path.join(repo, 'lib'), path.join(tmp, 'lib'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.mkdirSync(path.join(tmp, 'node_modules', 'stripe'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'node_modules', 'stripe', 'package.json'), '{"name":"stripe","type":"module","main":"index.js"}');
fs.writeFileSync(path.join(tmp, 'node_modules', 'stripe', 'index.js'), `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Real = require(process.env.REAL_STRIPE);
const real = new Real('sk_test_dummy');
export const calls = globalThis.__stripeCalls = globalThis.__stripeCalls || { created: [], pis: {} };
export default class FakeStripe {
  constructor() {
    this.webhooks = real.webhooks;
    this.checkout = { sessions: { create: async (p) => { calls.created.push(p); return { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }; } } };
    this.paymentIntents = {
      retrieve: async (id) => ({ id, metadata: calls.pis[id] || {} }),
      update: async (id, { metadata }) => { calls.pis[id] = { ...(calls.pis[id] || {}), ...metadata }; return { id }; },
    };
  }
}`);
const load = rel => import(pathToFileURL(path.join(tmp, rel)).href);
process.env.SUPABASE_URL = 'http://sb.test'; process.env.SUPABASE_KEY = 'k';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; process.env.VERCEL_PROJECT_PRODUCTION_URL = 'folio-backend-ebon.vercel.app';
// ── Mini PostgREST en mémoire ──
const db = [];
const rpcCounts = new Map();
let patchDelay = 0;
function parseFilters(qs) {
  const p = new URLSearchParams(qs); const f = []; let select = null, limit = null;
  for (const [k, v] of p) { if (k === 'select') select = v; else if (k === 'limit') limit = +v; else f.push([k, v]); }
  return { f, select, limit };
}
function match(row, [col, expr]) {
  const [op, ...rest] = expr.split('.'); const val = rest.join('.');
  const cur = row[col];
  if (op === 'eq') return cur !== null && cur !== undefined && String(cur) === val;
  if (op === 'neq') return String(cur) !== val;
  if (op === 'is') return val === 'null' ? cur == null : String(cur) === val;
  throw new Error('op ' + op);
}
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url); const { f, select, limit } = parseFilters(u.search.slice(1));
  const method = opt.method || 'GET';
  const J = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj });
  if (method === 'GET') {
    let rows = db.filter(r => f.every(x => match(r, x)));
    if (limit) rows = rows.slice(0, limit);
    const cols = select.split(',');
    return J(rows.map(r => Object.fromEntries(cols.map(c => { if (!(c in r) && !['lifetime_free','edit_count'].includes(c)) throw new Error('col ' + c); return [c, r[c] ?? null]; }))));
  }
  if (u.pathname === '/rest/v1/rpc/folio_register_uid') {
    if (globalThis.__rpcMissing) return J({ code: 'PGRST202' }, 404);
    const b = JSON.parse(opt.body);
    rpcCounts.set(b.p_ip_hash, (rpcCounts.get(b.p_ip_hash) || 0) + 1);
    return J(rpcCounts.get(b.p_ip_hash) <= b.p_limit);
  }
  if (method === 'POST') { const b = JSON.parse(opt.body); if (db.some(r => r.uid === b.uid)) return J({}, 409); db.push({ lifetime_free: false, edit_count: null, ...b }); return J(null, 201); }
  if (method === 'PATCH') {
    const rows = db.filter(r => f.every(x => match(r, x)));
    if (patchDelay) await new Promise(r => setTimeout(r, patchDelay));
    const again = rows.filter(r => f.every(x => match(r, x)));
    again.forEach(r => Object.assign(r, JSON.parse(opt.body)));
    return J(again);
  }
};
function mkRes() { const r = { statusCode: 0, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } }; return r; }
const req = (method, { query = {}, body, headers = {}, ip = '1.1.1.1' } = {}) => ({ method, query, body, headers: { 'x-forwarded-for': ip, ...headers }, socket: {} });
const status = (await load('api/status.js')).default;
const consume = (await load('api/consume.js')).default;
const checkout = (await load('api/checkout.js')).default;
const webhook = (await load('api/webhook.js')).default;
const UID = 'u_lzxw4khs_3f9ab2c1', UID2 = 'u_lzxw4khs_zzzzzzzz';
const { FREE_SESSIONS, hashIp } = await load('lib/folio-api.js');
assert.equal(FREE_SESSIONS, 2);

// 1. status: injection refusée, création ok, freeRemaining = 5
for (const bad of ['x&lifetime_free=eq.true', 'abcdefghij', 'u_lzxw4khs_3f9ab2c1&or=(a)', '', undefined]) {
  const r = mkRes(); await status(req('GET', { query: { uid: bad } }), r); assert.equal(r.statusCode, 400, 'bad uid ' + bad);
}
let r = mkRes(); await status(req('GET', { query: { uid: UID } }), r);
assert.equal(r.statusCode, 200); assert.equal(r.body.freeRemaining, FREE_SESSIONS); assert.equal(db.length, 1);
r = mkRes(); await status(req('GET', { query: { uid: UID } }), r); assert.equal(db.length, 1);


// 2. consume: 5 gratuites puis refus ; concurrence
patchDelay = 5;
const results = await Promise.all(Array.from({ length: 8 }, (_, i) => { const x = mkRes(); return consume(req('POST', { body: { uid: UID }, ip: 'ip' + i }), x).then(() => x.body); }));
const oks = results.filter(b => b.ok).length;
assert.equal(db[0].free_used, oks, 'free_used must equal number of granted sessions');
assert.ok(oks <= FREE_SESSIONS);
patchDelay = 0;
while (db[0].free_used < FREE_SESSIONS) { const x = mkRes(); await consume(req('POST', { body: { uid: UID }, ip: 'z' + db[0].free_used }), x); }
r = mkRes(); await consume(req('POST', { body: { uid: UID }, ip: '9.9.9.9' }), r);
assert.deepEqual(r.body, { ok: false, reason: 'no_credits', creditsLeft: 0 });
r = mkRes(); await consume(req('POST', { body: { uid: 'x&y' }, ip: '9.9.9.8' }), r); assert.equal(r.body.reason, 'no_credits');
r = mkRes(); await consume(req('POST', { body: '{bad', ip: '9.9.9.7' }), r); assert.equal(r.statusCode, 400);
// rate limit
let limited = false; for (let i = 0; i < 20; i++) { const x = mkRes(); await consume(req('POST', { body: { uid: UID2 }, ip: 'same' }), x); if (x.statusCode === 429) limited = true; }
assert.ok(limited);

// 3. checkout: validation, URL de succès corrigée, pack invalide, prototype pollution
r = mkRes(); await checkout(req('POST', { body: { uid: 'short', pack: '5' } }), r); assert.equal(r.statusCode, 400);
r = mkRes(); await checkout(req('POST', { body: { uid: UID, pack: 'toString' } }), r); assert.equal(r.statusCode, 400);
r = mkRes(); await checkout(req('POST', { body: { uid: UID, pack: '5' } }), r); assert.equal(r.statusCode, 200);
const created = globalThis.__stripeCalls.created.at(-1);
assert.equal(created.success_url, 'https://folio-backend-ebon.vercel.app/payment-success.html?session_id={CHECKOUT_SESSION_ID}');
assert.equal(created.client_reference_id, UID);

// 4. webhook: signature, crédits, idempotence
const Real = require(process.env.REAL_STRIPE); const real = new Real('sk_test_dummy');
async function sendEvent(obj) {
  const payload = JSON.stringify(obj);
  const header = real.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  const { Readable } = await import('stream');
  const rq = Readable.from([Buffer.from(payload)]); rq.method = 'POST'; rq.headers = { 'stripe-signature': header };
  const x = mkRes(); await webhook(rq, x); return x;
}
const ev = (id, pi, meta) => ({ id: 'evt_' + id, type: 'checkout.session.completed', data: { object: { id: 'cs_' + id, payment_status: 'paid', payment_intent: pi, metadata: meta } } });
r = await sendEvent(ev('a', 'pi_a', { uid: UID, pack: '5', credits: '5', lifetime: 'false' })); assert.equal(r.statusCode, 200);
assert.equal(db[0].credits, 5);
r = await sendEvent(ev('a', 'pi_a', { uid: UID, pack: '5', credits: '5', lifetime: 'false' })); assert.equal(r.body.duplicate, true);
assert.equal(db[0].credits, 5, 'no double credit on retry');
// tampered credits metadata ignored → derived from pack
r = await sendEvent(ev('b', 'pi_b', { uid: UID, pack: '1', credits: '999', lifetime: 'false' })); assert.equal(db[0].credits, 6);
// unknown user → created with credits
r = await sendEvent(ev('c', 'pi_c', { uid: UID2, pack: '20', credits: '20', lifetime: 'false' }));
assert.equal(db.find(x => x.uid === UID2).credits, 20);
// lifetime
r = await sendEvent(ev('d', 'pi_d', { uid: UID, pack: 'lifetime', credits: '0', lifetime: 'true' })); assert.equal(db[0].lifetime_free, true);
// injection uid ignored
const before = JSON.stringify(db);
r = await sendEvent(ev('e', 'pi_e', { uid: 'x&uid=neq.zzz', pack: '5' })); assert.equal(r.statusCode, 200); assert.equal(JSON.stringify(db), before);
// bad signature
{ const { Readable } = await import('stream'); const rq = Readable.from([Buffer.from('{}')]); rq.method = 'POST'; rq.headers = { 'stripe-signature': 't=1,v1=abc' }; const x = mkRes(); await webhook(rq, x); assert.equal(x.statusCode, 400); }
// consume for lifetime
r = mkRes(); await consume(req('POST', { body: { uid: UID }, ip: '7.7.7.7' }), r); assert.equal(r.body.usedLifetimeFree, true); assert.equal(db[0].credits, 6);
// checkout refused for lifetime
r = mkRes(); await checkout(req('POST', { body: { uid: UID, pack: '5' }, ip: '5.5.5.5' }), r); assert.equal(r.statusCode, 409);
// paid credits consumption after free exhausted
r = mkRes(); await status(req('GET', { query: { uid: UID2 }, ip: '4.4.4.4' }), r); 
console.log('  ✔ status / consume / checkout / webhook');

// ── Sessions signées
{
  const { signSession, verifySession, SESSION_TTL_MS } = await load('lib/folio-api.js');
  const DOC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  db.push({ uid: 'u_sessions_aaaaaaaaaaaa', credits: 2, free_used: 5, lifetime_free: false, edit_count: 0 });
  const U = 'u_sessions_aaaaaaaaaaaa';
  let r = mkRes(); await consume(req('POST', { body: { uid: U, docKey: DOC }, ip: 's1' }), r);
  assert.equal(r.body.ok, true); assert.ok(r.body.session); const tok = r.body.session;
  assert.equal(db.find(x => x.uid === U).credits, 1);
  for (let i = 0; i < 30; i++) { const x = mkRes(); await consume(req('POST', { body: { uid: U, docKey: DOC, session: tok }, ip: 's1' }), x); assert.equal(x.body.sessionValid, true); }
  assert.equal(db.find(x => x.uid === U).credits, 1, 'valid token: no charge, not rate-limited by the strict limiter');
  // token reused for another document / another uid → charged
  r = mkRes(); await consume(req('POST', { body: { uid: U, docKey: 'ffffffffffffffffffffffffffffffff', session: tok }, ip: 's2' }), r);
  assert.equal(r.body.sessionValid, undefined); assert.equal(db.find(x => x.uid === U).credits, 0);
  // forged / tampered / expired tokens
  const [exp, mac] = tok.split('.');
  assert.equal(verifySession(U, DOC, `${+exp + 1000}.${mac}`), false, 'expiry tampering');
  assert.equal(verifySession(U, DOC, `${exp}.${mac.slice(0, -2)}xx`), false, 'mac tampering');
  assert.equal(verifySession(U, DOC, signSession(U, DOC, Date.now() - 1).token), false, 'expired');
  assert.equal(verifySession(U, DOC, signSession(U, DOC, Date.now() + SESSION_TTL_MS * 5).token), false, 'too far in the future');
  assert.equal(verifySession('u_sessions_bbbbbbbbbbbb', DOC, tok), false, 'other uid');
  // no credits left + forged token → no_credits
  r = mkRes(); await consume(req('POST', { body: { uid: U, docKey: DOC.replace('a', 'b'), session: tok }, ip: 's3' }), r);
  assert.equal(r.body.reason, 'no_credits');
  // extension (no docKey): unchanged response shape, no token
  r = mkRes(); await consume(req('POST', { body: { uid: UID2 }, ip: 's4' }), r);
  assert.equal(r.body.ok, true); assert.equal(r.body.session, undefined);
  console.log('  ✔ signed editing sessions');
}

// ── Limite des nouveaux UID par IP et par jour
{
  const mk = i => 'u_iplimit' + String(i).padStart(2, '0') + '_aaaaaaaaaaaa';
  const res = [];
  for (let i = 0; i < 5; i++) { const x = mkRes(); await status(req('GET', { query: { uid: mk(i) }, ip: '203.0.113.7' }), x); res.push(x.body.freeRemaining); }
  assert.deepEqual(res, [2, 2, 2, 0, 0], 'first 3 new UIDs of the day get free sessions, then none: ' + res);
  assert.equal(db.find(x => x.uid === mk(4)).free_used, FREE_SESSIONS, 'UID still created (can buy)');
  // existing UID status calls do not count
  for (let i = 0; i < 5; i++) { const x = mkRes(); await status(req('GET', { query: { uid: mk(0) }, ip: '203.0.113.7' }), x); assert.equal(x.body.freeRemaining, 2); }
  // other IP unaffected
  let x = mkRes(); await status(req('GET', { query: { uid: 'u_otherip0_aaaaaaaaaaaa' }, ip: '198.51.100.1' }), x); assert.equal(x.body.freeRemaining, 2);
  // no-free UID → consume refuses (no credits) → payment modal
  x = mkRes(); await consume(req('POST', { body: { uid: mk(4) }, ip: '9.9.9.1' }), x); assert.equal(x.body.reason, 'no_credits');
  // IP never stored: only a daily keyed hash
  assert.ok([...rpcCounts.keys()].every(k => !k.includes('203.0.113') && k.length === 32));
  assert.notEqual(hashIp('203.0.113.7', '2026-09-24'), hashIp('203.0.113.7', '2026-09-25'), 'hash rotates daily');
  // migration not applied → no limit, no error
  globalThis.__rpcMissing = true;
  x = mkRes(); await status(req('GET', { query: { uid: mk(9) }, ip: '203.0.113.7' }), x);
  assert.equal(x.statusCode, 200); assert.equal(x.body.freeRemaining, 2);
  globalThis.__rpcMissing = false;
  console.log('  ✔ free sessions limited per IP and per day');
  fs.rmSync(tmp, { recursive: true, force: true });
}
