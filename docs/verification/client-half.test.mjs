/**
 * Verification harness (not production code).
 *
 * Drives the REAL `dsh-idea-bridge/client.js` component against the REAL
 * `dsh-idea-bridge/index.js` host half:
 *
 *  - `window.__ModuleLoader__.load` is stubbed to capture the bundle factory,
 *  - `react` is a two-hook shim (`useRef`, `useEffect`) so the component can be
 *    mounted without a renderer,
 *  - `setTimeout`/`setInterval` are a virtual clock (real timers are kept for
 *    flushing filesystem I/O),
 *  - `fetch` dispatches into the host half's registered route handlers, so
 *    pending/ack really read and delete files under a temp DSH_HOME.
 *
 * Every test unmounts its clients before the next one, so no stray poll loop
 * can consume another test's message.
 *
 * Usage: node docs/verification/client-half.test.mjs <fixture.json>
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('../../', import.meta.url).pathname;
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));

let failures = 0;
let passes = 0;
const defects = [];
function check(name, condition, detail) {
  if (condition) { passes += 1; console.log(`PASS  ${name}`); }
  else { failures += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : ` :: ${detail}`}`); }
}
function defect(name, detail) {
  defects.push(name);
  console.log(`DEFECT  ${name}${detail === undefined ? '' : ` :: ${detail}`}`);
}
function equal(name, actual, expected) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  check(name, a === e, `actual=${a} expected=${e}`);
}

// ---- virtual clock ---------------------------------------------------------
/** Real timer, captured before the virtual clock replaces the global. */
const realSetTimeout = globalThis.setTimeout;
const flushIO = () => new Promise((resolve) => realSetTimeout(resolve, 3));
let nowMs = 0;
let seq = 0;
const timers = new Map();
globalThis.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, { fn, at: nowMs + ms, every: undefined }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: nowMs + ms, every: ms }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.clearInterval = (id) => { timers.delete(id); };
async function advance(ms) {
  const target = nowMs + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at);
    if (due.length === 0) break;
    // Every timer due at the same instant fires together, the way independent
    // browser clients would: no flush between them, so in-flight requests of
    // one client really overlap another client's.
    const at = due[0][1].at;
    nowMs = at;
    for (const [id, t] of due) {
      if (t.at !== at) break;
      if (t.every === undefined) timers.delete(id);
      else t.at = nowMs + t.every;
      t.fn();
    }
    await flushIO();
  }
  nowMs = target;
  await flushIO();
}

// ---- browser globals -------------------------------------------------------
globalThis.document = { visibilityState: 'visible' };
const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };

// ---- host half under a temp DSH_HOME --------------------------------------
const home = mkdtempSync(join(tmpdir(), 'idea-bridge-client-verify-'));
process.env.DSH_HOME = home;
const inboxDir = join(home, 'idea-bridge', 'inbox');
const routes = new Map();
const hostCtx = {
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  connection: { requestRejection: () => undefined },
  webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } },
  effect: async (fn) => await fn()
};
const host = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'index.js')).href);
await host.apply(hostCtx);
if (process.env.VERIFY_DEBUG) console.log('[host] routes:', [...routes.keys()], 'home:', home);

// ---- fetch shim ------------------------------------------------------------
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(chunk) { if (chunk !== undefined) this.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); }
  };
}
const fetchLog = [];
let ackFailures = 0;
let pendingFailures = 0;
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const method = init.method ?? 'GET';
  fetchLog.push(`${method} ${path}`);
  if (path === '/idea-bridge/ack' && ackFailures > 0) { ackFailures -= 1; return { ok: false, status: 500, async json() { return {}; } }; }
  if (path === '/idea-bridge/pending' && pendingFailures > 0) { pendingFailures -= 1; return { ok: false, status: 500, async json() { return {}; } }; }
  const route = routes.get(path);
  if (route === undefined) return { ok: false, status: 404, async json() { return {}; } };
  const chunks = init.body === undefined ? [] : [Buffer.from(String(init.body), 'utf8')];
  const req = { method, headers: {}, resume() {}, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
  const res = makeRes();
  await route.handler(req, res);
  if (process.env.VERIFY_DEBUG) console.log('   [fetch]', method, path, '->', res.statusCode, res.body);
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    async json() { return JSON.parse(res.body); }
  };
};

