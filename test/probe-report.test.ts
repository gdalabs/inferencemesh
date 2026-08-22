import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { attemptStatus, shortMessage, verdictFor } from '../src/probe-report.js';
import { ProviderError } from '../src/providers/base.js';
import { MeshError } from '../src/types.js';

/** A mesh failure shaped the way `mesh.chat` actually throws one. */
function meshFailure(attempts: Array<{ key: string; status?: number; error: string }>) {
  return new MeshError(
    `all ${attempts.length} attempt(s) failed: ` +
      attempts.map((a) => `${a.key} (${a.status ?? '-'}: ${a.error})`).join('; '),
    502,
    'all_attempts_failed',
    { attempts: attempts.map((a) => ({ ...a, ms: 1 })), rejected: [] },
  );
}

describe('attemptStatus', () => {
  test('reads the status from the trace, not from the sentence', () => {
    // The point of the whole module: a regex over the message means the day
    // somebody improves the wording, every 429 is reported as a dead model id.
    const err = meshFailure([{ key: 'p/m', status: 429, error: 'rate limited' }]);
    assert.equal(attemptStatus(err), 429);
    assert.equal(attemptStatus(new ProviderError('gone', 404)), 404);
  });

  test('a reworded message does not change the classification', () => {
    const err = new MeshError('everything went wrong, sorry', 502, 'all_attempts_failed', {
      attempts: [{ key: 'p/m', status: 429, error: 'rate limited', ms: 1 }],
      rejected: [],
    });
    assert.equal(verdictFor(attemptStatus(err)), 'limited');
  });

  test('the deciding attempt is the last one that reached the wire', () => {
    const err = meshFailure([
      { key: 'a/1', error: 'timeout' },
      { key: 'b/2', status: 404, error: 'no such model' },
    ]);
    assert.equal(attemptStatus(err), 404);
  });

  test('a failure that never reached the wire has no status', () => {
    assert.equal(attemptStatus(meshFailure([{ key: 'a/1', error: 'quota: no free slot' }])), undefined);
    assert.equal(attemptStatus(new Error('socket hang up')), undefined);
    assert.equal(attemptStatus('not even an error'), undefined);
  });
});

describe('verdictFor', () => {
  test('a rate limit is the free tier working, and never sets an exit code', () => {
    assert.equal(verdictFor(429), 'limited');
  });

  test('a dead id needs a human', () => {
    for (const s of [400, 401, 404, 500]) assert.equal(verdictFor(s), 'broken');
  });

  test('no status at all is still a failure worth reporting', () => {
    // A timeout is not a rate limit. Treating an unknown failure as 'limited'
    // would make probe exit 0 on a provider that never answers.
    assert.equal(verdictFor(undefined), 'broken');
  });
});

describe('shortMessage', () => {
  test("the mesh's own framing is stripped so the provider's words show", () => {
    const err = meshFailure([{ key: 'p/m', status: 404, error: 'This model is unavailable' }]);
    assert.match(shortMessage(err), /^\(404: This model is unavailable\)$/);
  });

  test('a long message is cut to the width asked for', () => {
    assert.equal(shortMessage(new Error('x'.repeat(400)), 20).length, 20);
  });
});
