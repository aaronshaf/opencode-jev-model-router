import test from "node:test";
import assert from "node:assert/strict";
import { extractPromptText } from "../dist/prompt.js";
import {
  parseModelRef,
  tierOfModel,
  modelForTier,
  isManagedModel,
} from "../dist/models.js";
import { defaultConfig, parseConfig } from "../dist/config.js";
import { QuotaStore } from "../dist/quota.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("extracts normal text parts", () => {
  assert.equal(
    extractPromptText([{ type: "text", text: "  Build the UI  " }], 16384),
    "Build the UI",
  );
});

test("joins multiple text parts", () => {
  assert.equal(
    extractPromptText(
      [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      16384,
    ),
    "one\ntwo",
  );
});

test("ignores synthetic and ignored text", () => {
  assert.equal(
    extractPromptText(
      [
        { type: "text", text: "real" },
        { type: "text", text: "nope", synthetic: true },
        { type: "text", text: "also", ignored: true },
      ],
      16384,
    ),
    "real",
  );
});

test("returns empty for attachments only", () => {
  assert.equal(
    extractPromptText([{ type: "file", mime: "image/png" }], 16384),
    "",
  );
});

test("truncates to max bytes on a utf-8 boundary", () => {
  const text = "a".repeat(100) + "🙂" + "b".repeat(100);
  const out = extractPromptText([{ type: "text", text }], 101);
  const bytes = new TextEncoder().encode(out);
  assert.ok(bytes.byteLength <= 101);
  assert.equal(out, "a".repeat(100));
});

test("parseModelRef splits only on the first slash", () => {
  assert.deepEqual(parseModelRef("openai/gpt-5.6-luna"), {
    providerID: "openai",
    modelID: "gpt-5.6-luna",
  });
  assert.deepEqual(parseModelRef("opencode-go/gpt-5.6-luna"), {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
  });
  assert.deepEqual(parseModelRef("openrouter/deepseek/deepseek-v3.2"), {
    providerID: "openrouter",
    modelID: "deepseek/deepseek-v3.2",
  });
  assert.equal(parseModelRef("noslash"), undefined);
  assert.equal(parseModelRef("/bad"), undefined);
});

test("tierOfModel matches configured refs and fallbacks", () => {
  const config = defaultConfig();
  assert.equal(
    tierOfModel(config, { providerID: "opencode-go", modelID: "gpt-5.6-luna" }),
    "strong",
  );
  assert.equal(
    tierOfModel(config, {
      providerID: "opencode-go",
      modelID: "muse-spark-1.3-contributor",
    }),
    "fast",
  );
  assert.equal(
    tierOfModel(config, {
      providerID: "opencode-go",
      modelID: "mimo-v2.5",
    }),
    "balanced",
  );
  assert.equal(
    tierOfModel(config, {
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    }),
    "balanced",
  );
  assert.equal(
    tierOfModel(config, { providerID: "other", modelID: "unknown" }),
    "balanced",
  );
});

test("modelForTier respects enabled=false and uses fallbacks", () => {
  const config = defaultConfig();
  assert.equal(modelForTier(config, "long"), undefined);
  config.tiers.long.enabled = true;
  assert.deepEqual(modelForTier(config, "long")?.model, {
    providerID: "opencode-go",
    modelID: "kimi-k3",
  });
});

test("modelForTier skips exhausted primary and uses fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-quota-"));
  const quota = new QuotaStore({ dir, now: () => 1_000_000 });
  quota.mark("opencode-go/mimo-v2.5", 2_000_000, "test", 1_000_000);
  const selected = modelForTier(defaultConfig(), "balanced", { quota, now: 1_000_000 });
  assert.equal(selected?.model.modelID, "muse-spark-1.3-contributor");
  assert.equal(selected?.usedFallback, true);
});

test("modelForTier steps away from scarce strong when exhausted", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-quota-"));
  const now = 1_000_000;
  const quota = new QuotaStore({ dir, now: () => now });
  for (const ref of [
    "opencode-go/gpt-5.6-luna",
    "opencode-go/kimi-k2.7-code",
    "opencode-go/qwen3.7-plus",
  ]) {
    quota.mark(ref, now + 1, "test", now);
  }
  assert.equal(modelForTier(defaultConfig(), "strong", { quota, now }), undefined);
});

test("isManagedModel treats fallbacks as managed", () => {
  const config = defaultConfig();
  assert.equal(
    isManagedModel(config, { providerID: "opencode-go", modelID: "mimo-v2.5" }),
    true,
  );
  assert.equal(
    isManagedModel(config, {
      providerID: "opencode-go",
      modelID: "muse-spark-1.3-contributor",
    }),
    true,
  );
  assert.equal(
    isManagedModel(config, { providerID: "opencode-go", modelID: "hy3" }),
    false,
  );
});

test("parseConfig allows enabling long without re-specifying model", () => {
  const cfg = parseConfig({ tiers: { long: { enabled: true } } });
  assert.equal(cfg.tiers.long.enabled, true);
  assert.equal(cfg.tiers.long.model, "opencode-go/kimi-k3");
});

test("parseConfig rejects malformed tier models", () => {
  assert.throws(() => parseConfig({ tiers: { fast: { model: "bad" } } }), /model/);
});
