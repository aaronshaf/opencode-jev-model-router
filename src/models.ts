import type { ModelRef, RouterConfig, Tier } from "./types.js";
import { TIER_NAMES } from "./types.js";
import type { QuotaStore } from "./quota.js";
import { orderCandidatesForSchedule } from "./schedule.js";

/**
 * Parse an OpenCode model ref. Split only on the first slash so OpenRouter-style
 * IDs like `openrouter/deepseek/deepseek-v3.2` keep the rest intact.
 */
export function parseModelRef(ref: string): ModelRef | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return {
    providerID: ref.slice(0, slash),
    modelID: ref.slice(slash + 1),
  };
}

export function formatModelRef(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}`;
}

export type KnownModels = Set<string> | undefined;

function isKnown(ref: string, known: KnownModels): boolean {
  return !known || known.has(ref);
}

/** All configured model refs for a tier (primary + fallbacks). */
export function tierCandidates(config: RouterConfig, tier: Tier): string[] {
  const tierConfig = config.tiers[tier];
  if (!tierConfig || tierConfig.enabled === false) return [];
  const out: string[] = [];
  if (tierConfig.model) out.push(tierConfig.model);
  for (const fb of tierConfig.fallbacks ?? []) {
    if (fb && !out.includes(fb)) out.push(fb);
  }
  return out;
}

/** Every model the router manages (for pin detection). */
export function managedModelSet(config: RouterConfig): Set<string> {
  const set = new Set<string>();
  for (const name of TIER_NAMES) {
    for (const ref of tierCandidates(config, name)) set.add(ref);
  }
  return set;
}

export function isManagedModel(
  config: RouterConfig,
  model: { providerID: string; modelID: string } | undefined,
): boolean {
  if (!model) return false;
  return managedModelSet(config).has(formatModelRef(model));
}

export type SelectOptions = {
  known?: KnownModels;
  quota?: QuotaStore;
  now?: number;
  /** Wall clock for peak/off-peak reordering (defaults to new Date(now)). */
  at?: Date;
};

/**
 * Resolve a tier to the first eligible concrete model (primary then fallbacks).
 * During DeepSeek peak hours, non-DeepSeek candidates are tried first.
 */
export function modelForTier(
  config: RouterConfig,
  tier: Tier,
  opts: SelectOptions = {},
): { model: ModelRef; usedFallback: boolean } | undefined {
  const tierConfig = config.tiers[tier];
  if (!tierConfig || tierConfig.enabled === false) return undefined;
  const at =
    opts.at ??
    (typeof opts.now === "number" ? new Date(opts.now) : new Date());
  const candidates = orderCandidatesForSchedule(tierCandidates(config, tier), at);
  const primary = tierConfig.model;
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = candidates[i]!;
    const parsed = parseModelRef(raw);
    if (!parsed) continue;
    if (!isKnown(raw, opts.known)) continue;
    if (opts.quota?.isExhausted(raw, opts.now)) continue;
    const model = tierConfig.variant
      ? { ...parsed, variant: tierConfig.variant }
      : parsed;
    return { model, usedFallback: raw !== primary };
  }
  return undefined;
}

/** Infer which configured tier a model belongs to (primary preferred over fallback). */
export function tierOfModel(
  config: RouterConfig,
  model: { providerID: string; modelID: string } | undefined,
  fallback: Tier = "balanced",
): Tier {
  if (!model) return fallback;
  const ref = formatModelRef(model);

  for (const name of TIER_NAMES) {
    if (config.tiers[name]?.model === ref) return name;
  }
  for (const name of TIER_NAMES) {
    const fallbacks = config.tiers[name]?.fallbacks ?? [];
    if (fallbacks.includes(ref)) return name;
  }
  for (const name of TIER_NAMES) {
    for (const candidate of tierCandidates(config, name)) {
      const parsed = parseModelRef(candidate);
      if (parsed && parsed.modelID === model.modelID) return name;
    }
  }
  return fallback;
}

/** Tiers that are enabled and have a parseable primary (ignores quota). */
export function configAvailableTiers(
  config: RouterConfig,
  known?: KnownModels,
): Tier[] {
  return TIER_NAMES.filter((name) => {
    const tier = config.tiers[name];
    if (!tier || tier.enabled === false) return false;
    const primary = parseModelRef(tier.model);
    if (!primary) return false;
    if (known && !known.has(tier.model)) {
      // Primary unknown — still config-available if a fallback is known
      return (tier.fallbacks ?? []).some((fb) => known.has(fb));
    }
    return true;
  });
}

/** Tiers that currently have at least one eligible (non-exhausted) model. */
export function resolveAvailableTiers(
  config: RouterConfig,
  opts: SelectOptions = {},
): Tier[] {
  return TIER_NAMES.filter(
    (name) => modelForTier(config, name, opts) !== undefined,
  );
}

/** True when `model` is still a non-exhausted, known candidate for `tier`. */
export function isEligibleCandidate(
  config: RouterConfig,
  tier: Tier,
  model: { providerID: string; modelID: string },
  opts: SelectOptions = {},
): boolean {
  const ref = formatModelRef(model);
  if (!tierCandidates(config, tier).includes(ref)) return false;
  if (!isKnown(ref, opts.known)) return false;
  if (opts.quota?.isExhausted(ref, opts.now)) return false;
  return true;
}
