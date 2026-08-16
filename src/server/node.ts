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

  async save(entries: Record<string, string>): Promise<void> {
    this.extra = { ...this.extra, ...entries };
    let existing = '';
    try {
      existing = await readFile(this.keysPath, 'utf8');
    } catch {
      /* first key */
    }
    await mkdir(dirname(this.keysPath), { recursive: true });
    const tmp = `${this.keysPath}.tmp`;
    await writeFile(tmp, mergeEnv(existing, entries), { mode: 0o600 });
    await rename(tmp, this.keysPath);
  }

  providerConfigs(): ProviderConfig[] {
    return this.configs;
  }

  private configs: ProviderConfig[] = [];

  async reload(): Promise<ReturnType<typeof registryFrom>> {
    const raw = (await loadRegistryFile(this.registryPath)) as { providers: ProviderConfig[] };
    this.configs = raw.providers;
    return registryFrom(raw, { env: this.env() });
  }
}

/**
 * Read the registry from `path`, falling back to the copy compiled in.
 *
 * The fallback is what makes a single-file build work at all: there is no
 * JSON on disk beside a bundled script or an embedded executable.
 */
export async function loadRegistryFile(path: string | null): Promise<unknown> {
  if (path) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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

async function toFetchRequest(req: IncomingMessage, origin: string): Promise<Request> {
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
    ...(hasBody && chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function writeFetchResponse(res: ServerResponse, out: Response): Promise<void> {
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
  node.pipe(res);
  await new Promise<void>((done) => res.on('close', () => done()));
}

export interface ServerConfig {
  port: number;
  host: string;
  tokens: Set<string>;
  registryPath: string;
  ledgerPath: string;
  keysPath: string;
  allowedOrigins: string[];
  publicHealth: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const tokens = new Set(
    (env['INFERENCEMESH_TOKENS'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  );
  return {
    port: Number(env['INFERENCEMESH_PORT'] ?? 8910),
    host: env['INFERENCEMESH_HOST'] ?? '127.0.0.1',
    tokens,
    registryPath: env['INFERENCEMESH_REGISTRY'] ?? defaultRegistryPath(),
    ledgerPath: env['INFERENCEMESH_LEDGER'] ?? resolve(process.cwd(), '.inferencemesh/ledger.json'),
    keysPath: env['INFERENCEMESH_KEYS'] ?? resolve(process.cwd(), '.inferencemesh/keys.env'),
    allowedOrigins: (env['INFERENCEMESH_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    publicHealth: env['INFERENCEMESH_PUBLIC_HEALTH'] === '1',
  };
}

export async function buildMesh(cfg: ServerConfig): Promise<{ mesh: InferenceMesh; keyStore: FileKeyStore }> {
  const keyStore = new FileKeyStore(cfg.keysPath, cfg.registryPath, process.env);
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
    mesh: new InferenceMesh({ registry, ledger: new QuotaLedger(new FileStorage(cfg.ledgerPath)) }),
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
      try {
        const request = await toFetchRequest(req, `http://${cfg.host}:${cfg.port}`);
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

  server.listen(cfg.port, cfg.host, () => {
    const first = [...cfg.tokens][0] as string;
    console.log(
      `[inferencemesh] listening on http://${cfg.host}:${cfg.port} ` +
        `— ${mesh.registry.candidates.length} candidates from ${mesh.registry.providers.length} provider(s)`,
    );
    // The token rides in the fragment: it is never sent to the server and never
    // reaches an access log, unlike a query string.
    console.log(`[inferencemesh] add keys here: http://127.0.0.1:${cfg.port}/setup#${first}`);
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
