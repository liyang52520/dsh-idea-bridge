/**
 * Verification aid (not production code). Stress-tests the two host-half
 * failure modes that defect D1 reported, plus handshake ownership:
 *
 *  1. sequential re-apply of the bundle in one process (plugin reload),
 *  2. many concurrent apply() calls in the same millisecond,
 *  3. dispose of an old activation must not delete a newer activation's
 *     handshake file (same pid, cordis hot reload),
 *  4. no `*.tmp` residue and a parseable handshake after every round.
 *
 * Usage: node docs/verification/tools/repro-reapply.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('../../../', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'idea-bridge-repro-'));
process.env.DSH_HOME = home;
const dir = join(home, 'idea-bridge');
const locationPath = join(dir, 'location.json');

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : ` :: ${detail}`}`); }
};
const equal = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`);

function makeCtx() {
  const routes = new Map();
  const effects = [];
  return {
    routes, effects,
    ctx: {
      logger: { warn: (...a) => console.log('WARN', String(a[0]?.message ?? a[0])), error: () => {}, info: () => {} },
      connection: { requestRejection: () => undefined },
      webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } },
      effect: async (fn) => { const d = await fn(); effects.push(d); return d; }
    }
  };
}
const mod = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'index.js')).href);

// ---- 1. sequential re-apply ------------------------------------------------
{
  const a = makeCtx();
  await mod.apply(a.ctx);
  const b = makeCtx();
  let error;
  const t0 = Date.now();
  try { await mod.apply(b.ctx); } catch (e) { error = e; }
  check('sequential re-apply in one process does not throw', error === undefined, String(error));
  console.log(`# sequential re-apply elapsed ${Date.now() - t0} ms`);
  await a.effects[0]();
  check('disposing the OLD activation keeps the NEW handshake', existsSync(locationPath));
  await b.effects[0]();
  check('disposing the owner removes the handshake', !existsSync(locationPath));
}

// ---- 2. concurrent applies, repeated --------------------------------------
let collisions = 0;
let rounds = 0;
for (let round = 0; round < 8; round += 1) {
  const contexts = Array.from({ length: 6 }, () => makeCtx());
  const results = await Promise.allSettled(contexts.map((c) => mod.apply(c.ctx)));
  rounds += 1;
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (errors.length > 0) collisions += 1;
  check(`round ${round}: six concurrent apply() calls all succeed`, errors.length === 0, errors.join(' | '));
  let parsed;
  try { parsed = JSON.parse(readFileSync(locationPath, 'utf8')); } catch (e) { parsed = undefined; }
  check(`round ${round}: handshake is valid JSON`, parsed !== undefined);
  equal(`round ${round}: handshake inboxDir`, parsed?.inboxDir, join(home, 'idea-bridge', 'inbox'));
  const tmpLeft = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  equal(`round ${round}: no *.tmp residue`, tmpLeft, []);
  // dispose newest first, then the rest
  for (const c of contexts.reverse()) for (const d of c.effects.reverse()) { try { await d(); } catch (e) { console.log('WARN dispose', e.message); } }
}
console.log(`# rounds=${rounds} rounds-with-a-failure=${collisions}`);

// ---- 3. the original same-millisecond scenario ----------------------------
{
  const realNow = Date.now;
  Date.now = () => 1793000000000; // freeze the clock: pid+Date.now() names would collide
  const contexts = Array.from({ length: 4 }, () => makeCtx());
  const results = await Promise.allSettled(contexts.map((c) => mod.apply(c.ctx)));
  Date.now = realNow;
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  check('frozen-clock concurrent apply() (old D1 trigger) all succeed', errors.length === 0, errors.join(' | '));
  check('frozen-clock handshake exists', existsSync(locationPath));
}

console.log(`\n# summary: ${failures === 0 ? 'all checks passed' : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
