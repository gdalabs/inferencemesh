import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { VALIDATION_MAX_TOKENS, validationRequest } from '../src/validation-probe.js';

describe('the reply budget of a live check', () => {
  test('is large enough that a provider does not reject the request itself', () => {
    // B.AI answers `400 max_tokens must be greater than 2`. At 1, probe
    // reported four working models as BROKEN — the request was wrong, not
    // the models.
    assert.ok(VALIDATION_MAX_TOKENS > 2, 'a budget of 1 or 2 is refused by real providers');
  });

  test('is the same request in every place that checks a key or a model', () => {
    // probe, setup and the gateway's key check are one operation. Split
    // budgets let one of them reject what another calls healthy.
    assert.deepEqual(validationRequest('bai/glm-5.3-flash'), {
      model: 'bai/glm-5.3-flash',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: VALIDATION_MAX_TOKENS,
      temperature: 0,
    });
  });

  test('hands out a fresh object, not a shared one to mutate', () => {
    const first = validationRequest('provider/one');
    const second = validationRequest('provider/two');
    first.messages[0]!.content = 'changed';
    assert.equal(second.messages[0]?.content, 'ping');
  });
});
