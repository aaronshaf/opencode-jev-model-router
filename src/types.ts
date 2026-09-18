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
  /**
   * If set (>0), refuse downgrades once context exceeds this many tokens.
   * Default null = off (cost-first). Useful for near-parity Claude tiers.
   */
  downgradeMaxContextTokens: number | null;
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

/** How the parent session relates to child subagents. */
export type OrchestrationAction = "stay" | "escalate" | "parallel" | "release";

export type OrchestrationConfig = {
  /** Sticky parent + tool-spawned children (default). */
  mode: "subagents";
  /** Tier whose primary model stays on the parent session. */
  parentTier: Tier;
  maxConcurrentChildren: number;
  /** Jev tiers that should spawn/resume a strong child. */
  escalateOn: Tier[];
  /** Max chars of parent transcript forwarded to a child. */
  delegateMaxContextBytes: number;
  /** Max ms to wait for a child session to go idle. */
  childTimeoutMs: number;
};

export type OrchestratorConfig = {
  enabled: boolean;
  /**
   * When true (global config only), project-level files may override tier
   * models/fallbacks. Default false so a cloned repo cannot remap prompts.
   */
  allowProjectModels: boolean;
  tiers: Record<Tier, TierConfig>;
  routing: RoutingConfig;
  orchestration: OrchestrationConfig;
  quota: QuotaConfig;
  history: HistoryConfig;
  echoRouting: boolean;
};

/** @deprecated Use OrchestratorConfig */
export type RouterConfig = OrchestratorConfig;

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

export type ActionDecision = {
  parentTier: Tier;
  action: OrchestrationAction;
  reason: string;
  /** Escape hatch: mutate parent onto this tier instead of sticking. */
  overrideTier?: Tier;
};

export type DecisionRecord = {
  at: number;
  sessionID: string;
  prompt?: string;
  currentTier: Tier;
  jev: JevAnswer | null;
  metrics?: JevResult["metrics"];
  decision: PolicyDecision;
  action?: OrchestrationAction;
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
