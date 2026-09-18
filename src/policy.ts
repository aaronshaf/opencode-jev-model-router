import type {
  ActionDecision,
  JevAnswer,
  OrchestrationAction,
  OrchestrationConfig,
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

/** User asked for parallel mechanical work. */
export function detectParallelIntent(prompt: string | undefined | null): boolean {
  return /\b(?:in parallel|parallelize|jev_parallel|spawn (?:a )?(?:cheap |fast )?subagents?)\b/i.test(
    prompt ?? "",
  );
}

function cheaperTier(a: Tier, b: Tier): Tier {
  return rankOf(a) <= rankOf(b) ? a : b;
}

function dearerTier(a: Tier, b: Tier): Tier {
  return rankOf(a) >= rankOf(b) ? a : b;
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
 * Turns a Jev answer into the tier we will actually run.
 * Kept for override escape hatch and legacy tests; subagent mode uses decideAction.
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

  const ceiling = thresholds.uncertainCeiling;

  // Jev down → hold current (cache-safe).
  if (!jev || !isTier(jev.choice)) {
    return settle(current, "jev-unavailable");
  }

  let target: Tier = jev.choice;
  let reason = "jev";

  if (jev.confidence < thresholds.minimumConfidence) {
    target = cheaperTier(dearerTier(target, current), ceiling);
    reason = "low-confidence";
  } else if (rankOf(target) < rankOf(current) - 1) {
    target = TIER_NAMES[rankOf(current) - 1]!;
    reason = "jev+step-down";
  }

  const stick = thresholds.downgradeMaxContextTokens ?? null;
  if (
    stick != null &&
    Number.isFinite(stick) &&
    stick > 0 &&
    rankOf(target) < rankOf(current) &&
    contextTokens > stick
  ) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, reason);
}

export type DecideActionInput = {
  prompt: string;
  jev: JevAnswer | null;
  parentTier: Tier;
  hasStrongStreak: boolean;
  orchestration: Pick<OrchestrationConfig, "parentTier" | "escalateOn">;
  overridePatterns: OverridePattern[];
  thresholds: Pick<RouterConfig["routing"], "minimumConfidence">;
};

/**
 * Sticky-parent orchestration: stay on cheap parent, or hint escalate/parallel tools.
 * Jev unavailable → stay (hold). Strong streak ends only when Jev says easy again.
 */
export function decideAction(input: DecideActionInput): ActionDecision {
  const {
    prompt,
    jev,
    hasStrongStreak,
    orchestration,
    overridePatterns,
    thresholds,
  } = input;

  const sticky = orchestration.parentTier;
  const override = detectOverride(prompt, overridePatterns);
  if (override) {
    return {
      parentTier: sticky,
      action: "stay",
      reason: "override",
      overrideTier: override,
    };
  }

  if (detectParallelIntent(prompt)) {
    return {
      parentTier: sticky,
      action: "parallel",
      reason: "parallel-intent",
    };
  }

  const easy = (tier: Tier) => !orchestration.escalateOn.includes(tier);

  if (hasStrongStreak) {
    if (
      jev &&
      isTier(jev.choice) &&
      jev.confidence >= thresholds.minimumConfidence
    ) {
      if (easy(jev.choice)) {
        return {
          parentTier: sticky,
          action: "release",
          reason: "jev-easy-again",
        };
      }
      return {
        parentTier: sticky,
        action: "escalate",
        reason: "streak-continue",
      };
    }
    // Unsure / Jev down: release (don't keep burning Luna).
    return {
      parentTier: sticky,
      action: "release",
      reason: !jev ? "streak-release-jev-down" : "streak-release-low-confidence",
    };
  }

  if (!jev || !isTier(jev.choice)) {
    return {
      parentTier: sticky,
      action: "stay",
      reason: "jev-unavailable",
    };
  }

  if (jev.confidence < thresholds.minimumConfidence) {
    return {
      parentTier: sticky,
      action: "stay",
      reason: "low-confidence",
    };
  }

  if (orchestration.escalateOn.includes(jev.choice)) {
    return {
      parentTier: sticky,
      action: "escalate",
      reason: "jev-escalate",
    };
  }

  return {
    parentTier: sticky,
    action: "stay",
    reason: "jev-stay",
  };
}

export function actionHint(
  action: OrchestrationAction,
  userPrompt: string,
): string | null {
  const clipped =
    userPrompt.length > 500 ? `${userPrompt.slice(0, 500)}…` : userPrompt;
  if (action === "escalate") {
    return [
      "[Jev] This turn looks hard. Call the jev_escalate tool with the user's task",
      "(parent context is attached automatically). Do not try to solve it alone",
      "on this cheap parent model.",
      `Task: ${clipped}`,
    ].join(" ");
  }
  if (action === "parallel") {
    return [
      "[Jev] Parallel mechanical work requested. Call jev_parallel (up to 3 children)",
      "for each independent subtask, then merge results.",
      `Task: ${clipped}`,
    ].join(" ");
  }
  return null;
}
