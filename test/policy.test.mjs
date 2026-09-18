import test from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  decideAction,
  detectOverride,
  detectParallelIntent,
  buildOverridePatterns,
} from "../dist/policy.js";
import { QUESTIONS, defaultConfig } from "../dist/config.js";

const config = defaultConfig();
const patterns = buildOverridePatterns(config.tiers);
const ALL = ["fast", "balanced", "strong", "long"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const thresholds = config.routing;
const base = {
  prompt: "refactor the parser",
  current: "balanced",
  available: ALL,
  configAvailable: ALL,
  contextTokens: 0,
  overridePatterns: patterns,
  thresholds,
};

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("strong") }), {
    tier: "strong",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({
    ...base,
    prompt: "use fast to fix this typo",
    jev: sure("strong"),
  });
  assert.equal(out.tier, "fast");
  assert.equal(out.reason, "override");
});

test("use luna maps to strong on Go defaults", () => {
  assert.equal(detectOverride("use luna", patterns), "strong");
  assert.equal(detectOverride("switch to strong", patterns), "strong");
  assert.equal(detectOverride("use muse", patterns), "fast");
  assert.equal(detectOverride("use balanced", patterns), "balanced");
  assert.equal(detectOverride("the opus of his career", patterns), null);
  assert.equal(detectOverride("use deepseek for embeddings", patterns), null);
  assert.equal(detectOverride("use spark to process parquet", patterns), null);
});

test("override ignores casual phrasing", () => {
  assert.equal(detectOverride("focus on long functions", patterns), null);
  assert.equal(detectOverride("use strong typing throughout", patterns), null);
  assert.equal(detectOverride("with fast refresh enabled", patterns), null);
  assert.equal(detectOverride("use fast-glob please", patterns), null);
});

test("disabled long tier is not an override target", () => {
  assert.equal(detectOverride("use long", patterns), null);
  assert.equal(detectOverride("use kimi", patterns), null);
});

test("jev unavailable holds the current tier", () => {
  const atBalanced = decide({ ...base, jev: null });
  assert.equal(atBalanced.tier, "balanced");
  assert.match(atBalanced.reason, /jev-unavailable/);

  const fromStrong = decide({ ...base, current: "strong", jev: null });
  assert.equal(fromStrong.tier, "strong");
  assert.equal(fromStrong.changed, false);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "balanced");
});

test("low-confidence clamps between current and ceiling", () => {
  const down = decide({ ...base, current: "strong", jev: unsure("fast") });
  assert.equal(down.tier, "balanced");
  assert.match(down.reason, /low-confidence/);

  const up = decide({ ...base, current: "fast", jev: unsure("long") });
  assert.equal(up.tier, "balanced");
  assert.match(up.reason, /low-confidence/);
});

test("still allows a confident upgrade to long", () => {
  assert.equal(decide({ ...base, jev: sure("long") }).tier, "long");
});

test("steps down at most one tier per turn", () => {
  const out = decide({
    ...base,
    current: "strong",
    jev: sure("fast"),
  });
  assert.equal(out.tier, "balanced");
  assert.match(out.reason, /step-down/);
});

test("allows a single-tier confident downgrade", () => {
  assert.equal(
    decide({ ...base, current: "strong", jev: sure("balanced") }).tier,
    "balanced",
  );
});

test("optional cache stickiness when configured", () => {
  const out = decide({
    ...base,
    current: "strong",
    jev: sure("balanced"),
    contextTokens: 80_000,
    thresholds: { ...thresholds, downgradeMaxContextTokens: 20_000 },
  });
  assert.equal(out.tier, "strong");
  assert.match(out.reason, /cache-rebuild/);
});

test("substitutes upward when the chosen tier is config-unavailable", () => {
  const out = decide({
    ...base,
    current: "fast",
    available: ["fast", "strong"],
    configAvailable: ["fast", "strong"],
    jev: sure("balanced"),
  });
  assert.equal(out.tier, "strong");
  assert.match(out.reason, /unavailable/);
});

test("steps downward when tier is exhausted (config-available but not eligible)", () => {
  const out = decide({
    ...base,
    current: "balanced",
    available: ["fast"],
    configAvailable: ["fast", "balanced", "strong"],
    jev: sure("strong"),
  });
  assert.equal(out.tier, "fast");
  assert.match(out.reason, /quota-down/);
});

test("never substitutes upward into opt-in long", () => {
  const out = decide({
    ...base,
    current: "fast",
    available: ["fast", "long"],
    configAvailable: ["fast", "long"],
    jev: sure("strong"),
  });
  assert.equal(out.tier, "fast");
});

test("decideAction escalates on strong and releases streak when easy", () => {
  const orch = config.orchestration;
  const escalate = decideAction({
    prompt: "debug the race",
    jev: sure("strong"),
    parentTier: "fast",
    hasStrongStreak: false,
    orchestration: orch,
    overridePatterns: patterns,
    thresholds: config.routing,
  });
  assert.equal(escalate.action, "escalate");
  assert.equal(escalate.parentTier, "fast");

  const release = decideAction({
    prompt: "fix the typo",
    jev: sure("fast"),
    parentTier: "fast",
    hasStrongStreak: true,
    orchestration: orch,
    overridePatterns: patterns,
    thresholds: config.routing,
  });
  assert.equal(release.action, "release");
});

test("decideAction holds sticky parent when Jev is down", () => {
  const out = decideAction({
    prompt: "implement the endpoint",
    jev: null,
    parentTier: "fast",
    hasStrongStreak: false,
    orchestration: config.orchestration,
    overridePatterns: patterns,
    thresholds: config.routing,
  });
  assert.equal(out.action, "stay");
  assert.match(out.reason, /jev-unavailable/);
});

test("decideAction releases streak when Jev is down or unsure", () => {
  const orch = config.orchestration;
  const down = decideAction({
    prompt: "still going",
    jev: null,
    parentTier: "fast",
    hasStrongStreak: true,
    orchestration: orch,
    overridePatterns: patterns,
    thresholds: config.routing,
  });
  assert.equal(down.action, "release");
  assert.match(down.reason, /jev-down/);

  const low = decideAction({
    prompt: "still going",
    jev: unsure("strong"),
    parentTier: "fast",
    hasStrongStreak: true,
    orchestration: orch,
    overridePatterns: patterns,
    thresholds: config.routing,
  });
  assert.equal(low.action, "release");
});

test("detectParallelIntent matches common phrases", () => {
  assert.equal(detectParallelIntent("do these in parallel"), true);
  assert.equal(detectParallelIntent("rename the symbol"), false);
});
