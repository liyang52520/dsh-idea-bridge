/**
 * Adversarial verification of the v1.1 claim route (not production code).
 *
 * Everything here runs the REAL `dsh-idea-bridge/index.js`; the multi-process
 * cases additionally run several independent node processes against one inbox,
 * which is how "another tab / another window / another DSH process" looks from
 * the host's point of view.
 *
 * Usage: node docs/verification/claim-adversarial.test.mjs <fixture.json>
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync, statSync, utimesSync, readdirSync, chmodSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('../../', import.meta.url).pathname;
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
  if (condition) { passes += 1; console.log(`PASS  ${name}`); }
  else { failures += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : ` :: ${detail}`}`); }
}
function equal(name, actual, expected) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  check(name, a === e, `actual=${a} expected=${e}`);
}

// ---- stub cordis context ---------------------------------------------------
const routes = new Map();
const effects = [];
const ctx = {
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  connection: { requestRejection: () => undefined },
  webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  effect: async (fn) => { const d = await fn(); effects.push(d); return d; }
};
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); }
  };
}
function makeReq(method, bodyText) {
  const chunks = bodyText === undefined ? [] : [Buffer.from(bodyText, 'utf8')];
  return { method, headers: {}, resume() {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}
let sweepCallback;
globalThis.setInterval = (fn) => { sweepCallback = fn; return { unref() {} }; };

const home = mkdtempSync(join(tmpdir(), 'idea-bridge-claim-'));
process.env.DSH_HOME = home;
const inboxDir = join(home, 'idea-bridge', 'inbox');
const mod = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'index.js')).href);
await mod.apply(ctx);
const claim = routes.get('/idea-bridge/claim').handler;
const ack = routes.get('/idea-bridge/ack').handler;
const pending = routes.get('/idea-bridge/pending').handler;
console.log(`# DSH_HOME=${home}`);

const put = (id, extra = {}) => writeFileSync(join(inboxDir, `${id}.json`), JSON.stringify({ ...fixture, id, createdAt: Date.now(), ...extra }), { mode: 0o600 });
const claimIds = async (ids) => {
  const res = makeRes();
  await claim(makeReq('POST', JSON.stringify(ids === undefined ? {} : { ids })), res);
  return { status: res.statusCode, body: res.body === undefined ? undefined : JSON.parse(res.body) };
};
const ackIds = async (ids) => {
  const res = makeRes();
  await ack(makeReq('POST', JSON.stringify({ ids })), res);
  return { status: res.statusCode, body: res.body === undefined ? undefined : JSON.parse(res.body) };
};
const listPending = async () => {
  const res = makeRes();
  await pending(makeReq('GET'), res);
  return JSON.parse(res.body).items.map((i) => i.id);
};
const claimFile = (id) => join(inboxDir, `${id}.claim`);
const jsonFile = (id) => join(inboxDir, `${id}.json`);
let n = 0;
const nextId = () => `claim-${String(n++).padStart(3, '0')}`;
const age = (path, ms) => { const t = (Date.now() - ms) / 1000; utimesSync(path, t, t); };

// ---- 1. two concurrent in-process claims ----------------------------------
{
  const id = nextId();
  put(id);
  const [a, b] = await Promise.all([claimIds([id]), claimIds([id])]);
  const granted = [a, b].flatMap((r) => r.body.claimed);
  equal('two concurrent claims: exactly one wins', granted, [id]);
  equal('two concurrent claims: both answered 200', [a.status, b.status], [200, 200]);
}

// ---- 2. many concurrent in-process claims on many ids --------------------
{
  const ids = Array.from({ length: 20 }, () => nextId());
  ids.forEach((id) => put(id));
  const results = await Promise.all([claimIds(ids), claimIds(ids), claimIds(ids)]);
  const granted = results.flatMap((r) => r.body.claimed);
  equal('three concurrent claims over 20 ids partition them exactly', [...granted].sort(), [...ids].sort());
  equal('no id is granted twice', granted.length, new Set(granted).size);
  await ackIds(ids); // keep the listing under its 20-item cap for later checks
}

// ---- 3. N real OS processes racing the same ids --------------------------
{
  const ids = Array.from({ length: 8 }, () => nextId());
  ids.forEach((id) => put(id));
  const worker = join(REPO, 'docs/verification/tools/claim-worker.mjs');
  const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    execFile(process.execPath, [worker, ...ids], { env: { ...process.env, DSH_HOME: home } }, (error, stdout) => {
      if (error) { resolve({ error: String(error) }); return; }
      try { resolve({ claimed: JSON.parse(stdout).claimed }); } catch (e) { resolve({ raw: stdout }); }
    });
  })));
  const granted = runs.flatMap((r) => r.claimed ?? []);
  equal('four OS processes: every id claimed exactly once', [...granted].sort(), [...ids].sort(), JSON.stringify(runs));
  await ackIds(ids);
}

// ---- 4. a claim marker alone blocks nobody else --------------------------
{
  const id = nextId();
  put(id);
  equal('first claim granted', (await claimIds([id])).body, { claimed: [id] });
  check('.json is untouched by the claim', existsSync(jsonFile(id)));
  equal('a claimed-but-unacked message is still listed', (await listPending()).includes(id), true);
  equal('the other instance is refused', (await claimIds([id])).body, { claimed: [] });
  equal('the refusing instance created no second marker', readdirSync(inboxDir).filter((f) => f === `${id}.claim`).length, 1);
  equal('claim marker mode is 0600', (statSync(claimFile(id)).mode & 0o777).toString(8), '600');
  equal('claim marker content names a pid', /^\d+\n\d+\n$/.test(readFileSync(claimFile(id), 'utf8')), true);
}

// ---- 5. claim of an id whose .json vanished ------------------------------
{
  const id = nextId();
  put(id);
  rmSync(jsonFile(id));
  equal('claim refused when the message is gone', (await claimIds([id])).body, { claimed: [] });
  check('no marker is left for a message that does not exist', !existsSync(claimFile(id)));
}

// ---- 6. duplicate ids and mixed junk in one request ----------------------
{
  const id = nextId();
  put(id);
  equal('duplicate ids in one request are granted once', (await claimIds([id, id, id])).body, { claimed: [id] });
  equal('non-string ids -> 400', (await claimIds([1, 2])).status, 400);
  equal('missing "ids" -> 400', (await claimIds(undefined)).status, 400);
  {
    const big = makeRes();
    await claim(makeReq('POST', 'x'.repeat(70 * 1024)), big);
    equal('oversized claim body -> 413', big.statusCode, 413);
  }
  equal('path-traversal id refused, nothing created',
    (await claimIds(['../../../../tmp/evil', '..', 'a/b'])).body, { claimed: [] });
  check('no file escaped the inbox', !existsSync('/tmp/evil.claim'));
}

// ---- 7. ack semantics with/without markers -------------------------------
{
  const orphan = nextId();
  put(orphan);
  await claimIds([orphan]);
  rmSync(jsonFile(orphan)); // message swept away, marker orphaned
  equal('ack of an orphan marker removes it and counts once', (await ackIds([orphan])).body, { ok: true, removed: 1 });
  check('orphan marker deleted', !existsSync(claimFile(orphan)));

  const never = nextId();
  put(never);
  equal('ack of a never-claimed message still removes it', (await ackIds([never])).body, { ok: true, removed: 1 });
  check('never-claimed message deleted', !existsSync(jsonFile(never)));

  equal('repeat ack is idempotent', (await ackIds([never])).body, { ok: true, removed: 0 });
  equal('ack of a traversal id does nothing', (await ackIds(['../x'])).body, { ok: true, removed: 0 });
}

// ---- 8. claim-then-crash recovery ----------------------------------------
{
  // Case A: the marker ages out while the message is still fresh -> delivery recovers.
  const id = nextId();
  put(id);
  await claimIds([id]);
  age(claimFile(id), 11 * 60 * 1000);
  sweepCallback();
  await new Promise((r) => setTimeout(r, 60));
  check('sweeper recycles an expired claim marker', !existsSync(claimFile(id)));
  check('sweeper keeps the fresh message', existsSync(jsonFile(id)));
  equal('the message can be claimed again after the marker expired', (await claimIds([id])).body, { claimed: [id] });
  await ackIds([id]);

  // Case B: both files age past the window -> nothing is delivered (contract: >10min is dropped).
  const stale = nextId();
  put(stale);
  await claimIds([stale]);
  age(jsonFile(stale), 11 * 60 * 1000);
  age(claimFile(stale), 11 * 60 * 1000);
  sweepCallback();
  await new Promise((r) => setTimeout(r, 60));
  check('expired message and marker are both recycled', !existsSync(jsonFile(stale)) && !existsSync(claimFile(stale)));
  equal('an expired id is no longer listed', (await listPending()).includes(stale), false);
  equal('an expired id can no longer be claimed', (await claimIds([stale])).body, { claimed: [] });

  // Case C: a fresh marker is not recycled.
  const live = nextId();
  put(live);
  await claimIds([live]);
  sweepCallback();
  await new Promise((r) => setTimeout(r, 60));
  check('sweeper keeps a fresh marker', existsSync(claimFile(live)));
  await ackIds([live]);
}

// ---- 9. missing inbox ------------------------------------------------------
{
  const id = nextId();
  put(id);
  rmSync(inboxDir, { recursive: true, force: true });
  equal('claim against a missing inbox claims nothing', (await claimIds([id])).body, { claimed: [] });
  check('claim recreates the inbox', existsSync(inboxDir));
}

// ---- 10. claim and ack racing each other ---------------------------------
{
  const id = nextId();
  put(id);
  const [c, a] = await Promise.all([claimIds([id]), ackIds([id])]);
  const outcomes = [c.body.claimed.length, a.body.removed];
  check('claim/ack race ends in one of the two safe states',
    JSON.stringify(outcomes) === '[1,0]' || JSON.stringify(outcomes) === '[0,1]' || JSON.stringify(outcomes) === '[1,1]',
    JSON.stringify(outcomes));
  await ackIds([id]);
  check('no files survive the race cleanup', !existsSync(jsonFile(id)) && !existsSync(claimFile(id)));
}

// ---- 10b. read-only inbox: claim must degrade, not throw -----------------
{
  const id = nextId();
  put(id);
  chmodSync(inboxDir, 0o500);
  let threw;
  let result;
  try { result = await claimIds([id]); } catch (error) { threw = error; }
  chmodSync(inboxDir, 0o700);
  check('claim against a read-only inbox does not throw', threw === undefined, String(threw));
  equal('claim against a read-only inbox grants nothing', result?.body, { claimed: [] });
  check('claim against a read-only inbox leaves no marker', !existsSync(claimFile(id)));
  rmSync(jsonFile(id), { force: true });
}

// ---- 11. the gate still guards claim -------------------------------------
{
  const id = nextId();
  put(id);
  let rejection = 401;
  const guarded = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    connection: { requestRejection: () => rejection },
    webServer: { register: (r) => { routes.set(r.path, r); return () => {}; } },
    effect: async (fn) => await fn()
  };
  const home2 = mkdtempSync(join(tmpdir(), 'idea-bridge-claim-guard-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home2;
  const mod2 = await import(`${pathToFileURL(join(REPO, 'dsh-plugin', 'index.js')).href}?guard=1`);
  await mod2.apply(guarded);
  const res = makeRes();
  await routes.get('/idea-bridge/claim').handler(makeReq('POST', JSON.stringify({ ids: [id] })), res);
  equal('rejected claim -> 401 and no marker', [res.statusCode, res.body], [401, undefined]);
  check('no marker under the guarded home', !existsSync(join(home2, 'idea-bridge', 'inbox', `${id}.claim`)));
  rejection = undefined;
  process.env.DSH_HOME = previous;
}

// final hygiene: ack whatever is still held so the run leaves nothing behind
for (const name of readdirSync(inboxDir)) {
  if (name.endsWith('.json')) await ackIds([name.slice(0, -5)]);
}
console.log(`\n# inbox left: ${readdirSync(inboxDir).join(', ') || '(empty)'}`);
console.log(`\n# summary: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