// ---- react shim + mount ----------------------------------------------------
let cursor = 0;
let current = undefined;
const React = {
  useRef(value) { const slot = current.refSlot(cursor++); if (!('current' in slot)) slot.current = value; return slot; },
  useEffect(fn, deps) { current.pending.push({ fn, deps, slot: cursor++ }); },
  createElement() { return null; }
};

function makeInstance(props) {
  return {
    props, refSlots: [], pending: [], cleanups: [],
    refSlot(i) { return (this.refSlots[i] ??= {}); },
    flushEffects() {
      for (const effect of this.pending) {
        const previous = this.refSlots[`dep${effect.slot}`];
        const same = previous !== undefined && effect.deps !== undefined && previous.length === effect.deps.length &&
          previous.every((d, i) => Object.is(d, effect.deps[i]));
        if (same) continue;
        this.refSlots[`dep${effect.slot}`] = effect.deps;
        const cleanup = effect.fn();
        if (typeof cleanup === 'function') this.cleanups.push(cleanup);
      }
      this.pending = [];
    },
    async mount() {
      cursor = 0;
      current = this;
      Component(this.props);
      this.flushEffects();
      await flushIO();
      return this;
    },
    async unmount() { for (const c of this.cleanups.reverse()) c(); this.cleanups = []; await flushIO(); }
  };
}
const mount = (props) => makeInstance(props).mount();

// ---- load the client bundle ------------------------------------------------
const clientSource = readFileSync(join(REPO, 'dsh-plugin', 'client.js'), 'utf8');
new Function('window', 'require', clientSource)(globalThis.window, (spec) => {
  if (spec === 'react') return React;
  throw new Error(`unexpected require(${spec})`);
});
equal('client bundle registers one module', registrations.length, 1);
equal('client module id', registrations[0].id, '@local/dsh-idea-bridge');
const clientModule = registrations[0].factory((spec) => {
  if (spec === 'react') return React;
  throw new Error(`unexpected require(${spec})`);
});
equal('client module inject', clientModule.inject, ['slots']);
check('client module exposes apply()', typeof clientModule.apply === 'function');

let registeredOptions;
let Component;
/**
 * Controllable stand-in for the session scope's chip channel
 * (`slash/input-insert-reference`, contract §5.3). `chipMode`:
 *   'accept'  — the composition inserts a chip (bail returns true)
 *   'refuse'  — no listener accepts (bail returns undefined) → plain-text fallback
 *   'explode' — the scope throws, which must also fall back, never fail
 */
const chipCalls = [];
let chipMode = 'refuse';
clientModule.apply({
  slots: {
    inject(name, cb) { equal('slots.inject name', name, 'conversation.input.dock'); cb(); },
    register(options, component) { registeredOptions = options; Component = component; return () => {}; }
  },
  get(name) {
    if (name !== 'sessions') return undefined;
    return {
      scope(sessionId) {
        if (chipMode === 'explode') throw new Error('no scope');
        return {
          bail(event, payload) {
            if (event !== 'slash/input-insert-reference') return undefined;
            chipCalls.push({ sessionId, payload });
            if (chipMode === 'accept') return true;
            return undefined;
          }
        };
      }
    };
  }
});
equal('dock registration options', registeredOptions, { name: 'conversation.input.dock', id: 'idea-bridge', order: 15 });
check('registration order 15 does not collide with shipped cells (todo/0, goal/10, queue/20)',
  ![0, 10, 20].includes(registeredOptions.order));

