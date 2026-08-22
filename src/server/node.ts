/**
 * Node HTTP server around the gateway.
 *
 * Binds 127.0.0.1 by default and refuses to start without at least one auth
 * token. Both are deliberate: this process holds every provider key you own,
 * and an unauthenticated LLM relay on a shared network is somebody else's
 * free inference budget. Put it behind `tailscale serve` or a reverse proxy
 * rather than binding 0.0.0.0.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stdout } from 'node:process';
import { Readable } from 'node:stream';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleRequest, type KeyStore } from '../gateway.js';
import { InferenceMesh } from '../mesh.js';
import { QuotaLedger, type LedgerRecord, type LedgerStorage } from '../ledger.js';
import { registryFrom } from '../config.js';
import { EMBEDDED_REGISTRY } from '../embedded-registry.js';
import type { ProviderConfig } from '../types.js';
import { mergeEnv } from '../setup.js';

/** Ledger persistence via an atomic file write, so a crash cannot truncate it. */
export class FileStorage implements LedgerStorage {
  constructor(private readonly path: string) {}

  async load(): Promise<Record<string, LedgerRecord>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, LedgerRecord>;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return {};
      // A corrupt ledger must not take the gateway down: losing today's counters
      // costs some quota accuracy, refusing to boot costs every request.
      console.error(`[inferencemesh] ledger unreadable (${String(err)}); starting empty`);
      return {};
    }
  }

  async save(state: Record<string, LedgerRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, this.path);
  }
}

/**
 * Locate the bundled registry by walking up from this module.
 *
 * Hard-coding the number of `..` segments breaks the moment the build layout
 * changes — which it already did once, silently, because nothing imports this
 * path at compile time.
 */
/**
 * Keys added through the setup UI, kept in the user's own volume.
 *
 * They are written to a file the process can read back and never exposed
 * through HTTP. On a self-hosted install this is the whole privacy story:
 * there is no server-side component anywhere else, so a key reaches exactly
 * two places — this file, and the provider it belongs to.
 */
export class FileKeyStore implements KeyStore {
  private extra: Record<string, string> = {};

  constructor(
    private readonly keysPath: string,
    private readonly registryPath: string,
    private readonly baseEnv: NodeJS.ProcessEnv,
    private readonly registryPathExplicit = false,
  ) {}

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.keysPath, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) this.extra[m[1] as string] = m[2] as string;
      }
    } catch {
      /* no keys saved yet */
    }
  }

  env(): Record<string, string | undefined> {
    return { ...this.baseEnv, ...this.extra };
  }

  /**
   * Saves run one at a time.
   *
   * Each one is a read-modify-write of the same file through a temp file with
   * the same name. Two overlapping saves — two setup pages, or one person
   * clicking twice — interleave into: both read the old contents, both write
   * the temp file, and the second rename wins with the first key missing from
   * it. The page has already said "OK" by then, and the key is gone.
   */
  private writes: Promise<void> = Promise.resolve();

  async save(entries: Record<string, string>): Promise<void> {
    const next = this.writes.then(
      () => this.write(entries),
      () => this.write(entries),
    );
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async write(entries: Record<string, string>): Promise<void> {
    this.extra = { ...this.extra, ...entries };
    let existing = '';
    try {
      existing = await readFile(this.keysPath, 'utf8');
    } catch {
      /* first key */
    }
    await mkdir(dirname(this.keysPath), { recursive: true });
    // A unique name, so a second process writing the same store cannot leave
    // this one renaming a file it did not finish writing.
    const tmp = `${this.keysPath}.${process.pid}.${(this.tmpSeq += 1)}.tmp`;
    await writeFile(tmp, mergeEnv(existing, entries), { mode: 0o600 });
    await rename(tmp, this.keysPath);
  }

  private tmpSeq = 0;

  providerConfigs(): ProviderConfig[] {
    return this.configs;
  }

  private configs: ProviderConfig[] = [];

  async reload(): Promise<ReturnType<typeof registryFrom>> {
    const raw = (await loadRegistryFile(this.registryPath, this.registryPathExplicit)) as {
      providers: ProviderConfig[];
    };
    this.configs = raw.providers;
    return registryFrom(raw, { env: this.env() });
  }
}

/**
 * Read the registry from `path`, falling back to the copy compiled in.
 *
 * The fallback is what makes a single-file build work at all: there is no JSON
 * on disk beside a bundled script or an embedded executable.
 *
 * `explicit` marks a path the user chose with INFERENCEMESH_REGISTRY. Falling
 * back for that one silently answers a typo'd path by serving a different
 * registry than the one asked for — the config is ignored and everything looks
 * fine, which is the worst way for a setting to fail.
 */
