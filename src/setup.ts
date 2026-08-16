/**
 * Guided key setup.
 *
 * The point of this file is a claim about who uses the tool: someone who has
 * never heard the word "API key" can get one in two minutes if something walks
 * them to the page and tells them what to paste. What stops people is not
 * capability, it is that nobody told them these free tiers exist.
 *
 * So the wizard does three things, in this order:
 *
 *   1. says what each provider actually gives you, in a sentence
 *   2. prints the exact URL to go and get it
 *   3. **verifies the pasted key immediately with a real request**
 *
 * Step 3 is the one that matters. "Saved!" is not reassurance — a key that was
 * mistyped, or copied with a trailing space, or belongs to the wrong account,
 * saves exactly as happily as a working one and then fails hours later inside
 * something else. Confirming it works here is the difference between a setup
 * that people finish and one they abandon.
 */

import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

import { InferenceMesh } from './mesh.js';
import { Registry } from './registry.js';
import { registryFrom } from './config.js';
import type { ProviderConfig } from './types.js';

type Lang = 'en' | 'ja';

const MSG = {
  en: {
    intro: 'InferenceMesh setup — free AI models, no credit card.',
    already: 'already set up',
    keyless: 'works with no key at all',
    noSignup: 'no signup page recorded; set the variable yourself',
    freeTier: 'Free tier',
    getKey: 'Get a key here',
    envVar: 'Then paste it below. It is stored in',
    prompt: (id: string) => `  ${id} key (blank to skip): `,
    checking: '  checking...',
    ok: (ms: number) => `  OK — answered in ${ms}ms`,
    bad: (why: string) => `  that key did not work: ${why}`,
    retry: '  try again? [y/N]: ',
    saved: (n: number) => `\nSaved ${n} working key(s).`,
    none: '\nNo keys added. The mesh still works with keyless providers only — run `inferencemesh probe` to see what you have.',
    summary: 'You can now run: inferencemesh probe',
    trapsTitle: 'Before you build on this — what a free tier actually costs:',
    traps: [
      'Your prompts may be used to train the provider\'s models. That is usually the deal. Do not send anything private, medical, or anyone else\'s personal data.',
      'Never put this key in a web page or a phone app. Anything shipped to a browser is public. Keep it behind a server — this gateway is that server.',
      'Free tiers have no uptime promise and can be withdrawn without notice. Fine for learning and side projects; not for anything anyone depends on.',
      'Some free models reply with their own reasoning out loud ("The user asks..."). That is the model, not a bug in your code — strip it or pick another.',
      'This gateway never falls back to a paid model. If every free tier is exhausted it returns an error, so a mistake cannot become a bill.',
    ],
  },
  ja: {
    intro: 'InferenceMesh セットアップ — 無料のAIモデル。クレジットカードは要りません。',
    already: '設定済み',
    keyless: '鍵なしで使えます',
    noSignup: '取得ページが未登録です。環境変数を自分で設定してください',
    freeTier: '無料枠',
    getKey: 'ここで鍵を取れます',
    envVar: '取った鍵を下に貼ってください。保存先は',
    prompt: (id: string) => `  ${id} の鍵（何も入れずEnterで飛ばせます）: `,
    checking: '  確認しています...',
    ok: (ms: number) => `  OK — ${ms}ms で応答しました`,
    bad: (why: string) => `  この鍵では動きませんでした: ${why}`,
    retry: '  もう一度入れますか? [y/N]: ',
    saved: (n: number) => `\n動作を確認できた鍵を ${n} 件 保存しました。`,
    none: '\n鍵は追加していません。鍵の要らないプロバイダだけでも動きます — `inferencemesh probe` で確認できます。',
    summary: '次のコマンドで確認できます: inferencemesh probe',
    trapsTitle: '作り始める前に — 「無料」の本当の代金:',
    traps: [
      'あなたが送った文章は、提供元のモデルの学習に使われることがあります。それが無料の対価です。個人情報・医療情報・他人の情報は送らないでください。',
      'この鍵をWebページやスマホアプリに書かないでください。ブラウザに配ったものは全部公開されたのと同じです。鍵はサーバー側に置きます（このゲートウェイがそのサーバーです）。',
      '無料枠に「止まらない保証」はありません。予告なく終了することもあります。学習や個人の制作には十分ですが、誰かが頼りにするものには向きません。',
      '無料モデルには、考えている途中（「The user asks...」など）をそのまま出すものがあります。あなたのコードのバグではありません — 取り除くか、別のモデルを選んでください。',
      'このゲートウェイは有料モデルに勝手に切り替えません。無料枠を使い切ったらエラーを返します。操作ミスが請求に変わることはありません。',
    ],
  },
} as const;

function pickLang(env: NodeJS.ProcessEnv): Lang {
  const explicit = env['INFERENCEMESH_LANG'];
  if (explicit === 'ja' || explicit === 'en') return explicit;
  // The audience this is written for is far more likely to have a Japanese
  // locale than to know there is a language flag.
  const locale = env['LC_ALL'] ?? env['LC_MESSAGES'] ?? env['LANG'] ?? '';
  return /^ja/i.test(locale) ? 'ja' : 'en';
}

