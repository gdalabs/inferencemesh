#!/usr/bin/env node
/**
 * Discover new free-tier inference providers and models.
 *
 * A registry is a snapshot of a market that moves weekly. New entrants give
 * inference away deliberately — it is customer acquisition, not charity — so
 * the best free tier available today is usually one that did not exist when the
 * registry was written. A one-off list is stale the month it ships.
 *
 * Every source here is keyless on purpose. Anything needing a key would stop
 * working the moment that key lapses, which is exactly when you stop noticing.
 *
 *   catalog diff  — a provider's own /v1/models, compared against last run.
 *                   This is the strongest signal: it is primary, machine-
 *                   readable, and catches both additions AND disappearances.
 *   Hacker News   — Algolia's API, for launch announcements.
 *   GitHub        — recently-pushed community lists of free APIs.
 *
 * Deliberately NOT used:
 *   X/Twitter     — needs a paid key here; xAI's Live Search returned HTTP 410
 *                   ("deprecated, switch to the Agent Tools API") on 2026-08-16.
 *   Reddit        — r/LocalLLaMA is the best-signal forum for this, but
 *                   reddit.com returns 403 to this host's IP without OAuth.
 *
 * Findings are candidates, not conclusions. A provider that appears here still
 * has to survive `inferencemesh probe` before it earns a registry entry.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const STATE = process.env.INFERENCEMESH_DISCOVERY_STATE ?? resolve('.inferencemesh/discovery.json');
const DAYS = Number(process.env.INFERENCEMESH_DISCOVERY_DAYS ?? 30);
const JSON_OUT = process.argv.includes('--json');
const FRESH = process.argv.includes('--fresh');

/** Families worth flagging by name, since these are what people ask for. */
const FAMILIES = ['deepseek', 'kimi', 'moonshot', 'minimax', 'glm', 'z-ai', 'zai', 'qwen', 'nemotron'];

