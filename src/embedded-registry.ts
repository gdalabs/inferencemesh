/**
 * The default registry, compiled into the program.
 *
 * A single-file build has no `providers.default.json` sitting next to it, and
 * neither does a single executable — so the fallback cannot be a path lookup.
 * Importing the JSON makes the bundler inline it and makes `tsc` type-check it,
 * which also means a malformed registry breaks the build rather than the
 * first request after a deploy.
 *
 * `INFERENCEMESH_REGISTRY` still wins when set: this is the floor, not a lock.
 */
import registry from '../providers.default.json' with { type: 'json' };

export const EMBEDDED_REGISTRY: unknown = registry;
