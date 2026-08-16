/**
 * Routing: turn a RouteRequest into a ranked fallback chain.
 *
 * Two rules shape everything here:
 *
 *  1. Hard constraints are filters, soft preferences are weights. Privacy,
 *     capability and context are correctness — a model that cannot see an image
 *     is not "a worse choice" for a vision request, it is not a choice.
 *
 *  2. Never return an empty chain because of a *soft* signal. If every
 *     candidate's breaker is open, health is ignored rather than answering 503:
 *     a probably-down provider still beats a certainly-absent one.
 *
 * Routing does not touch the network and does not consume quota, so it is pure
 * and cheap to unit-test.
 */

import {
  blendedPrice,
  hasCapabilities,
  isFree,
  languageScore,
  maxPrivacyOf,
  servesPrivacy,
  type Registry,
} from './registry.js';
import type { HealthTracker } from './health.js';
import type { Candidate, RouteDecision, Rejection, RouteRequest, ScoredCandidate } from './types.js';

export interface RouterOptions {
  health?: HealthTracker;
}

export class Router {
  constructor(
    private readonly registry: Registry,
    private readonly opts: RouterOptions = {},
  ) {}

  route(req: RouteRequest): RouteDecision {
    const profile = this.registry.profile(req.mesh);
    const privacy = req.privacy ?? 'public';
    const rejected: Rejection[] = [];

    const required = [...(req.capabilities ?? []), ...(profile.requireCapabilities ?? [])];

    let pool: Candidate[] = [];
    for (const c of this.registry.candidates) {
      if (req.pin && c.key !== req.pin) continue;
      if (!servesPrivacy(c, privacy)) {
        rejected.push({
          key: c.key,
          reason: `privacy: needs ${privacy}, serves up to ${maxPrivacyOf(c)}`,
        });
        continue;
      }
      if (!hasCapabilities(c.model, required)) {
        const missing = required.filter((x) => !c.model.capabilities.includes(x));
        rejected.push({ key: c.key, reason: `capability: missing ${missing.join(',')}` });
        continue;
      }
      if (req.minContext !== undefined && c.model.contextWindow < req.minContext) {
        rejected.push({
          key: c.key,
          reason: `context: ${c.model.contextWindow} < ${req.minContext}`,
        });
        continue;
      }
      // Price limits are the profile's *preference*, and a caller who named a
      // specific model has already overridden the profile. Privacy, capability
      // and context above are correctness and still apply — a pin may not be
      // used to smuggle confidential text into a public-tier provider.
      if (!req.pin) {
        if (profile.freeOnly && !isFree(c.model)) {
          rejected.push({ key: c.key, reason: `profile ${profile.name}: not free` });
          continue;
        }
        if (profile.maxPricePerMTok !== undefined && blendedPrice(c.model) > profile.maxPricePerMTok) {
          rejected.push({
            key: c.key,
            reason: `profile ${profile.name}: ${blendedPrice(c.model)} > ${profile.maxPricePerMTok} /MTok`,
          });
          continue;
        }
      }
      pool.push(c);
    }

    if (req.pin && pool.length === 0 && !this.registry.find(req.pin)) {
      rejected.push({ key: req.pin, reason: 'pin: no such provider/model in registry' });
    }

    // Soft filter: drop candidates whose breaker is open, unless that empties
    // the pool — see rule 2 above.
    const health = this.opts.health;
    if (health && pool.length > 0) {
      const healthy = pool.filter((c) => !health.isOpen(c.key));
      if (healthy.length > 0) {
        for (const c of pool) {
          if (!healthy.includes(c)) {
            rejected.push({ key: c.key, reason: `health: breaker open ${health.openFor(c.key)}ms` });
          }
        }
        pool = healthy;
      }
    }

    return { ranked: this.score(pool, req, profile.name), rejected, profile };
  }

  private score(pool: Candidate[], req: RouteRequest, profileName: string): ScoredCandidate[] {
    if (pool.length === 0) return [];
    const profile = this.registry.profile(profileName);
    const w = profile.weights;
    const wsum = w.quality + w.cost + w.latency + w.language || 1;

    const prices = pool.map((c) => blendedPrice(c.model));
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    const health = this.opts.health;
    const latencies = pool.map((c) => health?.latencyMs(c.key) ?? null);
    const known = latencies.filter((l): l is number => l !== null);
    const minLat = known.length ? Math.min(...known) : 0;
    const maxLat = known.length ? Math.max(...known) : 0;

    const scored = pool.map((c, i) => {
      const price = prices[i] as number;
      // Cheaper is better; an all-equal pool contributes a flat 1.
      const costTerm = maxPrice === minPrice ? 1 : 1 - (price - minPrice) / (maxPrice - minPrice);
      const lat = latencies[i] ?? null;
      // An unmeasured candidate sits at the midpoint: neither rewarded for being
      // untried nor punished for it.
      const latTerm = lat === null || maxLat === minLat ? 0.5 : 1 - (lat - minLat) / (maxLat - minLat);
      const langTerm = languageScore(c.model, req.language);
      const qualTerm = c.model.quality;

      const terms = {
        quality: qualTerm,
        cost: costTerm,
        latency: latTerm,
        language: langTerm,
      };
      const score =
        (w.quality * qualTerm + w.cost * costTerm + w.latency * latTerm + w.language * langTerm) /
        wsum;
      return { candidate: c, score, terms };
    });

    // Ties are broken by key so a decision is reproducible across processes.
    scored.sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key));
    return scored;
  }
}