// ---- helpers ---------------------------------------------------------------
const messageFile = (id) => join(inboxDir, `${id}.json`);
const put = (payload) => writeFileSync(messageFile(payload.id), JSON.stringify(payload), { mode: 0o600 });
const fresh = (id, overrides = {}) => ({ ...fixture, id, createdAt: Date.now(), ...overrides });
const propsFor = (sessionId, cwd, actions) => ({
  sessionId,
  inputActions: actions,
  useSessions: (selector) => selector({ byId: { [sessionId]: { cwd } } }),
  // Real slot prop (`useInput: SnapshotSelectorHook<InputState>`); the client reads
  // `state.draft` only to decide whether to pad with a separating space.
  useInput: (selector) => selector({ draft: actions.state?.draft ?? '' })
});
/**
 * Model of the shipped `SessionInputShell.actions` face (v1.1 uses insert, not
 * setDraft): `captureInsertion()` maps to the caret or the current selection and
 * `insertText` applies a revision-guarded edit. `calls` records the product's
 * observable effect, `state.draft` is the resulting composer text.
 */
function scriptedActions(initial = {}) {
  const calls = [];
  const state = {
    draft: initial.draft ?? '',
    rev: 1,
    /** Simulated selection `[start, end]` in detect coordinates; null = caret at end. */
    selection: initial.selection ?? null,
    /** When false, `insertText` answers false like a phase/revision guard would. */
    accept: initial.accept ?? true
  };
  return {
    calls,
    state,
    captureInsertion() {
      const span = state.selection !== null
        ? { start: state.selection[0], end: state.selection[1] }
        : { start: state.draft.length, end: state.draft.length };
      return { ...span, draftRev: state.rev };
    },
    insertText(text, span) {
      if (state.accept !== true) {
        calls.push(['insertText-rejected', text]);
        return false;
      }
      if (span === undefined || span.draftRev !== state.rev) {
        calls.push(['insertText-stale', text]);
        return false;
      }
      state.draft = `${state.draft.slice(0, span.start)}${text}${state.draft.slice(span.end)}`;
      calls.push(['insertText', text]);
      return true;
    },
    submit() { calls.push(['submit']); }
  };
}
let counter = 100;
const nextId = () => `aaaaaaaa-0000-0000-0000-${String(counter++).padStart(12, '0')}`;

// ---- 1. happy path ---------------------------------------------------------
{
  const id = nextId();
  put(fresh(id));
  const actions = scriptedActions();
  const client = await mount(propsFor('session-1', fixture.projectPath, actions));
  await advance(0);
  equal('no fetch before the 300ms first-poll delay', fetchLog.length, 0);
  await advance(800);
  equal('first poll fires after the 800ms delay', fetchLog[0], 'GET /idea-bridge/pending');
  check('a 400ms poll interval is armed', [...timers.values()].some((t) => t.every === 400));
  equal('setDraft + submit happened once, with the contract text', actions.calls, [['insertText', fixture.text], ['submit']]);
  check('message file acknowledged and deleted', !existsSync(messageFile(id)));
  check('ack followed the draft write', fetchLog.includes('POST /idea-bridge/ack'), fetchLog.join(','));
  check('the instance claimed before writing the draft',
    fetchLog.includes('POST /idea-bridge/claim') && fetchLog.indexOf('POST /idea-bridge/claim') > fetchLog.indexOf('GET /idea-bridge/pending'),
    fetchLog.join(','));
  check('no .claim marker is left behind after ack', !existsSync(join(inboxDir, `${id}.claim`)));
  await client.unmount();
}

// ---- 2. no duplicate delivery of one id inside one client -----------------
{
  const id = nextId();
  put(fresh(id));
  const actions = scriptedActions();
  const client = await mount(propsFor('session-2', fixture.projectPath, actions));
  await advance(800);
  await advance(1500);
  await advance(1500);
  equal('a delivered id is not delivered again on later ticks', actions.calls.length, 2, JSON.stringify(actions.calls));
  await client.unmount();
}

