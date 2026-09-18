import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { choice, score } from "@typesafe-ai/sdk";
import type {
  OrchestrationConfig,
  RouterConfig,
  Tier,
  TierConfig,
} from "./types.js";
import { TIER_NAMES } from "./types.js";

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function hasOwn(obj: object, key: string): boolean {
  return Object.hasOwn(obj, key);
}

function omitDangerousKeys(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function looksLikeModelRef(ref: string): boolean {
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1;
}

export const CONTEXT_WINDOW_TOKENS = 200_000;

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
] as const;

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/**
 * Structured System One questions. Abstract tiers stay stable across provider
 * remaps — local config decides which OpenCode models back each tier.
 */
export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    [...COMPLEXITY_SCALE],
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    [...COMPLEXITY_SCALE],
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    [...COMPLEXITY_SCALE],
  ),
  model_tier: choice(
    [
      "Pick the cheapest model tier that can fully complete this coding request in one pass, without a retry on a stronger model.",
      "Judge the reasoning the request demands, not the length of the reply it asks for. A request that wants a one-line answer to a hard debugging or design question still needs a strong model; a request for a long but mechanical edit does not.",
    ],
    {
      fast: {
        what: "Trivial, mechanical, or purely factual work.",
        signals: [
          "Rename a symbol, fix a typo, reformat, add a comment",
          "Answer a short factual question about a known file",
          "Run one obvious command and report the output",
        ],
        not_for: "Anything requiring design judgement or multi-file reasoning.",
      },
      balanced: {
        what: "Ordinary day-to-day engineering with a clear, bounded shape.",
        signals: [
          "Implement a well-specified function, endpoint, or component",
          "Write or fix tests for existing behaviour",
          "Localised bug fix where the cause is already understood",
        ],
        not_for:
          "Open-ended architecture, subtle concurrency, or deep unknown-cause debugging.",
      },
      strong: {
        what: "Hard reasoning, ambiguity, or high blast radius.",
        signals: [
          "Debug a failure whose cause is unknown",
          "Design or refactor across several modules",
          "Security, auth, concurrency, data-migration, or money-handling logic",
        ],
        not_for:
          "Work that a competent mid-level engineer would finish without thinking hard.",
      },
      long: {
        what: "Very large or very long-running tasks that exceed the others' practical reach.",
        signals: [
          "Whole-repo migration or framework upgrade",
          "Task requiring an unusually large amount of context to be held at once",
          "Long autonomous multi-hour execution",
        ],
        not_for:
          "Anything a single focused session on a strong model would finish. Often costs more.",
      },
    },
  ),
};

const DEFAULT_TIERS: Record<Tier, TierConfig> = {
  // Prefer Go's fattest $60 buckets; keep Luna/$15 for hard turns only.
  fast: {
    model: "opencode-go/muse-spark-1.3-contributor",
    aliases: ["fast", "flash", "muse"],
    fallbacks: [
      "opencode-go/glm-5.3-flash",
      "opencode-go/mimo-v2.5",
    ],
  },
  balanced: {
    model: "opencode-go/mimo-v2.5",
    aliases: ["balanced"],
    fallbacks: [
      "opencode-go/muse-spark-1.3-contributor",
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/qwen3.7-plus",
    ],
  },
  strong: {
    model: "opencode-go/gpt-5.6-luna",
    aliases: ["strong", "luna"],
    fallbacks: ["opencode-go/kimi-k2.7-code", "opencode-go/qwen3.7-plus"],
  },
  long: {
    model: "opencode-go/kimi-k3",
    enabled: false,
    aliases: ["long", "kimi", "k3"],
    fallbacks: ["opencode-go/kimi-k2.7-code"],
  },
};

