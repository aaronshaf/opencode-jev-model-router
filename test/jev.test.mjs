import test from "node:test";
import assert from "node:assert/strict";
import { askJev, resetJevClient, resolveApiKey } from "../dist/jev.js";
import { defaultConfig } from "../dist/config.js";
import { decide, buildOverridePatterns } from "../dist/policy.js";
import { modelForTier } from "../dist/models.js";

const routing = defaultConfig().routing;
const patterns = buildOverridePatterns(defaultConfig().tiers);

function withClearedKeys(fn) {
  const prev = {
    JEV_KEY: process.env.JEV_KEY,
    JEV_API_KEY: process.env.JEV_API_KEY,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  };
  delete process.env.JEV_KEY;
  delete process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetJevClient();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetJevClient();
    });
}

test("resolveApiKey prefers env", async () => {
  await withClearedKeys(async () => {
    process.env.JEV_KEY = "from-env";
    resetJevClient();
    assert.equal(resolveApiKey(process.env, { skipFiles: true }), "from-env");
  });
});

test("askJev returns null without a key", async () => {
  await withClearedKeys(async () => {
    const errors = [];
    const result = await askJev(
      {
        prompt: "hello",
        current: "balanced",
        contextTokens: 0,
        available: ["fast", "balanced", "strong"],
        routing,
      },
      {
        resolveKey: () => undefined,
        onError: (m) => errors.push(m),
      },
    );
    assert.equal(result, null);
    assert.match(errors[0] || "", /key missing/i);
  });
});

test("askJev parses a System One answer into tier + metrics", async () => {
  await withClearedKeys(async () => {
    process.env.JEV_KEY = "test-key";
    resetJevClient();
    const result = await askJev(
      {
        prompt: "fix a typo",
        current: "balanced",
        contextTokens: 2000,
        available: ["fast", "balanced", "strong"],
        routing,
      },
      {
        systemOne: async () => ({
          answers: {
            model_tier: { choice: "fast", confidence: 0.91 },
            task_complexity: { score: 1 },
            reasoning_required: { score: 2 },
            tool_complexity: { score: 0 },
          },
        }),
      },
    );
    assert.equal(result?.choice, "fast");
    assert.equal(result?.confidence, 0.91);
    assert.ok(result && result.metrics.taskComplexity < 0.2);
  });
});

test("askJev fails open on malformed answers", async () => {
  await withClearedKeys(async () => {
    process.env.JEV_KEY = "test-key";
    resetJevClient();
    const result = await askJev(
      {
        prompt: "x",
        current: "balanced",
        contextTokens: 0,
        available: ["fast"],
        routing,
      },
      {
        systemOne: async () => ({
          answers: { model_tier: { choice: "fast", confidence: Number.NaN } },
        }),
      },
    );
    assert.equal(result, null);
  });
});

test("Jev fast/strong choices drive model selection end-to-end", () => {
  const config = defaultConfig();
  const available = ["fast", "balanced", "strong"];

  const trivial = decide({
    prompt: "say hi",
    jev: { choice: "fast", confidence: 0.99 },
    current: "balanced",
    available,
    configAvailable: available,
    overridePatterns: patterns,
    thresholds: config.routing,
  });
  assert.equal(trivial.tier, "fast");
  assert.equal(trivial.reason, "jev");
  assert.equal(
    modelForTier(config, trivial.tier, {
      at: new Date(Date.UTC(2026, 8, 18, 15, 0, 0)),
    })?.model.modelID,
    "muse-spark-1.3-contributor",
  );

  const hard = decide({
    prompt: "debug a race",
    jev: { choice: "strong", confidence: 0.95 },
    current: "balanced",
    available,
    configAvailable: available,
    overridePatterns: patterns,
    thresholds: config.routing,
  });
  assert.equal(hard.tier, "strong");
  assert.equal(modelForTier(config, hard.tier)?.model.modelID, "gpt-5.6-luna");
});
