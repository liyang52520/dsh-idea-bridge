/**
 * Host half of the IDEA bridge bundle.
 *
 * It owns three things and nothing else:
 *
 * 1. the inbox directory `$DSH_HOME/idea-bridge/inbox` that the IDEA plugin
 *    writes message files into (see `docs/idea-bridge-contract.md` §3),
 * 2. the handshake file `$DSH_HOME/idea-bridge/location.json` that tells the
 *    IDEA plugin which directory to write into (contract §2),
 * 3. the three routes `GET /idea-bridge/pending`, `POST /idea-bridge/claim`
 *    and `POST /idea-bridge/ack` on the composition's `webServer`
 *    (contract §4, v1.1).
 *
 * Only first-party extension points are used. The route/registration shape,
 * the `connection.requestRejection` gate, the bounded body reader, and the
 * JSON/method responses mirror `@deepseek-ai/dsh-host-open-in-app`
 * (`lib/index.js:1171-1203` for the helpers, `:1263-1282` for the gate and
 * the `ctx.effect(() => ctx.webServer.register(...))` pattern). The
 * `webServer.register` contract itself is
 * `@deepseek-ai/dsh-host-webserver` (`lib/index.js:320-333`: exact/prefix
 * tables, duplicate `(kind, path)` throws, the returned function disposes).
 * The exposed surface is `@deepseek-ai/dsh-harness`'s `connection` service:
 * `requestRejection(request)` returns `undefined` to admit or the HTTP
 * status to reject with (`@deepseek-ai/dsh-client-connection/lib/index.js:736-750`).
 *
 * It never reads credentials, never calls `/api/*`, never starts a process,
 * and never writes a file it does not own.
 *
 * @module @local/dsh-idea-bridge
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Cordis function-plugin name. */
export const name = "idea-bridge";
/** The route carrier and the trust fence every route asks first. */
export const inject = ["webServer", "connection"];

/** Directory under `$DSH_HOME` owned by this bundle. */
const BRIDGE_DIR_NAME = "idea-bridge";
/** The inbox directory the IDEA plugin writes message files into. */
const INBOX_DIR_NAME = "inbox";
/** The handshake file naming the inbox and the routes. */
const LOCATION_FILE_NAME = "location.json";
/** Handshake schema version, frozen by the contract. */
const LOCATION_VERSION = 1;
/** Inbox listing route (contract §4). */
const PENDING_PATH = "/idea-bridge/pending";
/** Atomic single-flight route (contract §4, v1.1). */
const CLAIM_PATH = "/idea-bridge/claim";
/** Consumption route (contract §4). */
const ACK_PATH = "/idea-bridge/ack";
/** Message files older than this are dropped, in the listing and by the sweeper (contract §4). */
const MESSAGE_MAX_AGE_MS = 10 * 60 * 1000;
/** At most this many items per listing, oldest first (contract §4). */
const MAX_ITEMS = 20;
/** Claim/ack bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;
/** Expired-file sweep and handshake heartbeat period. */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Atomic-write attempts; the second exists only for an astronomically unlucky name collision. */
const ATOMIC_WRITE_ATTEMPTS = 2;
/** Careful message ids only: no separators, so an id can never escape the inbox. */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** Default harness home directory name, mirroring `@deepseek-ai/dsh-home-paths`. */
const DSH_HOME_DIR_NAME = ".dsh";

/**
 * Resolve the harness home exactly as `@deepseek-ai/dsh-home-paths` does
 * (`lib/index.js:83-86` and `:109-111`): `$DSH_HOME` when it is set to
 * anything but whitespace, otherwise `~/.dsh`, always normalized absolute.
 * A `~`/`~/`/`~\` prefix is expanded against the OS home (`:70-74`).
 * @returns the absolute harness home path.
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  const base = configured !== undefined && configured.trim().length > 0 ? configured : join(homedir(), DSH_HOME_DIR_NAME);
  if (base === "~") return homedir();
  if (base.startsWith("~/") || base.startsWith("~\\")) return resolve(join(homedir(), base.slice(2)));
  return resolve(base);
}

/** Create one owned directory (and its parents) with owner-only permissions. */
async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/** Surface a non-fatal failure through the composition logger, never through stdout. */
function warn(ctx, error) {
  const logger = ctx.logger;
  if (logger === undefined || typeof logger.warn !== "function") return;
  logger.warn(error instanceof Error ? error : new Error(String(error)));
}

/** JSON response (no-store: inbox contents and ack outcomes are live facts). */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader("allow", allow);
  res.end();
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Write `text` to `target` atomically with 0600: a unique temporary file in
 * the same directory, then a rename over the target, so a reader never sees a
 * half-written handshake file (contract §2, §3).
 *
 * The temporary name carries a `randomUUID`. A name built from
 * `pid` + `Date.now()` is NOT unique: the 60s heartbeat sweep and a plugin
 * reload (or two concurrent `apply` calls) can land in the same millisecond
 * in one process, and then one writer hits `EEXIST` on the temporary while the
 * other hits `ENOENT` on the rename because its temporary was already renamed
 * away — which used to abort `apply()` before any route was registered
 * (verification defect D1). The retry covers the remaining theoretical
 * collision between two random names.
 */