export function defaultConfig(): RouterConfig {
  return {
    enabled: true,
    allowProjectModels: false,
    tiers: structuredClone(DEFAULT_TIERS),
    routing: {
      failOpen: true,
      maxPromptBytes: 16 * 1024,
      timeoutMs: 1500,
      deadlineMs: 3000,
      maxRetries: 1,
      minimumConfidence: 0.3,
      uncertainCeiling: "balanced",
      // Off by default: Go $ buckets are per-model; staying on Luna is costlier.
      downgradeMaxContextTokens: null,
    },
    orchestration: {
      mode: "subagents",
      // Muse: fattest $60 bucket; OK with training/region tradeoffs for sticky parent.
      parentTier: "fast",
      maxConcurrentChildren: 3,
      escalateOn: ["strong", "long"],
      delegateMaxContextBytes: 200_000,
      childTimeoutMs: 300_000,
    },
    quota: {
      cooldownHours: 5,
    },
    history: {
      enabled: true,
      retainPrompt: false,
      maxEntries: 20,
    },
    echoRouting: true,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeTier(
  base: TierConfig,
  overlay: unknown,
  name: Tier,
): TierConfig {
  if (!isPlainObject(overlay)) return base;

  let model = base.model;
  if (hasOwn(overlay, "model")) {
    if (typeof overlay.model !== "string" || !looksLikeModelRef(overlay.model)) {
      throw new Error(`tiers.${name}.model must be a provider/model string`);
    }
    model = overlay.model;
  }

  let fallbacks = base.fallbacks;
  if (hasOwn(overlay, "fallbacks")) {
    if (!Array.isArray(overlay.fallbacks)) {
      throw new Error(`tiers.${name}.fallbacks must be an array of strings`);
    }
    fallbacks = overlay.fallbacks.map((item, i) => {
      if (typeof item !== "string" || !looksLikeModelRef(item)) {
        throw new Error(`tiers.${name}.fallbacks[${i}] must be provider/model`);
      }
      return item;
    });
  }

  let aliases = base.aliases;
  if (hasOwn(overlay, "aliases")) {
    if (!Array.isArray(overlay.aliases)) {
      throw new Error(`tiers.${name}.aliases must be an array of strings`);
    }
    aliases = overlay.aliases.map((item, i) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`tiers.${name}.aliases[${i}] must be a non-empty string`);
      }
      return item.trim();
    });
  }

  let variant = base.variant;
  if (hasOwn(overlay, "variant")) {
    if (typeof overlay.variant !== "string") {
      throw new Error(`tiers.${name}.variant must be a string`);
    }
    variant = overlay.variant;
  }

  let enabled = base.enabled ?? true;
  if (hasOwn(overlay, "enabled")) {
    if (typeof overlay.enabled !== "boolean") {
      throw new Error(`tiers.${name}.enabled must be a boolean`);
    }
    enabled = overlay.enabled;
  }

  return { model, variant, enabled, fallbacks, aliases };
}

function assertInRange(
  label: string,
  value: number,
  min: number,
  max: number,
): void {
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
}

