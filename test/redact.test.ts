import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { redact, restore } from '../src/redact.js';

describe('redact', () => {
  test('round-trips a Japanese question', () => {
    const { redacted, entities } = redact('田中商事は佐藤と合併しますか？', ['田中商事', '佐藤']);
    assert.equal(redacted, '[[IMESH-E1]]は[[IMESH-E2]]と合併しますか？');
    assert.deepEqual(entities, ['田中商事', '佐藤']);
    assert.equal(restore('はい、[[IMESH-E1]]は[[IMESH-E2]]と合併します。', entities), 'はい、田中商事は佐藤と合併します。');
  });

  test('longest secret wins over its own substring', () => {
    const { redacted, entities } = redact('田中商事の田中', ['田中', '田中商事']);
    assert.equal(redacted, '[[IMESH-E1]]の[[IMESH-E2]]');
    assert.deepEqual(entities, ['田中商事', '田中']);
  });

  test('a secret shorter than two characters is skipped, not masking the text', () => {
    const { redacted, entities } = redact('AはBですか', ['A', 'Bですか']);
    assert.equal(redacted, 'Aは[[IMESH-E1]]');
    assert.deepEqual(entities, ['Bですか']);
  });

  test('secrets that never appear cost nothing', () => {
    const { redacted, entities } = redact('今日は晴れです', ['雨', '雪']);
    assert.equal(redacted, '今日は晴れです');
    assert.deepEqual(entities, []);
  });

  test('refuses text that already contains an alias token', () => {
    assert.throws(() => redact('[[IMESH-E1]]は誰？', ['誰']), /already contains/);
  });

  test('restore leaves unknown aliases alone instead of guessing', () => {
    assert.equal(restore('[[IMESH-E1]]と[[IMESH-E9]]', ['田中商事']), '田中商事と[[IMESH-E9]]');
  });

  test('the literal secret never appears in the redacted prompt', () => {
    const secrets = ['田中商事', '佐藤', '120億円'];
    const { redacted } = redact('田中商事が佐藤を120億円で買収', secrets);
    for (const s of secrets) assert.ok(!redacted.includes(s), `leaked: ${s}`);
  });
});
