/**
 * Verification aid (not production code): runs the host half with the current
 * $DSH_HOME and reports where it actually put the handshake file, so the DSH
 * side's own path resolution can be compared with the IDEA side's.
 *
 * Usage: DSH_HOME=<value> node docs/verification/tools/host-home-probe.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('../../../', import.meta.url).pathname;
const configured = process.env.DSH_HOME ?? '';
const candidates = [
  configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : resolve(configured || join(homedir(), '.dsh')),
  resolve(configured || join(homedir(), '.dsh')),
  join(homedir(), '.dsh')
];

const mod = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'index.js')).href);
await mod.apply({
  logger: { warn: () => {}, error: () => {}, info: () => {} },
  connection: { requestRejection: () => undefined },
  webServer: { register: () => () => {} },
  effect: async (fn) => await fn()
});

console.log('DSH_HOME(env) =', configured === '' ? '(unset)' : configured);
for (const base of candidates) {
  const file = join(base, 'idea-bridge', 'location.json');
  if (!existsSync(file)) continue;
  console.log('handshake file =', file);
  console.log('host inboxDir  =', JSON.parse(readFileSync(file, 'utf8')).inboxDir);
  break;
}
