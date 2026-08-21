/**
 * Registry generation: a provider's own catalog in, registry entries out.
 *
 * `providers.default.json` is hand-maintained and covers a fraction of what is
 * reachable. Curating model by model does not scale, and worse, it rots — a
 * hand-written price is a claim about a day that has passed.
 *
 * The fix is not to write more entries but to stop writing the parts a machine
 * already knows. A provider's `/v1/models` is primary, machine-readable, and
 * current by construction: it knows what exists, what it costs, how much
 * context it has, and what it accepts.
 *
 * ## What sync will not do
 *
 * A catalog knows a model's price. It does not know whether the model is any
 * good, or whether it can hold a conversation in Japanese. `quality` and
 * `languages` are human judgements, and generating a plausible number for them
 * would silently reorder the `best` profile and mis-serve every non-English
 * caller — the same failure as an unverified price, with no invoice to catch
 * it. So sync leaves them alone: absent on a new entry, untouched on an
 * existing one.
 *
 * That split is the whole design. Machine facts are refreshed on every run;
 * human judgement is preserved across every run.
 */

import type { Capability, ModelEntry, Price, PrivacyLevel } from './types.js';
import { PRIVACY_ORDER } from './types.js';

/** One model as a catalog describes it, normalised across providers. */
export interface CatalogModel {
  id: string;
  label?: string;
  capabilities: Capability[];
  /**
   * True when the catalog listed no capability information at all, as opposed
   * to listing some and omitting others.
   *
   * The difference matters: absent is not the same as denied. RedPill lists 14
   * models with no declared parameters, six of them TEE-hosted, and at least
   * one of those (`deepseek/deepseek-v4-flash-0731`) answers perfectly well.
   * Recording "no tools" for it would be a claim nobody made.
   */
  undeclared: boolean;
  contextWindow: number;
  price: Price;
  /** Set only when the catalog carries evidence about it. */
  maxPrivacy?: PrivacyLevel;
  /** One line for a human reading the generated file. */
  note?: string;
}

export type SyncChangeKind =
  | 'added'
  | 'vanished'
  | 'returned'
  | 'repriced'
  | 'context'
  | 'capabilities'
  | 'privacy-evidence';

export interface SyncChange {
  kind: SyncChangeKind;
  id: string;
  detail: string;
}

export interface SyncResult {
  models: ModelEntry[];
  changes: SyncChange[];
  /** Things a human should look at, that are not changes. */
  warnings: string[];
  /**
   * Findings that must not scroll past — the file now permits more sensitive
   * traffic than the provider's own catalog supports. A scheduled sync should
   * fail on these rather than report them.
   */
  hazards: string[];
}

function samePrice(a: Price, b: Price): boolean {
  return a.inPerMTok === b.inPerMTok && a.outPerMTok === b.outPerMTok;
}

function fmtPrice(p: Price): string {
  return `$${p.inPerMTok}/$${p.outPerMTok} per MTok`;
}

/**
 * Merge a freshly read catalog into the entries already on disk.
 *
 * `today` is passed in rather than read from the clock so a sync is
 * reproducible and testable, and so a caller can stamp a batch consistently.
 */
