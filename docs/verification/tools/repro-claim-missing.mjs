/**
 * Verification aid (not production code): what does the v1.1 client half do
 * against a v1.0 host half (one that has no POST /idea-bridge/claim)?
 *
 * That is not hypothetical: on 2026-10-26T18:11 the live desktop client
 * answered /idea-bridge/pending 401, /idea-bridge/ack 401 and
 * /idea-bridge/claim 404 — the running DSH process still had the old host
 * half loaded (see docs/verification/output/live-dsh.txt).
 *
 * Usage: node docs/verification/tools/repro-claim-missing.mjs <fixture.json>
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('../../../', import.meta.url).pathname;
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));

// ---- virtual clock + browser globals (as in client-half.test.mjs) ----------
const realSetTimeout = globalThis.setTimeout;
const flushIO = () => new Promise((r) => realSetTimeout(r, 3));
let nowMs = 0; let seq = 0; const timers = new Map();
globalThis.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: nowMs + ms }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: nowMs + ms, every: ms }); return id; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.clearInterval = (id) => timers.delete(id);
async function advance(ms) {
  const target = nowMs + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
    if (due.length === 0) break;
    const at = due[0][1].at; nowMs = at;
    for (const [id, t] of due) { if (t.at !== at) break; if (t.every === undefined) timers.delete(id); else t.at = nowMs + t.every; t.fn(); }
    await flushIO();
  }
  nowMs = target;
  await flushIO();
}
globalThis.document = { visibilityState: 'visible' };
const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (r) => registrations.push(r) } };

// ---- host half, then emulate a v1.0 host by dropping the claim route ------
const home = mkdtempSync(join(tmpdir(), 'idea-bridge-v1host-'));
process.env.DSH_HOME = home;
const inboxDir = join(home, 'idea-bridge', 'inbox');
const routes = new Map();
const host = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'index.js')).href);
await host.apply({
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  connection: { requestRejection: () => undefined },
  webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } },
  effect: async (fn) => await fn()
});
const claimWasRegistered = routes.delete('/idea-bridge/claim');
console.log(`# claim route present before emulation: ${claimWasRegistered}`);
console.log('# emulating a v1.0 host: /idea-bridge/claim now answers 404');

const fetchLog = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const method = init.method ?? 'GET';
  fetchLog.push(`${method} ${path}`);
  const route = routes.get(path);
  if (route === undefined) return { ok: false, status: 404, async json() { return {}; } };
  const chunks = init.body === undefined ? [] : [Buffer.from(String(init.body), 'utf8')];
  const req = { method, headers: {}, resume() {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  const res = {
    statusCode: 200, body: undefined, setHeader() {},
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); }
  };
  await route.handler(req, res);
  return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, async json() { return JSON.parse(res.body); } };
};

// ---- mount the real client half -------------------------------------------
let cursor = 0; let current;
const React = {
  useRef(v) { const slot = current.refSlot(cursor++); if (!('current' in slot)) slot.current = v; return slot; },
  useEffect(fn, deps) { current.pending.push({ fn, deps, slot: cursor++ }); },
  createElement() { return null; }
};
const source = readFileSync(join(REPO, 'dsh-plugin', 'client.js'), 'utf8');
new Function('window', 'require', source)(globalThis.window, (spec) => { if (spec === 'react') return React; throw new Error(spec); });
const clientModule = registrations[0].factory((spec) => { if (spec === 'react') return React; throw new Error(spec); });
let Component;
clientModule.apply({ slots: { inject: (n, cb) => cb(), register: (o, c) => { Component = c; return () => {}; } } });

const calls = [];
// v1.1 delivers by INSERTION (captureInsertion + insertText), never setDraft.
const actions = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
  insertText: (t, span) => {
    if (span === undefined || span.draftRev !== 1) return false;
    calls.push(['insertText', t]);
    return true;
  },
  submit: () => calls.push(['submit'])
};
const instance = {
  refSlots: [], pending: [], cleanups: [],
  refSlot(i) { return (this.refSlots[i] ??= {}); }
};
current = instance;
const id = 'v1host-000';
writeFileSync(join(inboxDir, `${id}.json`), JSON.stringify({ ...fixture, id, createdAt: Date.now() }), { mode: 0o600 });
Component({ sessionId: 's1', inputActions: actions, useSessions: (sel) => sel({ byId: { s1: { cwd: fixture.projectPath } } }) });
for (const e of instance.pending) { const c = e.fn(); if (typeof c === 'function') instance.cleanups.push(c); }

await advance(800);
await advance(1500);
await advance(1500);

console.log(`# fetch sequence: ${fetchLog.join(', ')}`);
console.log(`# composer writes: ${JSON.stringify(calls)}`);
console.log(`# message still in the inbox: ${existsSync(join(inboxDir, `${id}.json`))}`);
console.log(calls.length === 0
  ? 'DEFECT  a v1.1 client against a v1.0 host delivers nothing (silent stall, no fallback, no error surface)'
  : 'PASS  the client still delivers without the claim route');
