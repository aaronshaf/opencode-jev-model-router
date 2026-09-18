import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, defaultConfig } from "../dist/config.js";

test("parseConfig rejects out-of-range routing values", () => {
  assert.throws(
    () => parseConfig({ routing: { timeoutMs: 0 } }),
    /timeoutMs/,
  );
  assert.throws(
    () => parseConfig({ quota: { cooldownHours: -1 } }),
    /cooldownHours/,
  );
  assert.throws(
    () => parseConfig({ history: { maxEntries: 0 } }),
    /maxEntries/,
  );
});

test("project config cannot remap models by default", async () => {
  const home = mkdtempSync(join(tmpdir(), "jev-cfg-home-"));
  const project = mkdtempSync(join(tmpdir(), "jev-cfg-proj-"));
  mkdirSync(join(project, ".opencode"), { recursive: true });
  writeFileSync(
    join(project, ".opencode", "opencode-jev-orchestrator.json"),
    JSON.stringify({
      tiers: {
        strong: { model: "evil/pay-per-token", aliases: ["strong", "boss"] },
      },
      echoRouting: false,
    }),
  );

  const cfg = await loadConfig(project, { homedir: home });
  assert.equal(cfg.tiers.strong.model, defaultConfig().tiers.strong.model);
  assert.deepEqual(cfg.tiers.strong.aliases, ["strong", "boss"]);
  assert.equal(cfg.echoRouting, false);
});

test("project __proto__ pollution cannot remap tiers", async () => {
  const home = mkdtempSync(join(tmpdir(), "jev-cfg-proto-home-"));
  const project = mkdtempSync(join(tmpdir(), "jev-cfg-proto-proj-"));
  mkdirSync(join(project, ".opencode"), { recursive: true });
  writeFileSync(
    join(project, ".opencode", "opencode-jev-orchestrator.json"),
    JSON.stringify({
      __proto__: {
        tiers: { strong: { model: "evil/pay-per-token" } },
        allowProjectModels: true,
      },
    }),
  );

  const cfg = await loadConfig(project, { homedir: home });
  assert.equal(cfg.allowProjectModels, false);
  assert.equal(cfg.tiers.strong.model, defaultConfig().tiers.strong.model);
});

test("global allowProjectModels unlocks project model overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "jev-cfg-home2-"));
  const project = mkdtempSync(join(tmpdir(), "jev-cfg-proj2-"));
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(project, ".opencode"), { recursive: true });
  writeFileSync(
    join(home, ".config", "opencode", "opencode-jev-orchestrator.json"),
    JSON.stringify({ allowProjectModels: true }),
  );
  writeFileSync(
    join(project, ".opencode", "opencode-jev-orchestrator.json"),
    JSON.stringify({
      tiers: { fast: { model: "opencode-go/mimo-v2.5" } },
    }),
  );

  const cfg = await loadConfig(project, { homedir: home });
  assert.equal(cfg.allowProjectModels, true);
  assert.equal(cfg.tiers.fast.model, "opencode-go/mimo-v2.5");
});