/** Merge a partial JSON config onto defaults. Throws on invalid shape. */
export function parseConfig(raw: unknown): RouterConfig {
  const base = defaultConfig();
  if (raw == null) return base;
  if (!isPlainObject(raw)) throw new Error("config must be a JSON object");

  if (hasOwn(raw, "enabled") && typeof raw.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (hasOwn(raw, "allowProjectModels") && typeof raw.allowProjectModels !== "boolean") {
    throw new Error("allowProjectModels must be a boolean");
  }
  if (hasOwn(raw, "echoRouting") && typeof raw.echoRouting !== "boolean") {
    throw new Error("echoRouting must be a boolean");
  }

  const tiers = { ...base.tiers };
  if (hasOwn(raw, "tiers")) {
    if (!isPlainObject(raw.tiers)) throw new Error("tiers must be an object");
    for (const name of TIER_NAMES) {
      if (hasOwn(raw.tiers, name)) {
        tiers[name] = mergeTier(base.tiers[name], raw.tiers[name], name);
      }
    }
  }

  const routing = { ...base.routing };
  if (hasOwn(raw, "routing")) {
    if (!isPlainObject(raw.routing)) throw new Error("routing must be an object");
    const r = raw.routing;
    if (hasOwn(r, "failOpen") && typeof r.failOpen !== "boolean") {
      throw new Error("routing.failOpen must be a boolean");
    }
    const numbers = {
      maxPromptBytes: [256, 65_536],
      timeoutMs: [200, 10_000],
      deadlineMs: [200, 15_000],
      maxRetries: [0, 3],
      minimumConfidence: [0, 1],
    } as const;
    for (const [key, [min, max]] of Object.entries(numbers)) {
      if (!hasOwn(r, key)) continue;
      const value = r[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`routing.${key} must be a number`);
      }
      assertInRange(`routing.${key}`, value, min, max);
      (routing as Record<string, unknown>)[key] = value;
    }
    if (hasOwn(r, "downgradeMaxContextTokens")) {
      const value = r.downgradeMaxContextTokens;
      if (value === null) {
        routing.downgradeMaxContextTokens = null;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        assertInRange("routing.downgradeMaxContextTokens", value, 1, 10_000_000);
        routing.downgradeMaxContextTokens = value;
      } else {
        throw new Error(
          "routing.downgradeMaxContextTokens must be a positive number or null",
        );
      }
    }
    if (hasOwn(r, "failOpen") && typeof r.failOpen === "boolean") {
      routing.failOpen = r.failOpen;
    }
    if (hasOwn(r, "uncertainCeiling")) {
      if (
        typeof r.uncertainCeiling !== "string" ||
        !(TIER_NAMES as readonly string[]).includes(r.uncertainCeiling)
      ) {
        throw new Error("routing.uncertainCeiling must be a known tier");
      }
      routing.uncertainCeiling = r.uncertainCeiling as Tier;
    }
  }

  const orchestration: OrchestrationConfig = { ...base.orchestration };
  if (hasOwn(raw, "orchestration")) {
    if (!isPlainObject(raw.orchestration)) {
      throw new Error("orchestration must be an object");
    }
    const o = raw.orchestration;
    if (hasOwn(o, "mode")) {
      if (o.mode !== "subagents") {
        throw new Error('orchestration.mode must be "subagents"');
      }
      orchestration.mode = "subagents";
    }
    if (hasOwn(o, "parentTier")) {
      if (
        typeof o.parentTier !== "string" ||
        !(TIER_NAMES as readonly string[]).includes(o.parentTier)
      ) {
        throw new Error("orchestration.parentTier must be a known tier");
      }
      orchestration.parentTier = o.parentTier as Tier;
    }
    if (hasOwn(o, "maxConcurrentChildren")) {
      if (
        typeof o.maxConcurrentChildren !== "number" ||
        !Number.isFinite(o.maxConcurrentChildren)
      ) {
        throw new Error("orchestration.maxConcurrentChildren must be a number");
      }
      assertInRange("orchestration.maxConcurrentChildren", o.maxConcurrentChildren, 1, 10);
      orchestration.maxConcurrentChildren = o.maxConcurrentChildren;
    }
    if (hasOwn(o, "escalateOn")) {
      if (!Array.isArray(o.escalateOn)) {
        throw new Error("orchestration.escalateOn must be an array of tiers");
      }
      orchestration.escalateOn = o.escalateOn.map((item, i) => {
        if (
          typeof item !== "string" ||
          !(TIER_NAMES as readonly string[]).includes(item)
        ) {
          throw new Error(`orchestration.escalateOn[${i}] must be a known tier`);
        }
        return item as Tier;
      });
    }
    if (hasOwn(o, "delegateMaxContextBytes")) {
      if (
        typeof o.delegateMaxContextBytes !== "number" ||
        !Number.isFinite(o.delegateMaxContextBytes)
      ) {
        throw new Error("orchestration.delegateMaxContextBytes must be a number");
      }
      assertInRange(
        "orchestration.delegateMaxContextBytes",
        o.delegateMaxContextBytes,
        1024,
        2_000_000,
      );
      orchestration.delegateMaxContextBytes = o.delegateMaxContextBytes;
    }
    if (hasOwn(o, "childTimeoutMs")) {
      if (
        typeof o.childTimeoutMs !== "number" ||
        !Number.isFinite(o.childTimeoutMs)
      ) {
        throw new Error("orchestration.childTimeoutMs must be a number");
      }
      assertInRange("orchestration.childTimeoutMs", o.childTimeoutMs, 5_000, 3_600_000);
      orchestration.childTimeoutMs = o.childTimeoutMs;
    }
  }

  const history = { ...base.history };
  if (hasOwn(raw, "history")) {
    if (!isPlainObject(raw.history)) throw new Error("history must be an object");
    const h = raw.history;
    if (hasOwn(h, "enabled") && typeof h.enabled !== "boolean") {
      throw new Error("history.enabled must be a boolean");
    }
    if (hasOwn(h, "retainPrompt") && typeof h.retainPrompt !== "boolean") {
      throw new Error("history.retainPrompt must be a boolean");
    }
    if (hasOwn(h, "maxEntries")) {
      if (typeof h.maxEntries !== "number" || !Number.isFinite(h.maxEntries)) {
        throw new Error("history.maxEntries must be a number");
      }
      assertInRange("history.maxEntries", h.maxEntries, 1, 200);
      history.maxEntries = h.maxEntries;
    }
    if (typeof h.enabled === "boolean") history.enabled = h.enabled;
    if (typeof h.retainPrompt === "boolean") history.retainPrompt = h.retainPrompt;
  }

  const quota = { ...base.quota };
  if (hasOwn(raw, "quota")) {
    if (!isPlainObject(raw.quota)) throw new Error("quota must be an object");
    if (hasOwn(raw.quota, "cooldownHours")) {
      if (
        typeof raw.quota.cooldownHours !== "number" ||
        !Number.isFinite(raw.quota.cooldownHours)
      ) {
        throw new Error("quota.cooldownHours must be a number");
      }
      assertInRange("quota.cooldownHours", raw.quota.cooldownHours, 0.1, 168);
      quota.cooldownHours = raw.quota.cooldownHours;
    }
  }

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    allowProjectModels:
      typeof raw.allowProjectModels === "boolean"
        ? raw.allowProjectModels
        : base.allowProjectModels,
    tiers,
    routing,
    orchestration,
    quota,
    history,
    echoRouting:
      typeof raw.echoRouting === "boolean" ? raw.echoRouting : base.echoRouting,
  };
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as unknown;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

