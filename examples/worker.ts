/**
 * InferenceMesh on Cloudflare Workers.
 *
 * This file is the snippet in the README, and it is compiled by `npm run
 * build` so it cannot quietly stop being true — the version that lived only in
 * the README did not type-check: passing a Worker `Env` straight to
 * `registryFrom` fails with "Index signature for type 'string' is missing",
 * which is the reader's first compile, before anything has run.
 *
 * A published package would import from 'inferencemesh'; inside this repo the
 * same code imports from the source, and a test holds the two in step.
 */
import { handleRequest, InferenceMesh, registryFrom } from '../src/index.js';
import registryFile from '../providers.default.json';

/**
 * Bindings. The index signature is what lets the whole `env` be handed to the
 * registry as its source of provider keys — each provider names the variable
 * it wants, so they are not listed here one by one.
 */
interface Env {
  GATEWAY_TOKENS: string;
  [key: string]: string | undefined;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const mesh = new InferenceMesh({ registry: registryFrom(registryFile, { env }) });
    return handleRequest(req, { mesh, tokens: new Set(env.GATEWAY_TOKENS.split(',')) });
  },
};
