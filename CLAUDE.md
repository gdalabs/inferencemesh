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
- `src/mesh.ts` — route, attempt, fall back, book. **The only place allowed to retry.**
- `src/providers/*.ts` — adapters. **Must not retry and must not read the registry.**
- `src/gateway.ts` — Fetch-API handler shared by Node, Workers and Deno.
- `src/setup-ui.ts` — the setup page, as one self-contained string.
- `src/server/node.ts` — Node server, fail-closed auth, key storage.
- `src/cli.ts` — `setup` / `probe` / `route` / `serve`.

## Commands

```sh
npm test                 # build, then 92 tests — no network needed
npm run build
npm run build:binary     # single executable, runs without Node installed
node dist/src/cli.js route free --language=ja   # explain a decision, offline
node dist/src/cli.js probe                      # call every candidate for real
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
- **Untried candidates are scored optimistically**, capped by a small margin.
  With a generated registry every term ties and the alphabetical tie-break would
  hand one model all the traffic while the rest were never measured.

## Verification is not optional

Features that type-check and pass tests still fail when run. Bugs found only by
running it: `process.exit()` discarding piped stdout; `readline/promises` never
settling its second question on a pipe; `import.meta.url` vanishing in a
CommonJS bundle; a setup page that 401'd because browsers do not send URL
fragments. Run the thing, including through a pipe and inside the container.