// ---- 3. submit=false -------------------------------------------------------
{
  const id = nextId();
  put(fresh(id, { submit: false }));
  const actions = scriptedActions();
  const client = await mount(propsFor('session-3', fixture.projectPath, actions));
  await advance(800);
  equal('submit=false writes the draft without submitting', actions.calls, [['insertText', fixture.text]]);
  await client.unmount();
}

// ---- 4. cwd mismatch -------------------------------------------------------
{
  const id = nextId();
  put(fresh(id));
  const actions = scriptedActions();
  const client = await mount(propsFor('session-4', '/somewhere/else', actions));
  await advance(800);
  await advance(1500);
  equal('a message for another project is not written', actions.calls, []);
  check('a message for another project is not acked', existsSync(messageFile(id)));
  rmSync(messageFile(id), { force: true });
  await client.unmount();
}

// ---- 5. unknown cwd degrades to delivery ----------------------------------
{
  const id = nextId();
  put(fresh(id));
  const actions = scriptedActions();
  const client = await mount({ sessionId: 'session-5', inputActions: actions, useSessions: (sel) => sel({ byId: {} }) });
  await advance(800);
  equal('an unknown session cwd delivers', actions.calls, [['insertText', fixture.text], ['submit']]);
  await client.unmount();
}

// ---- 6. missing useSessions prop ------------------------------------------
{
  const id = nextId();
  put(fresh(id));
  const actions = scriptedActions();
  const client = await mount({ sessionId: 'session-6', inputActions: actions });
  await advance(800);
  equal('delivery still works when the slot omits useSessions', actions.calls, [['insertText', fixture.text], ['submit']]);
  await client.unmount();
}

// ---- 7. hidden page does not poll -----------------------------------------
{
  globalThis.document.visibilityState = 'hidden';
  const actions = scriptedActions();
  const client = await mount(propsFor('session-7', fixture.projectPath, actions));
  await advance(5000);
  equal('hidden document polls nothing', actions.calls.length, 0);
  globalThis.document.visibilityState = 'visible';
  await client.unmount();
}

// ---- 8. pending failure keeps the message ---------------------------------
{
  const id = nextId();
  put(fresh(id));
  const actions = scriptedActions();
  pendingFailures = 1;
  const client = await mount(propsFor('session-8', fixture.projectPath, actions));
  await advance(300); // exactly one tick: the first pending request fails
  equal('failed pending writes nothing', actions.calls, []);
  check('failed pending leaves the file', existsSync(messageFile(id)));
  await advance(1500);
  equal('next tick recovers after a pending failure', actions.calls, [['insertText', fixture.text], ['submit']]);
  await client.unmount();
}

// ---- 9. ack failure does not lose or duplicate ----------------------------
{
  const id = nextId();
  put(fresh(id));
  const actions = scriptedActions();
  ackFailures = 1;
  const client = await mount(propsFor('session-9', fixture.projectPath, actions));
  await advance(300); // exactly one tick: delivery succeeds, the ack fails
  equal('ack failure still writes the draft exactly once', actions.calls, [['insertText', fixture.text], ['submit']]);
  check('ack failure keeps the file for retry', existsSync(messageFile(id)));
  await advance(1500);
  check('next tick retries the ack and deletes the file', !existsSync(messageFile(id)));
  equal('the retried ack does not re-deliver', actions.calls.length, 2);
  await client.unmount();
}

// ---- 10. a throwing / rejecting insert is retried, not acked --------------
{
  const id = nextId();
  put(fresh(id));
  let attempts = 0;
  const actions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText() { attempts += 1; throw new Error('editor busy'); },
    submit() {}
  };
  const client = await mount(propsFor('session-10', fixture.projectPath, actions));
  await advance(800);
  await advance(1500);
  check('a throwing insertText is retried', attempts >= 2, `attempts=${attempts}`);
  check('a throwing insertText is not acked', existsSync(messageFile(id)));
  check('an undelivered claim stays held (marker kept for the retry)',
    existsSync(join(inboxDir, `${id}.claim`)));
  rmSync(messageFile(id), { force: true });
  rmSync(join(inboxDir, `${id}.claim`), { force: true });
  await client.unmount();
}