/ Verify a key by actually calling the provider once, cheaply. */
async function verify(
  provider: ProviderConfig,
  key: string,
  env: Record<string, string | undefined>,
): Promise<{ ok: true; ms: number } | { ok: false; why: string }> {
  const probeEnv = { ...env, [provider.apiKeyEnv]: key };
  const registry = new Registry([provider], { env: probeEnv });
  const candidate = registry.candidates[0];
  if (!candidate) {
    return { ok: false, why: `no usable model (missing ${provider.accountIdEnv ?? provider.apiKeyEnv}?)` };
  }
  const mesh = new InferenceMesh({ registry, maxAttempts: 1, timeoutMs: 30_000 });
  const t0 = Date.now();
  try {
    await mesh.chat({
      model: candidate.key,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0,
    });
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, why: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
}

/**
 * Prompt/read pairs that work on a pipe as well as a terminal.
 *
 * `readline/promises` was the obvious choice and is wrong here: with non-TTY
 * input its second `question()` never settles and Node exits with code 13.
 * Consuming the interface as an async iterator behaves identically for both,
 * which matters because setup should be drivable by a UI or a script, not only
 * by a human at a terminal.
 *
 * A null return means end of input — answer nothing further and finish.
 */
function lineReader(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const it = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt: string): Promise<string | null> {
      output.write(prompt);
      const r = await it.next();
      if (r.done) {
        output.write('\n');
        return null;
      }
      return r.value;
    },
    close(): void {
      rl.close();
    },
  };
}

export function mergeEnv(existing: string, updates: Record<string, string>): string {
  const lines = existing ? existing.split('\n') : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (!m) return line;
    const name = m[1] as string;
    if (!(name in updates)) return line;
    seen.add(name);
    return `${name}=${updates[name]}`;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  return out.filter((l, i, a) => !(l === '' && a[i + 1] === '')).join('\n').replace(/\n*$/, '\n');
}

export async function runSetup(registryPath: string, envPath: string): Promise<number> {
  const lang = pickLang(process.env);
  const t = MSG[lang];
  const raw = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
  const file = registryFrom(raw, { env: {} }); // env:{} so nothing is filtered out yet
  void file;
  const parsed = JSON.parse(await readFile(registryPath, 'utf8')) as { providers: ProviderConfig[] };

  const rl = lineReader(stdin, stdout);
  const collected: Record<string, string> = {};
  let eof = false;

  console.log(`\n${t.intro}\n`);
  // Shown before anything is set up, not buried in a doc afterwards. The
  // audience this is for has been told an API key is dangerous without ever
  // being told *which* parts are dangerous, which is how people end up either
  // paralysed or pasting keys into a web page.
  console.log(t.trapsTitle);
  for (const line of t.traps) console.log(`  - ${line}`);
  console.log('');

  try {
    for (const p of parsed.providers) {
      if (p.disabled) continue;
      const configured = Boolean(process.env[p.apiKeyEnv]);
      const header = `${p.id}${p.summary ? ` — ${p.summary}` : ''}`;

      if (p.apiKeyOptional && !configured) {
        console.log(`✓ ${header}\n    (${t.keyless})\n`);
        continue;
      }
      if (configured) {
        console.log(`✓ ${header}\n    (${t.already}: ${p.apiKeyEnv})\n`);
        continue;
      }

      console.log(`· ${header}`);
      if (p.freeTierNote) console.log(`    ${t.freeTier}: ${p.freeTierNote}`);
      console.log(`    ${p.signupUrl ? `${t.getKey}: ${p.signupUrl}` : t.noSignup}`);
      console.log(`    ${t.envVar} ${envPath}`);

      for (;;) {
        const raw = await rl.ask(t.prompt(p.apiKeyEnv));
        if (raw === null) {
          eof = true;
          break;
        }
        const answer = raw.trim();
        if (!answer) break;
        console.log(t.checking);
        const env: Record<string, string | undefined> = { ...process.env, ...collected };
        const res = await verify(p, answer, env);
        if (res.ok) {
          console.log(t.ok(res.ms));
          collected[p.apiKeyEnv] = answer;
          break;
        }
        console.log(t.bad(res.why));
        const again = await rl.ask(t.retry);
        if (again === null) {
          eof = true;
          break;
        }
        if (again.trim().toLowerCase() !== 'y') break;
      }
      if (eof) break;
      console.log('');
    }
  } finally {
    rl.close();
  }

  const n = Object.keys(collected).length;
  if (n === 0) {
    console.log(t.none);
    return 0;
  }
  let existing = '';
  try {
    existing = await readFile(envPath, 'utf8');
  } catch {
    /* first run */
  }
  await writeFile(envPath, mergeEnv(existing, collected), { mode: 0o600 });
  console.log(t.saved(n));
  console.log(t.summary);
  return 0;
}
