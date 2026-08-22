import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';

import { SETUP_HTML } from '../src/setup-ui.js';

/**
 * The diagrams on the setup page, exercised as the page runs them.
 *
 * The drawing code lives inside the HTML string — the page has no build step,
 * which is the point of it — so testing it means pulling the script out and
 * running it. That is worth the awkwardness: this is the code a person reads when
 * they are trying to find a button, and a template literal eats a lone
 * backslash, which had already turned one of these regexes into a syntax error
 * that would have served a blank page.
 */
interface PageFns {
  diagramFor(step: string, ctx: { host: string; keyPrefix?: string }): string | null;
  controlOf(text: string): string | null;
  hostIn(text: string): string | null;
  escA(s: string): string;
}

function pageScript(): PageFns {
  const script = /<script>([\s\S]*?)<\/script>/.exec(SETUP_HTML)?.[1];
  assert.ok(script, 'the page has a script');
  const shim = `
    const document = {
      createElement: () => ({
        _t: '',
        set textContent(v) { this._t = String(v); },
        get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;'); },
      }),
      querySelector: () => ({ addEventListener() {}, style: {}, set textContent(v) {}, set innerHTML(v) {}, set hidden(v) {} }),
    };
    const location = { hash: '' };
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  `;
  const body = (script as string).replace(/\nload\(\);\s*$/, '\n');
  const factory = new Function(`${shim}${body}; return { diagramFor, controlOf, hostIn, escA };`) as () => PageFns;
  return factory();
}

async function shippedProviders(): Promise<
  Array<{ id: string; keyPrefix?: string; signupSteps?: { ja?: string[] } }>
> {
  const raw = await readFile(new URL('../../providers.default.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { providers: Array<Record<string, never>> }).providers as never;
}

describe('setup page diagrams', () => {
  test('every step of every shipped guide gets a picture', async () => {
    // Not a nice-to-have: the request was for something visual per step, and a
    // guide where most steps are bare text has quietly not delivered it. When
    // this drops, either a new provider's wording needs a shape, or a shape
    // needs adding — the failure names which step.
    const { diagramFor } = pageScript();
    const missing: string[] = [];
    for (const p of await shippedProviders()) {
      for (const s of p.signupSteps?.ja ?? []) {
        const ctx = { host: '', ...(p.keyPrefix ? { keyPrefix: p.keyPrefix } : {}) };
        if (!diagramFor(s, ctx)) missing.push(`${p.id}: ${s}`);
      }
    }
    assert.deepEqual(missing, [], `no diagram for:\n${missing.join('\n')}`);
  });

  test('a step naming a control highlights that exact control', async () => {
    const { diagramFor } = pageScript();
    const svg = diagramFor('「Create API Key」を押す', { host: 'console.groq.com' }) as string;
    assert.match(svg, /Create API Key/);
    assert.match(svg, /ここ/, 'and points at it');
  });

  test('nothing is drawn for a step that describes no screen', async () => {
    // A decorative box that means nothing is worse than a paragraph alone.
    const { diagramFor } = pageScript();
    assert.equal(diagramFor('しばらく待ちます', { host: '' }), null);
  });

  test('every drawing stays inside its frame and carries no active content', async () => {
    const { diagramFor } = pageScript();
    for (const p of await shippedProviders()) {
      for (const s of p.signupSteps?.ja ?? []) {
        const svg = diagramFor(s, { host: '', ...(p.keyPrefix ? { keyPrefix: p.keyPrefix } : {}) });
        if (!svg) continue;
        assert.match(svg, /viewBox="0 0 420 190"/, s);
        assert.ok(!/NaN|undefined|Infinity/.test(svg), `non-numeric coordinate in: ${s}`);
        assert.ok(!/<script|onload=|xlink:href/i.test(svg), `active content in: ${s}`);
        for (const m of svg.matchAll(/(?:x|y|width|height|cx|cy)="(-?[\d.]+)"/g)) {
          const v = Number(m[1]);
          assert.ok(v >= -20 && v <= 460, `${m[0]} is outside the frame in: ${s}`);
        }
      }
    }
  });

  test('a quote in a label cannot break out of an attribute', async () => {
    // esc() escapes < and &, and leaves quotes alone, which is only safe
    // inside an element. Labels reach aria-label as well.
    const { escA } = pageScript();
    assert.equal(escA('a"b\'c'), 'a&quot;b&#39;c');
  });
});
