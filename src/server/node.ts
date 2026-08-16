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

import { handleRequest } from '../gateway.js';
import { InferenceMesh } from '../mesh.js';
import { QuotaLedger, type LedgerRecord, type LedgerStorage } from '../ledger.js';
import { registryFrom } from '../config.js';

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
function defaultRegistryPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'providers.default.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'providers.default.json not found near ' +
      fileURLToPath(import.meta.url) +
      ' — set INFERENCEMESH_REGISTRY to point at your registry file',
  );
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
    allowedOrigins: (env['INFERENCEMESH_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    publicHealth: env['INFERENCEMESH_PUBLIC_HEALTH'] === '1',
  };
}

export async function buildMesh(cfg: ServerConfig): Promise<InferenceMesh> {
  const raw = JSON.parse(await readFile(cfg.registryPath, 'utf8')) as unknown;
  const registry = registryFrom(raw);
  for (const w of registry.warnings) {
    console.warn(`[inferencemesh] provider '${w.providerId}' skipped: ${w.reason}`);
  }
  if (registry.candidates.length === 0) {
    throw new Error(
      'no usable providers: every provider was skipped. Set at least one API key ' +
        '(see the warnings above) before starting the gateway.',
    );
  }
  return new InferenceMesh({
    registry,
    ledger: new QuotaLedger(new FileStorage(cfg.ledgerPath)),
  });
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

  const mesh = await buildMesh(cfg);
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const request = await toFetchRequest(req, `http://${cfg.host}:${cfg.port}`);
        const out = await handleRequest(request, {
          mesh,
          tokens: cfg.tokens,
          allowedOrigins: cfg.allowedOrigins,
          publicHealth: cfg.publicHealth,
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
    console.log(
      `[inferencemesh] listening on http://${cfg.host}:${cfg.port} ` +
        `— ${mesh.registry.candidates.length} candidates from ${mesh.registry.providers.length} provider(s)`,
    );
  });

  const shutdown = () => {
    server.close(() => {
      void mesh.ledger.flush().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  void main();
}
