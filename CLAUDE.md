# CLAUDE.md — inferencemesh

Guidance for coding agents (Claude Code, OpenCode, Codex) working in this repository.

## What this is

An OpenAI-compatible router that picks an LLM provider per request — by cost,
capability, language, privacy, remaining free quota and observed health — and
falls back when one fails. Zero runtime dependencies, `fetch` only, so the same
code runs on Node, Cloudflare Workers, Deno and Bun.

## Architecture

- `src/types.ts` — every type. Holds no behaviour, so a registry can be
  serialised to JSON, shipped to a Worker, and route identically.
- `src/registry.ts` — provider config to candidates. Enforces BYOK by dropping
  providers whose key is absent.
- `src/router.ts` — pure. Touches no network and consumes no quota.
- `src/ledger.ts` — free-tier accounting (per minute, per day, tokens per day).
  Storage is pluggable.
- `src/health.ts` — circuit breaker, latency EWMA, success rate.
- `src/concurrency.ts` — per-provider semaphore. Counts what is in flight now,
  which no window-based counter can see.
- `src/sync.ts` — catalog in, registry entries out. Pure; the merge rules live
  here. **Machine facts are refreshed, human judgement is preserved.**
- `src/language-probe.ts` — grades whether a reply is in the language it was
  asked for. Pure, so it tests against captured replies with no network.
- `src/catalogs.ts` — per-provider catalog readers. Pure functions over parsed
  JSON, so they test against a captured response with no network and no key.
- `src/mesh.ts` — route, attempt, fall back, book. **The only place allowed to retry.**
- `src/providers/*.ts` — adapters. **Must not retry and must not read the registry.**
- `src/gateway.ts` — Fetch-API handler shared by Node, Workers and Deno.
- `src/setup-ui.ts` — the setup page, as one self-contained string.
- `src/probe-report.ts` — the pure half of `probe`: what a failure means.
  Outside `cli.ts` because importing that file runs the CLI.
- `src/server/node.ts` — Node server, fail-closed auth, key storage.
- `src/cli.ts` — `setup` / `probe` / `route` / `sync` / `serve` / `version`.

## Commands

```sh
npm test                 # build, then the whole suite — no network, no key
npm run build
npm run build:binary     # single executable, runs without Node installed
node dist/src/cli.js route free --language=ja   # explain a decision, offline
node dist/src/cli.js probe                      # call every candidate for real
node dist/src/cli.js probe --language=ja         # check each answers in Japanese
# Editing providers.default.json? `npm run build` first. tsc copies it to
# dist/providers.default.json, and the running CLI finds that copy — which is
# correct for an installed package and confusing for exactly one afternoon.
node dist/src/cli.js sync --provider=redpill --dry-run   # generate from a catalog
node scripts/discover-providers.mjs             # find new free tiers; exit 10 = news
```

## Rules specific to this repository

- 🔴 **Never invent a price.** A non-zero price without `priceVerifiedAt`
  (YYYY-MM-DD) fails validation. A stale price does not error — it silently
  reorders the `cheap` profile, and you find out from an invoice.
- 🔴 **Do not add paid models to `providers.default.json`.** The shipped
  registry is free tiers only; `0` is the one number that cannot go stale in a
  way that lies to you. Paid entries belong in a user's own copy of
  `providers.example.json`.
- 🔴 **Never add a model id you have not probed.** On 2026-08-16 both `:free`
  ids in the first draft had already left the free tier. `probe` found it.
- 🔴 **Do not declare a capability you have not observed.** The registry claimed
  a keyless model had no tool calling; it does. Capabilities are measured, not
  assumed.
- 🔴 **Never bind `0.0.0.0`.** This process holds every provider key its user
  owns. Bind loopback and put a reverse proxy in front.
- 🔴 **No endpoint may return a stored key.** `KeyStore` has no `get` by design.
  Keys are never logged.
- **Adapters do not retry.** Fallback belongs to the mesh; doing both multiplies
  the attempt count.
- **Never fill an unavailable value with 0.** Absent usage means no cost is
  recorded, not a cost of zero.
- 🔴 **`sync` must never write `quality` or `languages`.** A catalog cannot know
  them. A plausible guess reorders `best` and mis-serves every non-English
  caller, with no invoice to catch it. Absent means unrated; scoring uses
  `DEFAULT_QUALITY_SCORE`, which is neutral rather than optimistic on purpose —
  nothing measures quality later, so optimism would never be repaid.
- 🔴 **`sync` must never overwrite `maxPrivacy` on an existing entry.** The
  catalog's answer and a human's decision are different facts; keep the
  catalog's in `evidencePrivacy` and diff it against its own previous value.
  Overwriting erases the decision instead of surfacing the conflict.
