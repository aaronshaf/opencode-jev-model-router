import test from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  detectOverride,
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

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "balanced");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "balanced");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("fast") });
  assert.equal(out.tier, "balanced");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "fast", jev: unsure("long") });
  assert.equal(out.tier, "balanced");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to long", () => {
  assert.equal(decide({ ...base, jev: sure("long") }).tier, "long");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({
    ...base,
    current: "strong",
    jev: sure("fast"),
    contextTokens: 80_000,
  });
  assert.equal(out.tier, "strong");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(
    decide({ ...base, current: "strong", jev: sure("fast") }).tier,
    "fast",
  );
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
