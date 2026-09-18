/** Abstract capability tiers, cheapest first. */
export const TIER_NAMES = ["fast", "balanced", "strong", "long"] as const;

export type Tier = (typeof TIER_NAMES)[number];

export type ModelRef = {
  providerID: string;
  modelID: string;
  variant?: string;
};

export type TierConfig = {
  model: string;
  variant?: string;
  enabled?: boolean;
  /** Alternate models when primary is invalid or quota-exhausted. */
  fallbacks?: string[];
  /** Prompt override aliases, e.g. ["luna"] for strong. */
  aliases?: string[];
};

export type RoutingConfig = {
  failOpen: boolean;
  maxPromptBytes: number;
  timeoutMs: number;
  deadlineMs: number;
  maxRetries: number;
  minimumConfidence: number;
  uncertainCeiling: Tier;
  downgradeMaxContextTokens: number;
};

export type QuotaConfig = {
  /** Hours to skip a model after a detected quota error (default 5). */
  cooldownHours: number;
};

export type HistoryConfig = {
  enabled: boolean;
  retainPrompt: boolean;
  maxEntries: number;
};

export type RouterConfig = {
  enabled: boolean;
  /**
   * When true (global config only), project-level files may override tier
   * models/fallbacks. Default false so a cloned repo cannot remap prompts.
   */
  allowProjectModels: boolean;
  tiers: Record<Tier, TierConfig>;
  routing: RoutingConfig;
  quota: QuotaConfig;
  history: HistoryConfig;
  echoRouting: boolean;
};

export type JevAnswer = {
  choice: string;
  confidence: number;
};

export type JevResult = JevAnswer & {
  metrics: {
    taskComplexity: number;
    reasoningRequired: number;
    toolComplexity: number;
    contextSize: number;
  };
  ms: number;
};

export type PolicyDecision = {
  tier: Tier;
  reason: string;
  changed: boolean;
};

export type DecisionRecord = {
  at: number;
  sessionID: string;
  prompt?: string;
  currentTier: Tier;
  jev: JevAnswer | null;
  metrics?: JevResult["metrics"];
  decision: PolicyDecision;
  model?: string;
  usedFallback?: boolean;
  latencyMs?: number;
};

export function isTier(value: string): value is Tier {
  return (TIER_NAMES as readonly string[]).includes(value);
}

export function rankOf(name: string): number {
  return (TIER_NAMES as readonly string[]).indexOf(name);
}
