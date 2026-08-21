# Roadmap

## Now

- **Observed concurrency limits.** The semaphore exists (`maxConcurrent`, see
  the README), but no provider in `providers.default.json` sets one, because
  none has been measured. A number nobody has observed would throttle real
  capacity on a guess. `probe` could find it: raise the parallelism until 429s
  arrive in a burst rather than at a steady rate, and record the level with the
  date it was measured, the way prices are.

  One lead already: on 2026-08-20 `llm7` answered a second in-flight request
  with `429 Too many concurrent requests for this client. Retry after 10
  seconds.` — it enforces a concurrency limit and says so in words, but not
  what the limit is. That number has to be found by climbing, not read.
- **Measured language competence.** `languages` scores are hand-written
  estimates today, which does not scale to a generated registry and is the wrong
  way round for non-English users — the thing that matters most is the thing
  being guessed. `probe --language=ja` could measure whether a model actually
  replies in the requested language and feed that in.
- **Prebuilt binaries.** `npm run build:binary` produces a working executable,
  but one platform at a time. CI should build macOS arm64/x64, Linux x64/arm64
  and Windows, publish them to Releases, and back an `install.sh`.

## Next

- **More catalogs for `sync`.** The generator exists and RedPill is wired up
  (68 models, prices and privacy evidence read from the provider itself). The
  other five public catalogs — OpenRouter, NVIDIA, Chutes, ModelScope, OVHcloud
  — need a reader each, plus a policy for whether a given catalog is free-tier
  only, since `providers.default.json` may not take paid entries.
- **Rate what sync cannot.** A generated entry is unrated and scores neutrally.
  That is honest but it makes `best` meaningless across a large generated
  registry. Ratings have to come from somewhere measurable — a held-out eval, or
  a public leaderboard mapped onto model ids with the date it was read.
- **Publish what discovery finds.** `scripts/discover-providers.mjs` reports to
  whoever runs it. The information gap it addresses is public, so the output
  should be too.
- **KV-backed ledger for Workers.** The in-memory default resets with the
  isolate, which under-counts against daily caps.
- **Tool calling for the Gemini adapter.** OpenAI-compatible providers pass tools
  through today; the native Gemini adapter does not translate them yet.
- **Embeddings and rerank.** Present in the capability type, absent from adapters.

## Non-goals

- **Automatic fallback to paid models.** Exhausted free tiers return an error.
  Someone learning on a free tier must not be able to turn a mistake into a bill.
- **A hosted service that holds your keys.** Keys stay on the machine that runs
  the gateway. There is no server-side component and no `get` on `KeyStore`.
