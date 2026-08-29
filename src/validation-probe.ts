import { probePrompt } from './probe-report.js';

/**
 * The reply budget used by live availability and credential checks.
 *
 * Deliberately small: these requests may run once per model, and in a
 * user-supplied registry they may spend paid quota. It must not, however, be
 * the smallest value one particular provider happens to accept.
 *
 * It was 1 until 2026-08-29, when B.AI answered every model with
 * `400 max_tokens must be greater than 2`. `probe` reported four working
 * models as BROKEN — a request rejected for its output budget says nothing
 * about the key, the model id, or whether the model is still served, which is
 * the only thing these three call sites exist to find out. Confusing our own
 * malformed request with provider rot is the failure this constant prevents.
 *
 * Kept in one place because the CLI probe, `setup`, and the gateway's key
 * check are the same operation. Split budgets let setup reject a key for a
 * model that probe calls healthy, or the reverse, and the two would drift
 * apart quietly.
 */
export const VALIDATION_MAX_TOKENS = 16;

/**
 * The one request shape all three live checks send.
 *
 * The prompt comes from `probePrompt` so that a caching provider cannot
 * answer it from a previous run. That mattered for `probe` first, but it
 * matters for `setup` and the gateway's key check for the same reason: a
 * cached 200 tells you a request succeeded once, not that the key works now.
 */
export function validationRequest(model: string) {
  return {
    model,
    messages: [{ role: 'user' as const, content: probePrompt() }],
    max_tokens: VALIDATION_MAX_TOKENS,
    temperature: 0,
  };
}