function omitSchemaKey(value: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = omitDangerousKeys(value);
  return rest;
}

/** Project files may not remap models unless the global config allows it. */
function sanitizeProjectOverlay(
  raw: Record<string, unknown>,
  allowModels: boolean,
): Record<string, unknown> {
  const clean = omitSchemaKey(raw);
  // allowProjectModels is global-only — ignore if a project tries to set it.
  delete clean.allowProjectModels;
  if (allowModels || !isPlainObject(clean.tiers)) return clean;

  const tiers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(clean.tiers)) {
    if (DANGEROUS_KEYS.has(name) || !isPlainObject(value)) continue;
    const safe = omitDangerousKeys(value);
    const { model: _m, fallbacks: _f, variant: _v, ...rest } = safe;
    tiers[name] = rest;
  }
  return { ...clean, tiers };
}

/**
 * Load orchestrator config. Later files override earlier ones.
 * Search: defaults → ~/.config/opencode → project .opencode → project root.
 */
export async function loadConfig(
  directory: string,
  opts: { homedir?: string } = {},
): Promise<RouterConfig> {
  const home = opts.homedir ?? homedir();
  const name = "opencode-jev-orchestrator.json";
  const globalPaths = [join(home, ".config", "opencode", name)];
  const projectPaths = [
    join(directory, ".opencode", name),
    join(directory, name),
  ];

  let merged: Record<string, unknown> = Object.create(null);
  for (const path of globalPaths) {
    const raw = await readJsonIfExists(path);
    if (raw === undefined) continue;
    if (!isPlainObject(raw)) throw new Error(`Invalid config at ${path}`);
    merged = deepMerge(merged, omitSchemaKey(raw));
  }

  const allowProjectModels = merged.allowProjectModels === true;

  for (const path of projectPaths) {
    const raw = await readJsonIfExists(path);
    if (raw === undefined) continue;
    if (!isPlainObject(raw)) throw new Error(`Invalid config at ${path}`);
    merged = deepMerge(
      merged,
      sanitizeProjectOverlay(raw, allowProjectModels),
    );
  }

  return parseConfig(merged);
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(
        out[key] as Record<string, unknown>,
        omitDangerousKeys(value),
      );
    } else if (isPlainObject(value)) {
      out[key] = omitDangerousKeys(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