async function writeFileAtomic(target, text) {
  let failure;
  for (let attempt = 0; attempt < ATOMIC_WRITE_ATTEMPTS; attempt += 1) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      failure = error;
      continue;
    }
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  throw failure;
}

/** The handshake payload, field for field as in contract §2. */
function locationPayload(inboxDir) {
  return {
    version: LOCATION_VERSION,
    inboxDir,
    endpoint: PENDING_PATH,
    // Absent on a v1.0 host: the client half treats this field as the
    // "v1.1 capable" signal and degrades to v1.0 delivery without it
    // (contract §2 / §5.4, verification defect D6).
    claimEndpoint: CLAIM_PATH,
    ackEndpoint: ACK_PATH,
    pid: process.pid,
    updatedAt: Date.now()
  };
}

/** The exact bytes one handshake write produces; kept so disposal can recognise its own file. */
function locationText(inboxDir) {
  return `${JSON.stringify(locationPayload(inboxDir), null, 2)}\n`;
}

/**
 * Remove the handshake file on disposal, but only while it is byte for byte
 * the file this activation last wrote: a restarted process, a newer instance,
 * or a reloaded copy of this plugin writes different bytes (different `pid`
 * or `updatedAt`) and keeps its own handshake. A `pid` comparison alone is not
 * enough — a cordis reload happens inside one process, so the pid matches
 * while the handshake belongs to the new activation.
 */
async function removeOwnLocation(ctx, locationPath, expected) {
  try {
    if (expected === undefined) return;
    if ((await readFile(locationPath, "utf8")) !== expected) return;
    await rm(locationPath, { force: true });
  } catch (error) {
    warn(ctx, error);
  }
}

/** Whether a parsed file carries the minimum the contract promises (id, createdAt, text). */
function isMessage(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.text === "string"
  );
}

/**
 * One inbox path for a careful message id, or `undefined` when the id could
 * escape the directory. Both the message file and its claim marker go through
 * this guard, so neither route can ever be steered outside the inbox.
 */
function inboxPath(inboxDir, id, suffix) {
  if (!MESSAGE_ID_PATTERN.test(id) || id.includes("..")) return undefined;
  return join(inboxDir, `${id}${suffix}`);
}

/** `<inboxDir>/<id>.json`: the message the IDEA plugin wrote (contract §3). */
function messagePath(inboxDir, id) {
  return inboxPath(inboxDir, id, ".json");
}

/** `<inboxDir>/<id>.claim`: this bundle's single-flight marker (contract §4, v1.1). */
function claimPath(inboxDir, id) {
  return inboxPath(inboxDir, id, ".claim");
}

/**
 * List the inbox without consuming it: `createdAt` ascending, live files only,
 * at most {@link MAX_ITEMS} entries. Each entry is the file's own JSON object,
 * passed through unchanged so every contract field survives verbatim.
 */
async function readPending(inboxDir) {
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(inboxDir, entry.name), "utf8"));
    } catch {
      continue;
    }
    if (!isMessage(parsed)) continue;
    if (now - parsed.createdAt > MESSAGE_MAX_AGE_MS) continue;
    items.push(parsed);
  }
  items.sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return items.slice(0, MAX_ITEMS);
}

/**
 * Claim ids for this UI instance, atomically and exactly once across every
 * instance (contract §4, v1.1): `O_CREAT|O_EXCL` on `<inboxDir>/<id>.claim`.
 * The first writer wins; a claim marker that already exists (another tab,
 * another window, another DSH process, or this instance's own earlier claim)
 * yields no id in the result, so nothing is ever delivered twice.
 *
 * An id whose message file is already gone is not claimable: there would be
 * nothing to deliver and the marker would be garbage. A request that cannot
 * even create the inbox claims nothing — the caller retries on its next poll.
 */
