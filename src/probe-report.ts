/**
 * The pure half of `probe`: reading a failure, and deciding what it means.
 *
 * It lives outside `cli.ts` because `cli.ts` runs the CLI on import — nothing
 * can test it without starting a command. Everything here is a plain function
 * over values, so the classification that decides `probe`'s exit code is
 * checked by the suite rather than by a person watching a terminal.
 */

import { ProviderError } from './providers/base.js';
import { MeshError } from './types.js';

/**
 * The HTTP status behind a failed attempt, or undefined if there was none
 * (a timeout, a DNS failure, a quota refusal that never reached the wire).
 *
 * Read from the structured trace, not from the message. `MeshError` formats
 * its attempts into a sentence — `all 1 attempt(s) failed: llm7/x (429: …)` —
 * and scraping that sentence with a regex means the day somebody improves the
 * wording, every 429 starts being reported as a broken model id and `probe`
 * exits 1 on a healthy registry. The status is already in `detail.attempts`;
 * take it from there.
 */
export function attemptStatus(err: unknown): number | undefined {
  if (err instanceof ProviderError) return err.status;
  if (err instanceof MeshError) {
    const attempts = (err.detail as { attempts?: Array<{ status?: number }> } | undefined)?.attempts;
    if (Array.isArray(attempts)) {
      // The last attempt is the one that decided the outcome. `probe` runs
      // with maxAttempts: 1, so there is normally exactly one.
      for (let i = attempts.length - 1; i >= 0; i--) {
        const s = attempts[i]?.status;
        if (typeof s === 'number') return s;
      }
    }
  }
  return undefined;
}

/**
 * Two findings that look alike and are not.
 *
 * A 404 or a 400 means the model id is gone and a human has to edit the
 * registry. A 429 means the free tier is doing exactly what a free tier does.
 * Alerting on the second every night is how a monitor teaches you to ignore
 * it, so only the first sets an exit code.
 */
export type ProbeVerdict = 'ok' | 'limited' | 'broken';

export function verdictFor(status: number | undefined): ProbeVerdict {
  return status === 429 ? 'limited' : 'broken';
}

/** Strip the mesh's own framing so the provider's message is what shows. */
export function shortMessage(err: unknown, max = 160): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^all \d+ attempt\(s\) failed: \S+ /, '').slice(0, max);
}
