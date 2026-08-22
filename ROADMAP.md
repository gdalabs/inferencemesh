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
- **Language evidence in the registry.** `probe --language=<tag>` now measures
  whether a model answers in the language it was asked in, and reports that
  against what `languages` claims (2026-08-22). What it does not do is write
  anything: compliance is not competence, so there is still no measured number
  behind a `languages` score, only a check that an existing claim is not flatly
  contradicted. Feeding real ratings in needs a source that measures quality —
  see *Rate what sync cannot* below — and until then the honest shape is
  evidence stored beside the human score, the way `evidencePrivacy` is, rather
  than merged into it.
- **A judge for the script pairs that have no distinguishing letter.** Ukrainian
  under `ru` and Persian under `ar` are now separated by the letters exclusive
  to each (і/ї/є/ґ, پ/چ/ژ/گ), so a reply in the wrong one no longer confirms a
  claim. Hindi and Marathi share Devanagari with no such letter — separating
  them needs vocabulary, not an alphabet — and Belarusian is not separated from
  Ukrainian because nobody has asked for `be`. Those stay `match`-on-script,
  which is the remaining known way this can be wrong rather than silent.
- **Native probe prompts for the newer scripts.** he/el/hy/ka/bn/ta can be
  judged but are asked in English, which measures instruction-following rather
  than the language. A prompt written in a language nobody here can check is an
  instrument nobody can verify, so these need a speaker, not a guess.
- **Prebuilt binaries.** `npm run build:binary` produces a working executable,
  but one platform at a time. CI should build macOS arm64/x64, Linux x64/arm64
  and Windows, publish them to Releases, and back an `install.sh`.

## Next

- **More catalogs for `sync`.** RedPill (68 models, with privacy evidence) and
  OpenRouter (keyless, free-tier only, 22 of 421 models) are wired up. NVIDIA,
  Chutes, ModelScope and OVHcloud need a reader each. The free-tier policy is
  now per catalog: OpenRouter is read free-only because the registry provider
  it fills *is* the free tier, and `cmdSync` still refuses to write any paid
  entry into `providers.default.json` whatever the catalog says.
- **Probe before adopting what OpenRouter's catalog offers.** The reader finds
  18 free models that are not in the shipped registry (thinkingmachines,
  poolside, cohere, z-ai, liquid, more nvidia). None may be added until
  `probe` has actually reached them — on 2026-08-16 both `:free` ids in the
  first draft had already left the free tier. That run needs a key, so it is a
  deliberate step, not part of a sync.
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