export function syncModels(
  existing: ModelEntry[],
  catalog: CatalogModel[],
  today: string,
): SyncResult {
  const changes: SyncChange[] = [];
  const warnings: string[] = [];
  const hazards: string[] = [];
  const byId = new Map(existing.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const models: ModelEntry[] = [];

  for (const found of catalog) {
    seen.add(found.id);
    const prior = byId.get(found.id);

    if (found.undeclared) {
      warnings.push(
        `${found.id}: the catalog declares no capabilities, so only 'text' is recorded. ` +
          `It may well support tools or vision — absent is not denied. Probe it and add them by hand.`,
      );
    }

    if (!prior) {
      const entry: ModelEntry = {
        id: found.id,
        ...(found.label ? { label: found.label } : {}),
        capabilities: found.capabilities,
        contextWindow: found.contextWindow,
        price: found.price,
        // Stamped because the catalog *is* the provider's own pricing page,
        // read today. This is the one field sync can honestly keep current.
        ...(found.price.inPerMTok !== 0 || found.price.outPerMTok !== 0
          ? { priceVerifiedAt: today }
          : {}),
        ...(found.maxPrivacy
          ? { maxPrivacy: found.maxPrivacy, evidencePrivacy: found.maxPrivacy }
          : {}),
        ...(found.note ? { note: found.note } : {}),
        // `quality` and `languages` are deliberately absent. See the file header.
      };
      models.push(entry);
      changes.push({
        kind: 'added',
        id: found.id,
        detail: `${fmtPrice(found.price)}, ctx ${found.contextWindow}, unrated`,
      });
      continue;
    }

    const next: ModelEntry = { ...prior };

    if (!samePrice(prior.price, found.price)) {
      changes.push({
        kind: 'repriced',
        id: found.id,
        detail: `${fmtPrice(prior.price)} -> ${fmtPrice(found.price)}`,
      });
    }
    next.price = found.price;
    if (found.price.inPerMTok !== 0 || found.price.outPerMTok !== 0) {
      next.priceVerifiedAt = today;
    } else {
      delete next.priceVerifiedAt;
    }

    if (prior.contextWindow !== found.contextWindow) {
      changes.push({
        kind: 'context',
        id: found.id,
        detail: `${prior.contextWindow} -> ${found.contextWindow}`,
      });
      next.contextWindow = found.contextWindow;
    }

    // A catalog that says nothing must not erase what a human recorded after
    // probing. Only an actual declaration is allowed to overwrite.
    if (!found.undeclared) {
      const before = [...prior.capabilities].sort().join(',');
      const after = [...found.capabilities].sort().join(',');
      if (before !== after) {
        changes.push({ kind: 'capabilities', id: found.id, detail: `${before} -> ${after}` });
        next.capabilities = found.capabilities;
      }
    }

    // `maxPrivacy` is left exactly as the file has it. Only the record of what
    // the catalog supports is refreshed, and only a change in *that* is news.
    if (found.maxPrivacy) {
      if (prior.evidencePrivacy && prior.evidencePrivacy !== found.maxPrivacy) {
        changes.push({
          kind: 'privacy-evidence',
          id: found.id,
          detail: `catalog now supports ${found.maxPrivacy}, previously ${prior.evidencePrivacy}`,
        });
      }
      const evidenceMoved =
        prior.evidencePrivacy !== undefined && prior.evidencePrivacy !== found.maxPrivacy;
      next.evidencePrivacy = found.maxPrivacy;

      const effective = prior.maxPrivacy;
      const aboveEvidence =
        effective !== undefined && PRIVACY_ORDER[effective] > PRIVACY_ORDER[found.maxPrivacy];
      if (aboveEvidence) {
        // Signed off, and the ground has not shifted since: stay quiet. A
        // report that is red every single run for a decision made on purpose
        // is a report nobody reads by the third week.
        if (prior.privacyVerifiedAt && !evidenceMoved) {
          warnings.push(
            `${found.id}: kept at ${effective as string}, above the catalog's ` +
              `${found.maxPrivacy}, on a check dated ${prior.privacyVerifiedAt}.`,
          );
        } else {
          hazards.push(
            `${found.id}: the file allows ${effective as string} but the catalog only supports ` +
              `${found.maxPrivacy} (${found.note ?? 'no note'})` +
              (evidenceMoved
                ? ` — and that support just changed, so any earlier sign-off is stale.`
                : ` and nothing records who checked.`) +
              ` Set privacyVerifiedAt once you have confirmed it, or lower maxPrivacy. ` +
              `sync will not overwrite it: that would erase the decision instead of surfacing it.`,
          );
        }
      }
    }

    if (prior.disabled) {
      changes.push({
        kind: 'returned',
        id: found.id,
        detail: `back in the catalog but disabled here — re-enable by hand if you want it`,
      });
    }
    if (found.label && !prior.label) next.label = found.label;
    // Machine-owned: it describes what the catalog says today, so it is
    // replaced rather than preserved.
    if (found.note) next.note = found.note;
    else delete next.note;

    models.push(next);
  }

  for (const old of existing) {
    if (seen.has(old.id)) continue;
    // Kept, not deleted. Deleting would throw away a hand-written quality
    // rating and make the disappearance invisible on the next diff — and a
    // model leaving a catalog is exactly the event worth seeing.
    if (!old.disabled) {
      changes.push({
        kind: 'vanished',
        id: old.id,
        detail: 'no longer in the catalog — disabled, not deleted',
      });
    }
    models.push({ ...old, disabled: true });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, changes, warnings, hazards };
}