// ---- 10b. insertion never replaces what the user already typed ------------
{
  const id = nextId();
  put(fresh(id, { submit: false }));
  // The user is mid-sentence with a selection: the reference must go AFTER the
  // selection, leaving the typed text intact (contract §5.3).
  const actions = scriptedActions({ draft: '看看这个 ', selection: [0, 5] });
  const client = await mount(propsFor('session-10b', fixture.projectPath, actions));
  await advance(800);
  equal('the reference is inserted, never used to replace the draft',
    actions.calls, [['insertText', fixture.text]]);
  equal('existing draft text survives and the reference is appended after the selection',
    actions.state.draft, `看看这个 ${fixture.text}`);
  await client.unmount();
}

// ---- 10c. a leading space separates the reference from typed text ---------
{
  const id = nextId();
  put(fresh(id, { submit: false }));
  const actions = scriptedActions({ draft: '解释一下' });
  const client = await mount(propsFor('session-10c', fixture.projectPath, actions));
  await advance(800);
  equal('a separating space is added when the draft already has content',
    actions.calls, [['insertText', ' '], ['insertText', fixture.text]]);
  await client.unmount();
}

// ---- 10d. an empty draft gets no leading space ---------------------------
{
  const id = nextId();
  put(fresh(id, { submit: false }));
  const actions = scriptedActions({ draft: '' });
  const client = await mount(propsFor('session-10d', fixture.projectPath, actions));
  await advance(800);
  equal('an empty draft is filled without a leading space',
    actions.calls, [['insertText', fixture.text]]);
  await client.unmount();
}

// ---- 10e. a rejected edit (phase/revision guard) is retried, not acked ----
{
  const id = nextId();
  put(fresh(id, { submit: false }));
  let attempts = 0;
  const actions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText() { attempts += 1; return false; },
    submit() {}
  };
  const client = await mount(propsFor('session-10e', fixture.projectPath, actions));
  await advance(800);
  await advance(1500);
  check('a rejected insertText is retried on the next tick', attempts >= 2, `attempts=${attempts}`);
  check('a rejected insertText is not acked', existsSync(messageFile(id)));
  rmSync(messageFile(id), { force: true });
  rmSync(join(inboxDir, `${id}.claim`), { force: true });
  await client.unmount();
}

// ---- 11. two clients (two tabs) on the same session -----------------------
{
  const id = nextId();
  put(fresh(id));
  const tabA = scriptedActions();
  const tabB = scriptedActions();
  const clientA = await mount(propsFor('session-tab', fixture.projectPath, tabA));
  const clientB = await mount(propsFor('session-tab', fixture.projectPath, tabB));
  await advance(800);
  equal('exactly one of the two tabs delivers (v1.1 claim single-flight)',
    [tabA.calls.length > 0, tabB.calls.length > 0].filter(Boolean).length, 1,
    `tabA=${JSON.stringify(tabA.calls)} tabB=${JSON.stringify(tabB.calls)}`);
  equal('the winning tab wrote draft + submit once', Math.max(tabA.calls.length, tabB.calls.length), 2);
  await clientA.unmount(); await clientB.unmount();
  rmSync(messageFile(id), { force: true });
}

// ---- 12. two sessions sharing one project root ---------------------------
{
  const id = nextId();
  put(fresh(id));
  const sessA = scriptedActions();
  const sessB = scriptedActions();
  const clientA = await mount(propsFor('session-root-a', fixture.projectPath, sessA));
  const clientB = await mount(propsFor('session-root-b', fixture.projectPath, sessB));
  await advance(800);
  equal('exactly one of the two same-cwd sessions delivers (v1.1 claim single-flight)',
    [sessA.calls.length > 0, sessB.calls.length > 0].filter(Boolean).length, 1,
    `sessA=${JSON.stringify(sessA.calls)} sessB=${JSON.stringify(sessB.calls)}`);
  await clientA.unmount(); await clientB.unmount();
  rmSync(messageFile(id), { force: true });
}

