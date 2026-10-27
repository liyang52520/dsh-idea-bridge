/**
 * Verification aid (not production code): one independent DSH-side claimer.
 * Runs the real host half against $DSH_HOME and posts the given ids to the
 * real claim handler, printing the granted list as JSON on stdout.
 *
 * Usage: DSH_HOME=<dir> node tools/claim-worker.mjs <id> [<id>...]
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO = new URL('../../../', import.meta.url).pathname;
const routes = new Map();
const ctx = {
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  connection: { requestRejection: () => undefined },
  webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  effect: async (fn) => await fn()
};
const mod = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'index.js')).href);
await mod.apply(ctx);

const chunks = [Buffer.from(JSON.stringify({ ids: process.argv.slice(2) }), 'utf8')];
const req = { method: 'POST', headers: {}, resume() {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
const res = {
  statusCode: 0, body: undefined,
  setHeader() {},
  end(chunk) { if (chunk !== undefined) this.body = String(chunk); }
};
await routes.get('/idea-bridge/claim').handler(req, res);
process.stdout.write(res.body);
