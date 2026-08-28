import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

/**
 * The CLI, run as a program.
 *
 * `cli.ts` starts the CLI on import, so nothing here can be unit-tested — and
 * the bugs this file covers are all ones that only appear when the thing is
 * actually run. `route` touches no network and needs no key, so the whole file
 * works on a runner with no secrets.
 */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  // A key that is never used: it only has to be present, so the registry loads
  // a provider and the ranking has something in it.
  const env = { PATH: process.env['PATH'] ?? '', OPENROUTER_API_KEY: 'test-not-a-real-key' };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

describe('cli — a mistyped argument is a message, not a crash', () => {
  test('an unknown profile names the ones that exist', async () => {
    // This printed a stack trace with the Node version under it, while every
    // other bad input got one usable line.
    const r = await cli(['route', 'nosuchprofile']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown mesh profile 'nosuchprofile'/);
    assert.match(r.err, /free/, 'and lists what is available');
    assert.ok(!r.err.includes('at Registry.'), 'no stack trace');
  });

  test('an unknown privacy tier is refused, not passed through', async () => {
    // It used to reach the router and reject every candidate with
    // "privacy: needs internel", which reads as the registry being wrong.
    const r = await cli(['route', 'free', '--privacy=internel']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown privacy tier 'internel'/);
  });

  test('an unknown capability is refused, not passed through', async () => {
    const r = await cli(['route', 'free', '--capabilities=tols']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown capability 'tols'/);
  });

  test('a non-numeric --min-context is caught rather than becoming NaN', async () => {
    // NaN filtered nothing at all, while looking exactly like a filter that
    // had been applied.
    const r = await cli(['route', 'free', '--min-context=abc']);
    assert.equal(r.code, 2);
    assert.match(r.err, /positive integer/);
  });

  test('an unknown command prints the help', async () => {
    const r = await cli(['nonsense']);
    assert.equal(r.code, 2);
    assert.match(r.err, /inferencemesh — an OpenAI-compatible router/);
  });
});

describe('cli — help', () => {
  test('--help lists the commands', async () => {
    // The installed thing is one executable with no README beside it.
    for (const flag of ['help', '--help', '-h']) {
      const r = await cli([flag]);
      assert.equal(r.code, 0, flag);
      for (const cmd of ['setup', 'serve', 'route', 'probe', 'sync', 'version']) {
        assert.match(r.out, new RegExp(`inferencemesh ${cmd}`), `${flag} omits ${cmd}`);
      }
    }
  });

  test('an unknown command shows the same help, and fails', async () => {
    const r = await cli(['nonsense']);
    assert.equal(r.code, 2);
    assert.match(r.err, /inferencemesh route/);
    assert.match(r.err, /unknown command 'nonsense'/);
  });

  test('every flag in the help is one the CLI reads', async () => {
    // A help screen that lists a flag nothing implements is worse than none.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
    const help = (await cli(['--help'])).out;
    const listed = new Set([...help.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1] as string));
    assert.ok(listed.size >= 8, 'the help lists flags at all');
    for (const flag of listed) {
      const bare = flag.slice(2);
      assert.ok(
        source.includes(`'${bare}'`) || source.includes(flag),
        `${flag} is documented in --help but nothing reads it`,
      );
    }
  });
});