export async function loadRegistryFile(path: string | null, explicit = false): Promise<unknown> {
  if (path) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && explicit) {
        throw new Error(`INFERENCEMESH_REGISTRY points at '${path}', which does not exist`);
      }
      if (code !== 'ENOENT') throw err;
    }
  }
  return EMBEDDED_REGISTRY;
}

function defaultRegistryPath(): string {
  // `import.meta.url` does not survive a CommonJS bundle, and a single
  // executable has no meaningful module path at all. Both cases fall through
  // to the embedded registry.
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return '';
  }
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'providers.default.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not an error any more: a bundled or embedded build has no such file and
  // uses the compiled-in registry instead.
  return '';
}

async function toFetchRequest(
  req: IncomingMessage,
  origin: string,
  signal: AbortSignal,
): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    // Without this the gateway's `req.signal` is a signal that never fires, so
    // a caller hanging up is invisible all the way down to the provider fetch.
    signal,
    ...(hasBody && chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

export async function writeFetchResponse(res: ServerResponse, out: Response): Promise<void> {
  const headers: Record<string, string> = {};
  out.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(out.status, headers);
  if (!out.body) {
    res.end();
    return;
  }
  const node = Readable.fromWeb(out.body as Parameters<typeof Readable.fromWeb>[0]);
  /**
   * `pipe` unpipes when the destination closes, but it does not destroy the
   * source. A client that hangs up mid-stream therefore leaves the web stream
   * un-cancelled, which holds the provider's concurrency slot and its socket
   * for the life of the process. Measured: one abandoned SSE response kept a
   * `maxConcurrent: 1` provider unusable indefinitely, while every unit test
   * passed — the tests cancel the stream, and nothing here ever did.
   */
  // Destroyed without a reason on purpose: `destroy(err)` emits 'error', and
  // once `pipe` has unpiped there is no listener left, so the tidy-up would
  // take the whole process down. There is nobody to report the error to
  // anyway — the client is the thing that left.
  node.on('error', () => {});
  res.on('close', () => {
    if (!node.readableEnded) node.destroy();
  });
  node.pipe(res);
  await new Promise<void>((done) => res.on('close', () => done()));
}

export interface ServerConfig {
  port: number;
  host: string;
  tokens: Set<string>;
  registryPath: string;
  /** True when INFERENCEMESH_REGISTRY named it, rather than the path search. */
  registryPathExplicit: boolean;
  ledgerPath: string;
  keysPath: string;
  allowedOrigins: string[];
  publicHealth: boolean;
  /**
   * How long a request queues behind a provider that is already at its
   * `maxConcurrent`, and only once every candidate is busy. 0 fails instead.
   */
  concurrencyWaitMs: number;
}

/**
 * Read a non-negative integer from the environment.
 *
 * `Number(env['X'] ?? 42)` looks equivalent and is not: an env var that is
 * *set but empty* — which is what `FOO=` in a .env file produces — parses as 0
 * rather than falling back, so a blank line silently means "port 0" or "never
 * queue". An unparseable value is refused outright rather than defaulted,
 * because a typo that quietly reverts to the default is the kind of setting
 * you only discover is wrong from the behaviour it was supposed to change.
 */
function intFromEnv(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`expected a non-negative integer, got '${trimmed}'`);
  }
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const tokens = new Set(
    (env['INFERENCEMESH_TOKENS'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  );
  return {
    port: intFromEnv(env['INFERENCEMESH_PORT'], 8910),
    host: env['INFERENCEMESH_HOST'] ?? '127.0.0.1',
    tokens,
    registryPath: env['INFERENCEMESH_REGISTRY'] ?? defaultRegistryPath(),
    registryPathExplicit: Boolean(env['INFERENCEMESH_REGISTRY']),
    ledgerPath: env['INFERENCEMESH_LEDGER'] ?? resolve(process.cwd(), '.inferencemesh/ledger.json'),
    keysPath: env['INFERENCEMESH_KEYS'] ?? resolve(process.cwd(), '.inferencemesh/keys.env'),
    allowedOrigins: (env['INFERENCEMESH_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    publicHealth: env['INFERENCEMESH_PUBLIC_HEALTH'] === '1',
    concurrencyWaitMs: intFromEnv(env['INFERENCEMESH_CONCURRENCY_WAIT_MS'], 30_000),
  };
}

export async function buildMesh(cfg: ServerConfig): Promise<{ mesh: InferenceMesh; keyStore: FileKeyStore }> {
  const keyStore = new FileKeyStore(cfg.keysPath, cfg.registryPath, process.env, cfg.registryPathExplicit);
  await keyStore.init();
  const registry = await keyStore.reload();
  for (const w of registry.warnings) {
    console.warn(`[inferencemesh] provider '${w.providerId}' skipped: ${w.reason}`);
  }
  // No longer fatal: with zero keys the keyless providers still answer, and the
  // setup page exists precisely to be opened when nothing is configured yet.
  if (registry.candidates.length === 0) {
    console.warn(
      '[inferencemesh] no usable providers yet — open /setup to add a key.',
    );
  }
  return {
    mesh: new InferenceMesh({
      registry,
      ledger: new QuotaLedger(new FileStorage(cfg.ledgerPath)),
      concurrencyWaitMs: cfg.concurrencyWaitMs,
    }),
    keyStore,
  };
}

export async function main(): Promise<void> {
  const cfg = configFromEnv();

  if (cfg.tokens.size === 0) {
    console.error(
      'INFERENCEMESH_TOKENS is empty. Refusing to start an unauthenticated LLM relay.\n' +
        "  generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
    process.exit(1);
  }
  if (cfg.host === '0.0.0.0' && process.env['INFERENCEMESH_ALLOW_ANY_HOST'] !== '1') {
    console.error(
      'Refusing to bind 0.0.0.0. Bind 127.0.0.1 and put a reverse proxy or `tailscale serve`\n' +
        '  in front of it, or set INFERENCEMESH_ALLOW_ANY_HOST=1 if you really mean it.',
    );
    process.exit(1);
  }

  const { mesh, keyStore } = await buildMesh(cfg);
  const server = createServer((req, res) => {
    void (async () => {
      // Aborted when the socket closes before the response finished, so an
      // in-flight provider call is cancelled instead of running on unwatched.
      const inbound = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) inbound.abort(new Error('client disconnected'));
      });
      try {
        const request = await toFetchRequest(
          req,
          `http://${cfg.host}:${cfg.port}`,
          inbound.signal,
        );
        const out = await handleRequest(request, {
          mesh,
          tokens: cfg.tokens,
          allowedOrigins: cfg.allowedOrigins,
          publicHealth: cfg.publicHealth,
          keyStore,
        });
        await writeFetchResponse(res, out);
      } catch (err) {
        console.error('[inferencemesh]', err);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'internal error', type: 'internal_error' } }));
      }
    })();
  });

  // The most common operational failure there is, and it used to arrive as a
  // raw stack trace with the one thing the operator needs — the name of the
  // variable that sets the port — nowhere in it.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[inferencemesh] port ${cfg.port} is already in use. ` +
          'Set INFERENCEMESH_PORT to a free one, or stop what is holding it.',
      );
    } else if (err.code === 'EACCES') {
      console.error(
        `[inferencemesh] not allowed to bind ${cfg.host}:${cfg.port}. ` +
          'Ports below 1024 need root — run on a high port and put a proxy in front.',
      );
    } else {
      console.error(`[inferencemesh] could not listen on ${cfg.host}:${cfg.port}: ${err.message}`);
    }
    process.exitCode = 1;
    server.close();
  });

  server.listen(cfg.port, cfg.host, () => {
    const first = [...cfg.tokens][0] as string;
    console.log(
      `[inferencemesh] listening on http://${cfg.host}:${cfg.port} ` +
        `— ${mesh.registry.candidates.length} candidates from ${mesh.registry.providers.length} provider(s)`,
    );
    // The token rides in the fragment: it is never sent to the server and never
    // reaches an access log, unlike a query string.
    //
    // It is printed only to a terminal. Under systemd this line goes to the
    // journal, where it outlives the process and is readable by more than the
    // person who started it — and this token opens the endpoint that adds
    // provider keys. Someone watching a terminal wants the clickable link;
    // a log file must not become the place the credential lives.
    if (stdout.isTTY) {
      console.log(`[inferencemesh] add keys here: http://127.0.0.1:${cfg.port}/setup#${first}`);
    } else {
      console.log(
        `[inferencemesh] add keys at http://127.0.0.1:${cfg.port}/setup#<token> ` +
          '— token not printed to a non-terminal, see INFERENCEMESH_TOKENS',
      );
    }
  });

  const shutdown = () => {
    server.close(() => {
      void mesh.ledger.flush().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Only auto-start when this file *is* the program.
 *
 * `import.meta.url` is meaningless in a CommonJS bundle and throws there, so
 * the check is guarded rather than assumed — an unguarded call crashes the
 * bundled build at import time, before any command has a chance to run.
 */
function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main();
}