// ---- 12b. a real reference chip is preferred over flat text ---------------
{
  const id = nextId();
  put(fresh(id, { submit: false }));
  const actions = scriptedActions({ draft: '解释一下' });
  chipMode = 'accept';
  chipCalls.length = 0;
  const client = await mount(propsFor('session-chip', fixture.projectPath, actions));
  await advance(800);
  equal('the pad is inserted before the chip (mention needs a boundary)',
    actions.calls[0], ['insertText', ' ']);
  equal('one chip insertion was requested', chipCalls.length, 1);
  const expectedRange = fixture.lineEnd > fixture.lineStart
    ? `#L${fixture.lineStart}-${fixture.lineEnd}`
    : `#L${fixture.lineStart}`;
  equal('the chip reference is the clean file mention (clickable, no #L)',
    chipCalls[0].payload.reference,
    {
      source: 'reference',
      ref: `@${fixture.file}`,
      label: 'Bar.kt',
      appearance: 'file',
      clipboardText: `@${fixture.file}`
    });
  check('ref stays resolvable: no #L suffix',
    !chipCalls[0].payload.reference.ref.includes('#L'));
  // A chip carries no line range, so the range must follow it as text — that is
  // the only form the agent actually reads.
  equal('the line range follows the chip as text',
    actions.calls, [['insertText', ' '], ['insertText', expectedRange]]);
  check('the chip is inserted at the collapsed caret, never over a selection',
    chipCalls[0].payload.span.start === chipCalls[0].payload.span.end);
  check('the file itself is delivered as a chip, not as flat text',
    !actions.calls.some((call) => call[0] === 'insertText' && call[1].includes('@')), JSON.stringify(actions.calls));
  check('chip delivery is acknowledged', !existsSync(messageFile(id)));
  await client.unmount();
  chipMode = 'refuse';
}

// ---- 12c. a refusing / exploding chip channel falls back to flat text -----
for (const mode of ['refuse', 'explode']) {
  const id = nextId();
  put(fresh(id, { submit: false }));
  const actions = scriptedActions();
  chipMode = mode;
  const client = await mount(propsFor(`session-chip-${mode}`, fixture.projectPath, actions));
  await advance(800);
  equal(`a ${mode}d chip channel still delivers flat text`,
    actions.calls, [['insertText', fixture.text]]);
  check(`a ${mode}d chip channel is still acknowledged`, !existsSync(messageFile(id)));
  await client.unmount();
  chipMode = 'refuse';
}

// ---- 12d. a throwing submit must never re-insert the reference ------------
{
  const id = nextId();
  put(fresh(id, { submit: true }));
  let inserts = 0;
  const actions = {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText(text) { inserts += 1; return true; },
    submit() { throw new Error('submit exploded'); }
  };
  const client = await mount(propsFor('session-12d', fixture.projectPath, actions));
  await advance(300);
  await advance(400);
  await advance(400);
  equal('exactly one insertion even though submit throws', inserts, 1);
  check('the message is still acknowledged (content is in the composer)', !existsSync(messageFile(id)));
  await client.unmount();
}

// ---- 13. cleanup -----------------------------------------------------------
const pollTimersLeft = [...timers.values()].filter((t) => t.every === 400 || t.every === undefined);
equal('unmount clears every poll timer (host sweeper heartbeat exempt)', pollTimersLeft.length, 0);

console.log(`\n# fetch log (tail): ${fetchLog.slice(-6).join(', ')}`);
console.log(`# inbox left: ${readdirSync(inboxDir).join(', ') || '(empty)'}`);
console.log(`\n# summary: ${passes} passed, ${failures} failed, ${defects.length} product defect(s)`);
process.exit(failures === 0 ? 0 : 1);