/** Public model catalogs. Verified keyless on 2026-08-16. */
const CATALOGS = [
  { id: 'openrouter', url: 'https://openrouter.ai/api/v1/models', freeOnly: true },
  { id: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/models' },
  { id: 'chutes', url: 'https://llm.chutes.ai/v1/models' },
  { id: 'llm7', url: 'https://api.llm7.io/v1/models' },
  { id: 'modelscope', url: 'https://api-inference.modelscope.cn/v1/models' },
  { id: 'ovhcloud', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models' },
];

async function getJson(url, timeoutMs = 25_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'inferencemesh-discovery/0.1 (+https://github.com/gdalabs/inferencemesh)' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

function isFree(m) {
  const p = m.pricing;
  if (!p) return true; // catalogs without pricing say nothing; treat as candidate
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

async function scanCatalogs(prev) {
  const out = [];
  for (const c of CATALOGS) {
    const { data, error } = await getJson(c.url);
    if (error) {
      out.push({ source: c.id, kind: 'error', detail: error });
      continue;
    }
    const list = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
    const ids = list.filter((m) => (c.freeOnly ? isFree(m) : true)).map((m) => m.id).filter(Boolean).sort();
    const before = prev.catalogs?.[c.id] ?? null;

    // A catalog that answered 200 with nothing in it is a broken response far
    // more often than a provider deleting its entire model list. Reporting it
    // as a diff would print every id as GONE and then store the empty list as
    // the new baseline — one bad response, one false alarm, and the real
    // disappearance the next day goes unnoticed because the baseline is gone.
    if (ids.length === 0 && before?.length) {
      out.push({ source: c.id, kind: 'error', detail: 'responded with an empty model list — keeping the previous snapshot' });
      continue;
    }
    if (before === null) {
      out.push({ source: c.id, kind: 'baseline', count: ids.length });
    } else {
      const beforeSet = new Set(before);
      const nowSet = new Set(ids);
      const added = ids.filter((i) => !beforeSet.has(i));
      const removed = before.filter((i) => !nowSet.has(i));
      // A removal is the more urgent finding: something in the registry may now 404.
      if (removed.length) out.push({ source: c.id, kind: 'removed', ids: removed });
      if (added.length) out.push({ source: c.id, kind: 'added', ids: added });
    }
    prev.catalogs = { ...(prev.catalogs ?? {}), [c.id]: ids };
  }
  return out;
}

async function scanHackerNews(prev, sinceUnix) {
  const seen = new Set(prev.hn ?? []);
  const queries = ['free LLM API', 'free inference API', 'free tier LLM'];
  const found = [];
  for (const q of queries) {
    const url =
      'https://hn.algolia.com/api/v1/search_by_date?' +
      new URLSearchParams({ query: q, tags: 'story', numericFilters: `created_at_i>${sinceUnix}` });
    const { data, error } = await getJson(url);
    if (error) {
      found.push({ source: 'hn', kind: 'error', detail: error });
      continue;
    }
    for (const h of data.hits ?? []) {
      if (seen.has(h.objectID)) continue;
      const title = h.title ?? '';
      if (!/free|inference|router|api/i.test(title)) continue;
      seen.add(h.objectID);
      found.push({
        source: 'hn',
        kind: 'story',
        title,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        date: (h.created_at ?? '').slice(0, 10),
        points: h.points ?? 0,
      });
    }
  }
  prev.hn = [...seen].slice(-500);
  return found;
}

/**
 * Recently-updated *curated lists* of free APIs.
 *
 * Sorting by `updated` was tried first and returned chess engines and bookmark
 * apps — anything whose description happens to contain "free" and "AI". The
 * useful repos are the ones other people already vetted, so this sorts by stars
 * and drops everything below MIN_STARS. A noisy monitor is an ignored monitor.
 */
const MIN_STARS = Number(process.env.INFERENCEMESH_DISCOVERY_MIN_STARS ?? 50);

async function scanGitHub(prev, sinceIso) {
  const seen = new Set(prev.gh ?? []);
  const url =
    'https://api.github.com/search/repositories?' +
    new URLSearchParams({ q: `free llm api in:name,description pushed:>${sinceIso}`, sort: 'stars', per_page: '15' });
  const { data, error } = await getJson(url);
  if (error) return [{ source: 'github', kind: 'error', detail: error }];
  const found = [];
  for (const r of data.items ?? []) {
    if ((r.stargazers_count ?? 0) < MIN_STARS) continue;
    if (seen.has(r.full_name)) continue;
    seen.add(r.full_name);
    found.push({
      source: 'github',
      kind: 'repo',
      title: r.full_name,
      url: r.html_url,
      date: (r.pushed_at ?? '').slice(0, 10),
      points: r.stargazers_count ?? 0,
      desc: (r.description ?? '').slice(0, 120),
    });
  }
  prev.gh = [...seen].slice(-300);
  return found;
}

function highlightFamilies(ids) {
  const hits = ids.filter((i) => FAMILIES.some((f) => i.toLowerCase().includes(f)));
  return hits;
}

async function main() {
  let prev = {};
  if (!FRESH) {
    try {
      prev = JSON.parse(await readFile(STATE, 'utf8'));
    } catch {
      /* first run: everything is a baseline, not a finding */
    }
  }
  const sinceUnix = Math.floor(Date.now() / 1000) - DAYS * 86400;
  const sinceIso = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);

  const findings = [
    ...(await scanCatalogs(prev)),
    ...(await scanHackerNews(prev, sinceUnix)),
    ...(await scanGitHub(prev, sinceIso)),
  ];

  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(prev), 'utf8');

  const errors = findings.filter((f) => f.kind === 'error');
  const baselines = findings.filter((f) => f.kind === 'baseline');
  const real = findings.filter((f) => !['error', 'baseline'].includes(f.kind));

  if (JSON_OUT) {
    console.log(JSON.stringify({ scannedAt: new Date().toISOString(), findings }, null, 2));
    return exitCode(real, errors);
  }

  for (const b of baselines) console.log(`baseline  ${b.source}: ${b.count} entries recorded (no diff on a first run)`);
  for (const e of errors) console.log(`ERROR     ${e.source}: ${e.detail}`);

  for (const f of real) {
    if (f.kind === 'added' || f.kind === 'removed') {
      const fam = highlightFamilies(f.ids);
      console.log(`\n${f.kind === 'added' ? 'NEW' : 'GONE'} in ${f.source} (${f.ids.length}):`);
      for (const i of f.ids.slice(0, 25)) {
        console.log(`   ${fam.includes(i) ? '*' : ' '} ${i}`);
      }
      if (f.ids.length > 25) console.log(`   ... and ${f.ids.length - 25} more`);
      if (fam.length) console.log(`   (* = DeepSeek/Kimi/MiniMax/GLM/Qwen family)`);
    } else {
      console.log(`\n${f.source.toUpperCase()}  ${f.date}  ${f.points}pts  ${f.title}\n   ${f.url}` + (f.desc ? `\n   ${f.desc}` : ''));
    }
  }

  console.log(`\n${real.length} new finding(s). Candidates only — confirm with \`inferencemesh probe\` before adding.`);
  return exitCode(real, errors);
}

/**
 * 10 = something to look at. 1 = the run could not look.
 *
 * The distinction only means anything if the second one can actually happen.
 * Every catalog failing used to exit 0 alongside "0 new findings", which reads
 * identically to a quiet week — a monitor reporting that it saw nothing when
 * what it means is that it saw nothing *of anything*. A single flaky source is
 * still exit 0: catalogs go down, and failing the run for one of them is how a
 * scheduled check gets muted.
 */
function exitCode(real, errors) {
  const catalogIds = new Set(CATALOGS.map((c) => c.id));
  const catalogErrors = errors.filter((e) => catalogIds.has(e.source));
  if (catalogErrors.length === catalogIds.size) {
    console.log('\nevery catalog failed — nothing was compared this run.');
    return 1;
  }
  return real.length > 0 ? 10 : 0;
}

// `process.exitCode`, never `process.exit()`.
//
// process.exit terminates before pending stdout writes are flushed, and writes
// to a pipe are asynchronous — so `discover-providers --json | jq` loses the
// tail of its own output. The CLI learned this the expensive way; this file
// was still doing it.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
