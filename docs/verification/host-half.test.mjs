/**
 * Verification harness (not production code).
 *
 * Runs the REAL `dsh-idea-bridge/index.js` host half against a stub cordis
 * context (webServer.register collects routes, connection.requestRejection is
 * programmable, ctx.effect runs the body and records the disposer) and checks
 * contract §2/§3/§4 field by field.
 *
 * Usage: node docs/verification/host-half.test.mjs <fixture.json>
 * The fixture is one message file produced by the real IDEA-side Kotlin code
 * (docs/verification/tools/IdeaPayloadEmitter.java).
 *
 * Exit code 0 = every assertion passed.
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, statSync, readdirSync, chmodSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('../../', import.meta.url).pathname;
const HOST_HALF = join(REPO, 'dsh-plugin', 'index.js');
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : ` :: ${detail}`}`);
  }
}
function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `actual=${a} expected=${e}`);
}

// ---- stub cordis context ---------------------------------------------------
const routes = new Map();
const effects = [];
const warnings = [];
let rejection = undefined;
let sweepCallback = undefined;
let intervalCount = 0;

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn) => {
  intervalCount += 1;
  sweepCallback = fn;
  return { unref() {} };
};

const ctx = {
  logger: { warn: (...a) => warnings.push(a), error: () => {}, info: () => {} },
  connection: { requestRejection: () => rejection },
  webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    }
  },
  effect: async (fn, label) => {
    const disposer = await fn();
    effects.push({ label, disposer });
    return disposer;
  }
};

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { this.ended = true; if (chunk !== undefined) this.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); }
  };
}
function makeReq(method, bodyText) {
  const chunks = bodyText === undefined ? [] : [Buffer.from(bodyText, 'utf8')];
  return {
    method,
    headers: {},
    resumable: false,
    resume() { this.resumable = true; },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; }
  };
}
const get = (path) => routes.get(path).handler;

// ---- environment -----------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'idea-bridge-verify-'));
process.env.DSH_HOME = home;
const bridgeDir = join(home, 'idea-bridge');
const inboxDir = join(bridgeDir, 'inbox');
const locationPath = join(bridgeDir, 'location.json');

const mod = await import(pathToFileURL(HOST_HALF).href);
await mod.apply(ctx);
// interval patched above means the sweeper is captured, never actually ticking.

console.log(`# DSH_HOME=${home}`);
console.log(`# fixture=${JSON.stringify(fixture)}`);

// ---- §2 handshake ----------------------------------------------------------
check('location.json exists', existsSync(locationPath));
const location = JSON.parse(readFileSync(locationPath, 'utf8'));
equal('location keys', Object.keys(location).sort(), ['ackEndpoint', 'claimEndpoint', 'endpoint', 'inboxDir', 'pid', 'updatedAt', 'version']);
equal('location.version', location.version, 1);
equal('location.inboxDir === <DSH_HOME>/idea-bridge/inbox', location.inboxDir, inboxDir);
check('location.inboxDir is absolute', location.inboxDir.startsWith('/'), location.inboxDir);
equal('location.endpoint', location.endpoint, '/idea-bridge/pending');
// v1.1 (contract §2/§5.4): the capability signal a v1.0 host does not carry.
equal('location.claimEndpoint', location.claimEndpoint, '/idea-bridge/claim');
equal('location.ackEndpoint', location.ackEndpoint, '/idea-bridge/ack');
equal('location.pid', location.pid, process.pid);
check('location.updatedAt is a number', typeof location.updatedAt === 'number' && Number.isFinite(location.updatedAt));
const locMode = statSync(locationPath).mode & 0o777;
equal('location.json mode is 0600', locMode.toString(8), '600');
equal('bridge dir mode is 0700', (statSync(bridgeDir).mode & 0o777).toString(8), '700');
equal('inbox dir mode is 0700', (statSync(inboxDir).mode & 0o777).toString(8), '700');
check('three routes registered (v1.1: pending + claim + ack)',
  routes.has('/idea-bridge/pending') && routes.has('/idea-bridge/claim') && routes.has('/idea-bridge/ack'));
check('sweeper timer created', intervalCount === 1 && typeof sweepCallback === 'function');

// ---- §3/§4 pending ---------------------------------------------------------
const messagePath = join(inboxDir, `${fixture.id}.json`);
writeFileSync(messagePath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
const res = makeRes();
await get('/idea-bridge/pending')(makeReq('GET'), res);
equal('pending status', res.statusCode, 200);
const payload = JSON.parse(res.body);
equal('pending item count', payload.items.length, 1);
equal('pending returns the file content verbatim (key order + values)', payload.items[0], fixture);
equal('pending preserves every contract key', Object.keys(payload.items[0]).sort(),
  ['createdAt', 'file', 'id', 'language', 'lineEnd', 'lineStart', 'projectPath', 'source', 'submit', 'text', 'version']);
check('createdAt survives as a JSON number', typeof payload.items[0].createdAt === 'number');
check('lineStart survives as a JSON number', typeof payload.items[0].lineStart === 'number');

// does not consume
check('pending does not consume the file', existsSync(messagePath));

// ---- listing rules ---------------------------------------------------------
const mk = (id, createdAt, extra = {}) => {
  const p = join(inboxDir, `${id}.json`);
  writeFileSync(p, JSON.stringify({ ...fixture, id, createdAt, ...extra }), { mode: 0o600 });
  return p;
};
const old = mk('stale-000', Date.now() - 11 * 60 * 1000);
const freshA = mk('aaaa-111', Date.now() - 5000);
const freshB = mk('bbbb-222', Date.now() - 4000);
// junk that must be ignored
writeFileSync(join(inboxDir, `${fixture.id}.json.tmp`), '{ "id": "half', { mode: 0o600 });
writeFileSync(join(inboxDir, 'notes.txt'), 'not a message', { mode: 0o600 });
writeFileSync(join(inboxDir, 'broken.json'), '{ not json', { mode: 0o600 });
writeFileSync(join(inboxDir, 'wrongshape.json'), JSON.stringify({ id: 'x', text: 'y' }), { mode: 0o600 });

const res2 = makeRes();
await get('/idea-bridge/pending')(makeReq('GET'), res2);
const ids = JSON.parse(res2.body).items.map((i) => i.id);
check('stale (>10min createdAt) dropped', !ids.includes('stale-000'), ids.join(','));
check('malformed / wrong-shape / non-.json ignored', !ids.includes('x') && !ids.includes('notes'), ids.join(','));
check('fresh items present', ids.includes('aaaa-111') && ids.includes('bbbb-222'));
check('ordered by createdAt ascending', ids.indexOf('aaaa-111') < ids.indexOf('bbbb-222'), ids.join(','));
check('.tmp residue is not treated as a message', !ids.some((id) => id.endsWith('.tmp')), ids.join(','));

// at most 20
for (let i = 0; i < 25; i += 1) mk(`bulk-${String(i).padStart(2, '0')}`, Date.now() - 100000 + i);
const res3 = makeRes();
await get('/idea-bridge/pending')(makeReq('GET'), res3);
equal('pending caps at 20 items', JSON.parse(res3.body).items.length, 20);
for (let i = 0; i < 25; i += 1) { try { readdirSync(inboxDir); } catch {} }
const bulkFiles = readdirSync(inboxDir).filter((n) => n.startsWith('bulk-'));
for (const n of bulkFiles) chmodSync(join(inboxDir, n), 0o600);
for (const n of bulkFiles) { const p = join(inboxDir, n); const t = 0; utimesSync(p, t, t); }
// clean the bulk items again so later ack counts stay small
const { rmSync } = await import('node:fs');
for (const n of bulkFiles) rmSync(join(inboxDir, n), { force: true });

// ---- §4 ack ----------------------------------------------------------------
const ackRes = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', JSON.stringify({ ids: [freshA_id(), freshB_id()] })), ackRes);
function freshA_id() { return 'aaaa-111'; }
function freshB_id() { return 'bbbb-222'; }
equal('ack status', ackRes.statusCode, 200);
equal('ack body', JSON.parse(ackRes.body), { ok: true, removed: 2 });
check('acked files deleted', !existsSync(freshA) && !existsSync(freshB));

const ackRes2 = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', JSON.stringify({ ids: ['aaaa-111', 'never-existed'] })), ackRes2);
equal('repeat ack is idempotent (removed=0, still 200)', [ackRes2.statusCode, JSON.parse(ackRes2.body)], [200, { ok: true, removed: 0 }]);

const trav = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', JSON.stringify({ ids: ['../../../../etc/passwd', '..', 'a/b'] })), trav);
equal('path-traversal ids are refused, not deleted', [trav.statusCode, JSON.parse(trav.body).removed], [200, 0]);

// ---- §4 claim (v1.1 single-flight) ----------------------------------------
const claimId = 'cccc-333';
mk(claimId, Date.now() - 1000);
const claimRes = makeRes();
await get('/idea-bridge/claim')(makeReq('POST', JSON.stringify({ ids: [claimId] })), claimRes);
equal('claim status/body', [claimRes.statusCode, JSON.parse(claimRes.body)], [200, { claimed: [claimId] }]);
check('claim marker created', existsSync(join(inboxDir, `${claimId}.claim`)));
const claimAgain = makeRes();
await get('/idea-bridge/claim')(makeReq('POST', JSON.stringify({ ids: [claimId] })), claimAgain);
equal('second claim of the same id is not granted', [claimAgain.statusCode, JSON.parse(claimAgain.body)], [200, { claimed: [] }]);
const claimMissing = makeRes();
await get('/idea-bridge/claim')(makeReq('POST', JSON.stringify({ ids: ['no-such-message'] })), claimMissing);
equal('claim for a vanished .json is refused', [claimMissing.statusCode, JSON.parse(claimMissing.body)], [200, { claimed: [] }]);
check('refused claim leaves no marker behind', !existsSync(join(inboxDir, 'no-such-message.claim')));
const pendingAfterClaim = makeRes();
await get('/idea-bridge/pending')(makeReq('GET'), pendingAfterClaim);
check('a claimed-but-unacked message is still listed (not consumed by claim)',
  JSON.parse(pendingAfterClaim.body).items.some((i) => i.id === claimId));
const ackClaim = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', JSON.stringify({ ids: [claimId] })), ackClaim);
equal('ack removes message + claim together', [ackClaim.statusCode, JSON.parse(ackClaim.body), existsSync(join(inboxDir, `${claimId}.json`)), existsSync(join(inboxDir, `${claimId}.claim`))],
  [200, { ok: true, removed: 1 }, false, false]);
const claimMethod = makeRes();
await get('/idea-bridge/claim')(makeReq('GET'), claimMethod);
equal('claim GET -> 405 + Allow', [claimMethod.statusCode, claimMethod.headers.allow], [405, 'POST']);
const claimBad = makeRes();
await get('/idea-bridge/claim')(makeReq('POST', '{ nope'), claimBad);
equal('claim bad JSON -> 400', claimBad.statusCode, 400);
const claimTrav = makeRes();
await get('/idea-bridge/claim')(makeReq('POST', JSON.stringify({ ids: ['../../etc/passwd'] })), claimTrav);
equal('claim path-traversal id refused', [claimTrav.statusCode, JSON.parse(claimTrav.body)], [200, { claimed: [] }]);

// ---- method / body validation ---------------------------------------------
const m1 = makeRes();
await get('/idea-bridge/pending')(makeReq('POST', '{}'), m1);
equal('pending POST -> 405 + Allow', [m1.statusCode, m1.headers.allow], [405, 'GET']);
const m2 = makeRes();
await get('/idea-bridge/ack')(makeReq('GET'), m2);
equal('ack GET -> 405 + Allow', [m2.statusCode, m2.headers.allow], [405, 'POST']);
const b1 = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', '{ not json'), b1);
equal('ack bad JSON -> 400', b1.statusCode, 400);
const b2 = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', JSON.stringify({ ids: [1, 2] })), b2);
equal('ack non-string ids -> 400', b2.statusCode, 400);
const b3 = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', JSON.stringify({ ids: [] })), b3);
equal('ack empty ids -> 200 removed 0', [b3.statusCode, JSON.parse(b3.body)], [200, { ok: true, removed: 0 }]);
const big = makeRes();
await get('/idea-bridge/ack')(makeReq('POST', 'x'.repeat(70 * 1024)), big);
equal('ack oversized body -> 413', big.statusCode, 413);

// ---- the connection gate ---------------------------------------------------
rejection = 401;
const g1 = makeRes();
await get('/idea-bridge/pending')(makeReq('GET'), g1);
equal('rejected pending -> 401 with empty body', [g1.statusCode, g1.body], [401, undefined]);
const g2 = makeRes();
writeFileSync(join(inboxDir, 'gate-000.json'), JSON.stringify({ ...fixture, id: 'gate-000' }), { mode: 0o600 });
await get('/idea-bridge/ack')(makeReq('POST', JSON.stringify({ ids: ['gate-000'] })), g2);
equal('rejected ack -> 401 and file kept', [g2.statusCode, existsSync(join(inboxDir, 'gate-000.json'))], [401, true]);
rejection = 403;
const g3 = makeRes();
await get('/idea-bridge/pending')(makeReq('GET'), g3);
equal('rejection status is passed through verbatim (403)', g3.statusCode, 403);
rejection = undefined;

// ---- sweeper ---------------------------------------------------------------
// NOTE: the sweeper ages files by mtime, while the listing ages them by
// createdAt. Reproduce both.
const sweepMtime = mk('sweep-mtime-old', Date.now() - 1000);
const long = (Date.now() - 11 * 60 * 1000) / 1000;
utimesSync(sweepMtime, long, long);
const sweepCreatedOld = mk('sweep-created-old', Date.now() - 11 * 60 * 1000);
const before = JSON.parse(readFileSync(locationPath, 'utf8')).updatedAt;
await new Promise((r) => setTimeout(r, 5));
sweepCallback();
await new Promise((r) => setTimeout(r, 50)); // the interval body does not return its promise
check('sweeper removes files whose mtime is >10min old', !existsSync(sweepMtime));
equal('sweeper keeps old-createdAt/fresh-mtime files (mtime criterion)', existsSync(sweepCreatedOld), true);
check('sweeper does not consume live files', existsSync(join(inboxDir, 'gate-000.json')));
const after = JSON.parse(readFileSync(locationPath, 'utf8')).updatedAt;
check('sweeper refreshes updatedAt heartbeat', after >= before, `${before} -> ${after}`);

// ---- disposal --------------------------------------------------------------
equal('four effects registered (v1.1: handshake + three routes)', effects.length, 4);
for (const e of effects.slice(1)) await e.disposer();
equal('routes disposed', routes.size, 0);
await effects[0].disposer();
check('disposer removes own location.json', !existsSync(locationPath));

// foreign pid must survive disposal
writeFileSync(locationPath, JSON.stringify({ ...location, pid: process.pid + 1 }), { mode: 0o600 });
const beforeReapply = effects.length;
let reapplyError;
try {
  await mod.apply(ctx);
} catch (error) {
  reapplyError = error;
}
check('re-applying the bundle (plugin reload) does not throw', reapplyError === undefined, String(reapplyError));
if (reapplyError === undefined) {
  // a newer instance (different pid) installs its handshake, then this one is disposed
  writeFileSync(locationPath, JSON.stringify({ ...location, pid: process.pid + 1 }), { mode: 0o600 });
  await effects[beforeReapply].disposer();
  check('a newer instance handshake is not removed by an older process', existsSync(locationPath));
}

console.log(`\n# logger warnings: ${warnings.length}`);
for (const w of warnings) console.log(`#   ${w[0]?.message ?? JSON.stringify(w[0])}`);
console.log(`\n# summary: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