describe('cli — version', () => {
  test('the binary can say what it is', async () => {
    // A distributed executable with no way to report its version turns every
    // bug report into a guess about which build the reporter has. The value is
    // compiled in, because a single executable has no package.json beside it.
    for (const flag of ['version', '--version', '-v']) {
      const r = await cli([flag]);
      assert.equal(r.code, 0, flag);
      assert.match(r.out, /^inferencemesh \d+\.\d+\.\d+/, flag);
    }
  });

  test('it is the version the package declares', async () => {
    const pkg = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        new URL('../../package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string };
    const r = await cli(['version']);
    assert.equal(r.out.trim(), `inferencemesh ${pkg.version}`);
  });
});

describe('cli — the offline commands still work', () => {
  test('route ranks candidates and exits 0', async () => {
    const r = await cli(['route', 'free']);
    assert.equal(r.code, 0);
    assert.match(r.out, /profile: free/);
    assert.match(r.out, /score=/);
  });

  test('a valid --min-context is applied', async () => {
    const wide = await cli(['route', 'free', '--min-context=999999999']);
    assert.match(wide.out, /context: /, 'candidates are rejected for context, with a reason');
  });

  test('the whole output survives a pipe', async () => {
    // process.exit() truncates piped stdout; the CLI sets process.exitCode
    // instead. execFile reads through a pipe, so a regression shows up here.
    const r = await cli(['route', 'free']);
    assert.match(r.out.trimEnd(), /\$[\d.]+\/MTok\s+\w+$/, 'the last line is complete');
  });
});

describe('cli — setup, all the way through', () => {
  /** A provider that answers the one request `setup` makes to verify a key. */
  async function stubProvider() {
    const seen: Array<{ auth: string | undefined }> = [];
    const server = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { seen, port, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  test('a key typed on a pipe is verified, then written', async () => {
    // The wizard's whole promise is that "saved" means "checked". Nothing but
    // running it end to end shows that the pipe, the prompt loop, the live
    // verification and the file write hold together — and the pipe half is
    // where readline/promises silently never settles.
    const stub = await stubProvider();
    const dir = await mkdtemp(join(tmpdir(), 'im-cli-setup-'));
    const registry = join(dir, 'registry.json');
    const keyFile = join(dir, 'keys');
    await (await import('node:fs/promises')).writeFile(
      registry,
      JSON.stringify({
        providers: [
          {
            id: 'stub',
            kind: 'openai-compat',
            baseUrl: `http://127.0.0.1:${stub.port}/v1`,
            apiKeyEnv: 'STUB_KEY_FOR_CLI_TEST',
            maxPrivacy: 'public',
            signupUrl: 'https://example.invalid',
            models: [
              { id: 'm', capabilities: ['text'], contextWindow: 1000, price: { inPerMTok: 0, outPerMTok: 0 } },
            ],
          },
        ],
      }),
    );

    const child = spawn(process.execPath, [CLI, 'setup', keyFile], {
      env: {
        PATH: process.env['PATH'] ?? '',
        INFERENCEMESH_REGISTRY: registry,
        INFERENCEMESH_LANG: 'en',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stdin.write('sk-typed-by-a-person\n');
    child.stdin.end();
    const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? 1)));
    await stub.close();

    assert.equal(code, 0, out);
    assert.match(out, /OK — answered in/, 'the key was checked against the provider');
    assert.equal(stub.seen.length, 1, 'exactly one verification request');
    assert.equal(stub.seen[0]?.auth, 'Bearer sk-typed-by-a-person');
    assert.match(await readFile(keyFile, 'utf8'), /^STUB_KEY_FOR_CLI_TEST=sk-typed-by-a-person$/m);
  });
});

describe('--help after a subcommand', () => {
  // `probe --help` used to reach `case 'probe'` and run a live probe: real
  // requests, against the caller's free quota, to answer a question about
  // usage. The flag was not rejected, it was simply not looked at.
  //
  // `probe` cannot be tested here without a network, so the proof is indirect
  // and deliberately so: the help text must come out, and none of probe's own
  // output may. A probe that started would print provider warnings first.
  test('probe --help prints usage instead of probing', async () => {
    const { code, out, err } = await cli(['probe', '--help']);
    assert.equal(code, 0);
    assert.match(out, /an OpenAI-compatible router across free LLM tiers/, 'the help text is what comes out');
    assert.doesNotMatch(
      out + err,
      /reachable|rate-limited|skipped: missing env/,
      'no sign that a probe ran',
    );
  });

  test('-h works the same way, and on every command', async () => {
    for (const argv of [
      ['probe', '-h'],
      ['sync', '--help'],
      ['route', 'free', '--help'],
      ['serve', '--help'],
    ]) {
      const { code, out } = await cli(argv);
      assert.equal(code, 0, `${argv.join(' ')} exited non-zero`);
      assert.match(out, /inferencemesh setup \[FILE\]/, `${argv.join(' ')} printed no help`);
    }
  });
});