async function claimMessages(ctx, inboxDir, ids) {
  const claimed = [];
  try {
    await ensureDir(inboxDir);
  } catch (error) {
    warn(ctx, error);
    return claimed;
  }
  const seen = new Set();
  for (const id of ids) {
    const message = messagePath(inboxDir, id);
    const marker = claimPath(inboxDir, id);
    if (message === undefined || marker === undefined || seen.has(id)) continue;
    seen.add(id);
    try {
      await stat(message);
    } catch {
      continue;
    }
    try {
      await writeFile(marker, `${process.pid}\n${Date.now()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") warn(ctx, error);
      continue;
    }
    claimed.push(id);
  }
  return claimed;
}

/**
 * Delete the named messages and their claim markers, idempotently: a missing
 * file is not an error, and an id with no file left counts as nothing removed
 * (contract §4). Returns the number of ids that had at least one file removed.
 */
async function removeMessages(ctx, inboxDir, ids) {
  let removed = 0;
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    let deleted = false;
    for (const target of [messagePath(inboxDir, id), claimPath(inboxDir, id)]) {
      if (target === undefined) continue;
      try {
        await stat(target);
      } catch {
        continue;
      }
      try {
        await rm(target, { force: true });
        deleted = true;
      } catch (error) {
        warn(ctx, error);
      }
    }
    if (deleted) removed += 1;
  }
  return removed;
}

/**
 * Drop inbox files past {@link MESSAGE_MAX_AGE_MS} and refresh the handshake
 * heartbeat. Both untaken messages (`.json`) and claim markers (`.claim`) are
 * recycled by mtime, so a client that claimed a message and then crashed can
 * never wedge it forever (contract §4, v1.1). Files this process cannot delete
 * (permissions, races) are logged and retried on the next sweep.
 */
async function sweep(ctx, inboxDir, writeLocation) {
  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch (error) {
    warn(ctx, error);
    entries = [];
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json") && !entry.name.endsWith(".claim")) continue;
    const target = join(inboxDir, entry.name);
    try {
      const info = await stat(target);
      if (now - info.mtimeMs > MESSAGE_MAX_AGE_MS) await rm(target, { force: true });
    } catch (error) {
      warn(ctx, error);
    }
  }
  try {
    await writeLocation();
  } catch (error) {
    warn(ctx, error);
  }
}

/**
 * Host half entry point: create the handshake file and the inbox, keep the
 * inbox swept, and register the three routes. Everything is registered through
 * `ctx.effect`, so unloading the bundle disposes the routes, stops the
 * sweeper, and removes this activation's handshake file.
 *
 * Registering the routes never depends on the filesystem: a missing or
 * unwritable inbox is logged and the routes still come up, because a route
 * that answers `{"items":[]}` is diagnosable while a bundle that failed to
 * load is indistinguishable from one that was never installed (verification
 * observation O2). The IDEA side also keeps writing to its own default inbox
 * path, so the bridge recovers as soon as the directory becomes writable.
 *
 * @param ctx - cordis context carrying the injected `webServer` and `connection` services.
 */
export async function apply(ctx) {
  const home = resolveDshHome();
  const bridgeDir = join(home, BRIDGE_DIR_NAME);
  const inboxDir = join(bridgeDir, INBOX_DIR_NAME);
  const locationPath = join(bridgeDir, LOCATION_FILE_NAME);
  /** The exact handshake bytes this activation last wrote; `undefined` until one write succeeds. */
  let lastLocation;

  /** (Re)write the handshake, refreshing `updatedAt` as the liveness heartbeat. */
  const writeLocation = async () => {
    lastLocation = locationText(inboxDir);
    await writeFileAtomic(locationPath, lastLocation);
  };

  try {
    await ctx.effect(
      async () => {
        let timer;
        try {
          await ensureDir(bridgeDir);
          await ensureDir(inboxDir);
          await writeLocation();
          timer = setInterval(() => {
            sweep(ctx, inboxDir, writeLocation).catch((error) => {
              warn(ctx, error);
            });
          }, SWEEP_INTERVAL_MS);
          if (typeof timer.unref === "function") timer.unref();
        } catch (error) {
          warn(ctx, error);
        }
        return async () => {
          if (timer !== undefined) clearInterval(timer);
          await removeOwnLocation(ctx, locationPath, lastLocation);
        };
      },
      "idea-bridge: handshake file, inbox, and sweeper"
    );
  } catch (error) {
    warn(ctx, error);
  }

  /** Ask the composition's trust fence first: Host/Origin fence plus browser-session auth. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  /**
   * Read and validate a `{"ids":[...]}` body. Returns the ids, or `undefined`
   * after answering 400/413 itself.
   */
  const readIds = async (req, res) => {
    let text;
    try {
      text = await readBoundedBody(req);
    } catch {
      sendJson(res, 400, { code: "bad-request", message: "request body unreadable" });
      return undefined;
    }
    if (text === null) {
      sendJson(res, 413, { code: "payload-too-large", message: "request body is too large" });
      return undefined;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      sendJson(res, 400, { code: "bad-request", message: 'request body must be JSON with a string array "ids"' });
      return undefined;
    }
    if (typeof body !== "object" || body === null || !Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
      sendJson(res, 400, { code: "bad-request", message: 'request body must be JSON with a string array "ids"' });
      return undefined;
    }
    return body.ids;
  };

  await ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: PENDING_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== "GET") {
            sendMethodNotAllowed(res, "GET");
            return;
          }
          sendJson(res, 200, { items: await readPending(inboxDir) });
        }
      }),
    `idea-bridge: GET ${PENDING_PATH}`
  );

  await ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: CLAIM_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== "POST") {
            sendMethodNotAllowed(res, "POST");
            return;
          }
          const ids = await readIds(req, res);
          if (ids === undefined) return;
          sendJson(res, 200, { claimed: await claimMessages(ctx, inboxDir, ids) });
        }
      }),
    `idea-bridge: POST ${CLAIM_PATH}`
  );

  await ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ACK_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== "POST") {
            sendMethodNotAllowed(res, "POST");
            return;
          }
          const ids = await readIds(req, res);
          if (ids === undefined) return;
          sendJson(res, 200, { ok: true, removed: await removeMessages(ctx, inboxDir, ids) });
        }
      }),
    `idea-bridge: POST ${ACK_PATH}`
  );
}
