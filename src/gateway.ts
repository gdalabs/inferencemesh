/**
 * Fetch-API gateway. One function, Request in / Response out, so the same
 * handler backs the Node server, a Cloudflare Worker, Deno, and Bun.
 *
 * Routes:
 *   POST /v1/chat/completions   OpenAI-compatible, streaming and not
 *   GET  /v1/models             the registry, as OpenAI model objects
 *   GET  /healthz               breakers, quota, and load-time warnings
 */

import { InferenceMesh } from './mesh.js';
import { blendedPrice, maxPrivacyOf } from './registry.js';
import { MeshError, NoCandidateError, type ChatRequest } from './types.js';

export interface GatewayOptions {
  mesh: InferenceMesh;
  /**
   * Accepted bearer tokens. Fail-closed: an empty set rejects every request
   * rather than serving an open relay to whoever finds the port.
   */
  tokens: Set<string>;
  /** Allowed Origins for browser callers. Empty means no CORS headers at all. */
  allowedOrigins?: string[];
  /** Expose /healthz without a token. Off by default. */
  publicHealth?: boolean;
}

function cors(origin: string | null, allowed: string[] | undefined): Record<string, string> {
  if (!allowed || allowed.length === 0 || !origin) return {};
  const ok = allowed.includes('*') || allowed.includes(origin);
  if (!ok) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    vary: 'Origin',
  };
}

function json(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

function errorBody(message: string, code: string, detail?: unknown): unknown {
  return { error: { message, type: code, code, ...(detail === undefined ? {} : { detail }) } };
}

/**
 * Constant-time-ish token comparison.
 *
 * Set membership leaks length through timing in principle. It is used anyway
 * because these are long random tokens behind a tailnet, and the honest note is
 * worth more than a false sense of a hand-rolled compare.
 */
function authorized(req: Request, tokens: Set<string>): boolean {
  if (tokens.size === 0) return false;
  const header = req.headers.get('authorization');
  if (!header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return tokens.has(m[1] as string);
}

export async function handleRequest(req: Request, opts: GatewayOptions): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('origin');
  const ch = cors(origin, opts.allowedOrigins);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });

  const isHealth = url.pathname === '/healthz';
  if (!(isHealth && opts.publicHealth) && !authorized(req, opts.tokens)) {
    return json(errorBody('missing or invalid bearer token', 'unauthorized'), 401, ch);
  }

  if (isHealth) {
    return json(
      {
        ok: true,
        providers: opts.mesh.registry.providers.map((p) => p.id),
        candidates: opts.mesh.registry.candidates.length,
        warnings: opts.mesh.registry.warnings,
        health: opts.mesh.health.snapshot(),
        quota: await opts.mesh.ledger.snapshot(),
      },
      200,
      ch,
    );
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const profiles = Object.keys(opts.mesh.registry.profiles).map((name) => ({
      id: `mesh/${name}`,
      object: 'model',
      owned_by: 'inferencemesh',
      mesh: { kind: 'profile' },
    }));
    const models = opts.mesh.registry.candidates.map((c) => ({
      id: c.key,
      object: 'model',
      owned_by: c.provider.id,
      mesh: {
        kind: 'model',
        capabilities: c.model.capabilities,
        context_window: c.model.contextWindow,
        price_per_mtok_blended: blendedPrice(c.model),
        max_privacy: maxPrivacyOf(c),
      },
    }));
    return json({ object: 'list', data: [...profiles, ...models] }, 200, ch);
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body: ChatRequest;
    try {
      body = (await req.json()) as ChatRequest;
    } catch {
      return json(errorBody('request body is not valid JSON', 'invalid_request'), 400, ch);
    }
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return json(errorBody('`model` (string) and `messages` (array) are required', 'invalid_request'), 400, ch);
    }

    try {
      if (body.stream) {
        const { stream, trace } = await opts.mesh.stream(body, req.signal);
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            // Which provider answered, without waiting for the body to finish.
            'x-mesh-served-by': trace.served_by,
            'x-mesh-profile': trace.profile,
            ...ch,
          },
        });
      }
      const res = await opts.mesh.chat(body, req.signal);
      return json(res, 200, {
        'x-mesh-served-by': res.mesh?.served_by ?? '',
        'x-mesh-profile': res.mesh?.profile ?? '',
        ...ch,
      });
    } catch (err) {
      if (err instanceof NoCandidateError) {
        return json(errorBody(err.message, err.code, err.rejected), err.status, ch);
      }
      if (err instanceof MeshError) {
        return json(errorBody(err.message, err.code, err.detail), err.status, ch);
      }
      const message = err instanceof Error ? err.message : String(err);
      return json(errorBody(message, 'internal_error'), 500, ch);
    }
  }

  return json(errorBody(`no route for ${req.method} ${url.pathname}`, 'not_found'), 404, ch);
}
