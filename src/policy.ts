import type {
  JevAnswer,
  PolicyDecision,
  RouterConfig,
  Tier,
} from "./types.js";
import { TIER_NAMES, isTier, rankOf } from "./types.js";

export type OverridePattern = { tier: Tier; re: RegExp };

/** Build override matchers from enabled tiers' aliases. */
export function buildOverridePatterns(
  tiers: RouterConfig["tiers"],
): OverridePattern[] {
  const patterns: OverridePattern[] = [];
  for (const name of TIER_NAMES) {
    if (tiers[name]?.enabled === false) continue;
    const aliases = tiers[name]?.aliases ?? [name];
    const unique = [...new Set(aliases.map((a) => a.trim()).filter(Boolean))];
    if (!unique.length) continue;
    const alt = unique.map(escapeRegExp).join("|");
    // "use|switch to" only — avoid "focus on long" / "with fast refresh".
    // Require end, punctuation, or "to/for …" after the alias so
    // "use strong typing" and "use fast-glob" do not match.
    patterns.push({
      tier: name,
      re: new RegExp(
        `\\b(?:use|switch to)\\s+(?:${alt})(?![\\w-])(?:\\s+model)?(?:\\s+please)?(?=\\s+to\\b|\\s+for\\b|[.,;:!?]|\\s*$)`,
        "i",
      ),
    });
  }
  return patterns;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(
  prompt: string | undefined | null,
  patterns: OverridePattern[],
): Tier | null {
  const hit = patterns.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest runnable tier.
 * - If the tier is config-available but not eligible (quota), step **down**.
 * - If the tier is not config-available, step **up** (never into `long` unless asked).
 */
export function clampToAvailable(
  tier: Tier,
  eligible: Tier[],
  configAvailable: Tier[],
): Tier | null {
  if (eligible.includes(tier)) return tier;
  const rank = rankOf(tier);

  if (configAvailable.includes(tier)) {
    const down = TIER_NAMES.filter((t, i) => i < rank && eligible.includes(t));
    return down.length ? down[down.length - 1]! : null;
  }

  const up = TIER_NAMES.filter(
    (t, i) => i > rank && eligible.includes(t) && (t !== "long" || tier === "long"),
  );
  if (up.length) return up[0]!;
  const down = TIER_NAMES.filter((t, i) => i < rank && eligible.includes(t));
  return down.length ? down[down.length - 1]! : null;
}

export type DecideInput = {
  prompt: string;
  jev: JevAnswer | null;
  current: Tier;
  /** Tiers with at least one non-exhausted model. */
  available: Tier[];
  /** Tiers enabled/valid ignoring quota. */
  configAvailable: Tier[];
  contextTokens?: number;
  overridePatterns: OverridePattern[];
  thresholds: Pick<
    RouterConfig["routing"],
    "minimumConfidence" | "uncertainCeiling" | "downgradeMaxContextTokens"
  >;
};

/**
 * Turns a Jev answer into the tier we will actually run. Pure and total: any
 * missing, malformed, or unavailable input falls back to the model already in use.
 */
export function decide(input: DecideInput): PolicyDecision {
  const {
    prompt,
    jev,
    current,
    available,
    configAvailable,
    contextTokens = 0,
    overridePatterns,
    thresholds,
  } = input;

  const settle = (tier: Tier, reason: string): PolicyDecision => {
    const final =
      clampToAvailable(tier, available, configAvailable) ?? current;
    let why = reason;
    if (final !== tier) {
      why = configAvailable.includes(tier)
        ? `${reason}+quota-down`
        : `${reason}+unavailable`;
    }
    if (final === current && available.length === 0) {
      why = "quota-exhausted/no-change";
    } else if (final === current) {
      why = `${why}/no-change`;
    }
    return {
      tier: final,
      reason: why,
      changed: final !== current,
    };
  };

  const override = detectOverride(prompt, overridePatterns);
  if (override) return settle(override, "override");

  if (!available.length) {
    return { tier: current, reason: "quota-exhausted/no-change", changed: false };
  }

  if (!jev || !isTier(jev.choice)) return settle(current, "jev-unavailable");

  let target: Tier = jev.choice;

  if (jev.confidence < thresholds.minimumConfidence) {
    if (rankOf(target) < rankOf(current)) {
      return settle(current, "low-confidence-no-downgrade");
    }
    const ceiling = Math.max(
      rankOf(current),
      rankOf(thresholds.uncertainCeiling),
    );
    if (rankOf(target) > ceiling) {
      return settle(TIER_NAMES[ceiling]!, "low-confidence-capped");
    }
  }

  if (
    rankOf(target) < rankOf(current) &&
    contextTokens > thresholds.downgradeMaxContextTokens
  ) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "jev");
}