- 🔴 **A catalog may not erase a capability it cannot express.** `code` is the
  one that bites: no catalog describes it, so a wholesale overwrite deletes a
  hand-recorded `code` from an unchanged model and `mesh/coding` stops seeing
  it. `CATALOG_OWNED_CAPABILITIES` is the list a catalog gets to speak about.
- 🔴 **`expiresAt` is never routed on.** An announced end date is a statement of
  intent, not an observation; a model that outlives its own expiry should keep
  serving. `probe` decides what works. Far-future sentinels (`2098-12-31`) are
  recorded and not warned about — a warning that fires every run buries the one
  that is two days away.
- 🔴 **Absent is not denied.** A catalog that declares no capabilities has said
  nothing, not "no tools". Record `text`, warn, and leave probed values alone.
- 🔴 **`probe --language` must never write a `languages` score.** It measures
  compliance ("did it answer in Japanese"), and competence ("how good is that
  Japanese") is not the same fact. Deriving a 0..1 from a passing reply puts an
  invented number where a measured one belongs — the price rule again. It
  reports against the claim; a human writes the claim.
- 🔴 **A truncated reply is not evidence.** A thinking model narrates in English
  before answering, so a reply cut off at `max_tokens` contains no answer.
  The first live run of the language probe faulted `minimax-m2.7` for exactly
  this: the probe's own token budget, reported as the model's failure. Grade
  `finish_reason: 'length'` down to `unjudged`, never to a fault.
- 🔴 **Never guess a `maxConcurrent`.** Same rule as prices: an unobserved limit
  throttles real capacity and nothing errors. Absent means unlimited, and that
  is why `providers.default.json` sets none.
- 🔴 **`Number(env['X'] ?? default)` is a bug, not a shorthand.** A var that is
  set but empty — which is what `FOO=` in a `.env` produces — parses as 0, so a
  blank line silently means port 0 and "never queue". Use `intFromEnv`.

## Design decisions worth reading before changing

- **Hard constraints filter, soft preferences weight.** Privacy, capability and
  context are correctness — a model that cannot see an image is not a worse
  choice for a vision request, it is not a choice.
- **A soft signal must never empty the candidate list.** If every breaker is
  open, health is ignored: a probably-down provider beats no provider.
- **400/422 stops the chain** — the same malformed request fails everywhere.
  **401 does fall over**, because the next provider does not share the bad key.
- **A pin overrides the profile's price limit but not its privacy filter.**
  Naming a model must not smuggle confidential text into a public-tier provider.
- **Streaming cannot fall back once bytes are out.** The attempt timeout is
  cleared when headers arrive — leaving it armed truncates long answers at 60s,
  which happened.
- **Quota is reserved at admission and refunded on failure**, so concurrent
  callers cannot both take the last free slot.
- **Rate limits come in two shapes and only one is a window.** `quota` counts
  per minute and per day; `maxConcurrent` counts what is happening now. A
  provider serving one request at a time 429s a fan-out with its per-minute
  budget barely touched.
- **A busy provider is skipped, not waited for.** Queueing while a free
  candidate sits in the chain spends the whole point of the router on patience.
  Only when *every* candidate is busy does the request queue — the
  single-provider case, where a 503 now is worse than an answer in a moment.
- **Concurrency is scoped to the provider, not the candidate.** The limit
  belongs to the credential; keying on `provider/model` would let a two-model
  provider run twice its limit.
- **A streaming answer holds its slot to the last byte**, and teardown hangs off
  the pipe settling rather than off `flush`, which a cancelled stream never
  reaches.
- **A generated entry is disabled, never deleted, when it leaves a catalog.**
  Deleting throws away a hand-written rating and makes the disappearance
  invisible on the next diff — and that disappearance is the event worth seeing.
- **Float dust is a churn bug, not a cosmetic one.** `0.0000002 * 1e6` is
  0.19999999999999998, which diffs against a hand-written 0.2 forever. A sync
  that reports a change every run is one nobody reads.
- **Untried candidates are scored optimistically**, capped by a small margin.
  With a generated registry every term ties and the alphabetical tie-break would
  hand one model all the traffic while the rest were never measured.

## Verification is not optional

`setup` crashed with a raw ENOENT stack trace in the bundle and the single
executable, because it read the registry by path while every other command
falls back to the embedded copy. It is the first command a new user runs, and
the only builds that shipped it were the broken ones. It takes an already
loaded registry as a value now. **A command that breaks only in the distributed
build is caught by nothing except running the distributed build.**


Features that type-check and pass tests still fail when run. Bugs found only by
running it: `process.exit()` discarding piped stdout; `readline/promises` never
settling its second question on a pipe; `import.meta.url` vanishing in a
CommonJS bundle; a setup page that 401'd because browsers do not send URL
fragments; `node.pipe(res)` not destroying its source, so one client hanging up
mid-stream held a `maxConcurrent: 1` provider's slot **indefinitely** while every
unit test passed — the tests cancelled the stream and the server never did.
Run the thing, including through a pipe and inside the container.
