import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHooks, applyModel } from "../dist/adapter.js";
import { defaultConfig } from "../dist/config.js";
import { QuotaStore } from "../dist/quota.js";

function fakeClient() {
  return {
    tui: { showToast: async () => {} },
    app: { log: async () => {} },
    config: {
      providers: async () => ({
        data: {
          providers: [
            {
              id: "opencode-go",
              models: {
                "glm-5.3-flash": {},
                "qwen3.7-plus": {},
                "gpt-5.6-luna": {},
                "minimax-m3": {},
                "mimo-v2.5": {},
                "muse-spark-1.3-contributor": {},
                "deepseek-v4-flash": {},
                "deepseek-v4.1-flash": {},
                "kimi-k2.7-code": {},
                "kimi-k3": {},
              },
            },
          ],
        },
      }),
    },
  };
}

function pluginInput() {
  return {
    client: fakeClient(),
    directory: process.cwd(),
    project: { id: "test" },
  };
}

const known = new Set([
  "opencode-go/glm-5.3-flash",
  "opencode-go/qwen3.7-plus",
  "opencode-go/gpt-5.6-luna",
  "opencode-go/minimax-m3",
  "opencode-go/mimo-v2.5",
  "opencode-go/muse-spark-1.3-contributor",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/kimi-k3",
]);

/** Off-peak weekday afternoon UTC — DeepSeek primary stays first. */
const OFF_PEAK = () => Date.UTC(2026, 8, 18, 15, 0, 0);

function tempQuota() {
  return new QuotaStore({
    dir: mkdtempSync(join(tmpdir(), "jev-hook-")),
    now: OFF_PEAK,
  });
}

function hooksBase(extra = {}) {
  const config = defaultConfig();
  config.echoRouting = false;
  return createHooks(pluginInput(), config, {
    known,
    quota: tempQuota(),
    now: OFF_PEAK,
    resolveKey: () => undefined,
    askJev: async () => null,
    ...extra,
  });
}

test("applyModel nests variant inside model", () => {
  const message = { model: { providerID: "opencode-go", modelID: "qwen3.7-plus" } };
  applyModel(message, {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
    variant: "high",
  });
  assert.deepEqual(message.model, {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
    variant: "high",
  });
  assert.equal(message.variant, undefined);
});

test("chat.message mutates on explicit override", async () => {
  const hooks = await hooksBase();
  const output = {
    message: {
      id: "m1",
      sessionID: "s1",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "qwen3.7-plus" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use strong to debug this race" }],
  };

  await hooks["chat.message"]({ sessionID: "s1" }, output);
  assert.deepEqual(output.message.model, {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
  });
});

test("chat.message sticks to cheap parent during peak when Jev is down", async () => {
  const peak = () => Date.UTC(2026, 8, 14, 7, 0, 0);
  const hooks = await createHooks(pluginInput(), (() => {
    const c = defaultConfig();
    c.echoRouting = false;
    return c;
  })(), {
    known,
    quota: new QuotaStore({
      dir: mkdtempSync(join(tmpdir(), "jev-hook-peak-")),
      now: peak,
    }),
    now: peak,
    resolveKey: () => undefined,
    askJev: async () => null,
  });

  const output = {
    message: {
      id: "m2",
      sessionID: "s2",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "implement the endpoint" }],
  };

  await hooks["chat.message"]({ sessionID: "s2" }, output);
  assert.deepEqual(output.message.model, {
    providerID: "opencode-go",
    modelID: "muse-spark-1.3-contributor",
  });
});

test("chat.message skips when routing is disabled for the session", async () => {
  const hooks = await hooksBase();
  await hooks["command.execute.before"](
    { command: "jev-off", sessionID: "s3", arguments: "" },
    { parts: [] },
  );

  const output = {
    message: {
      id: "m3",
      sessionID: "s3",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "qwen3.7-plus" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use strong please" }],
  };

  await hooks["chat.message"]({ sessionID: "s3" }, output);
  assert.deepEqual(output.message.model, {
    providerID: "opencode-go",
    modelID: "qwen3.7-plus",
  });
});

test("chat.message ignores synthetic-only turns", async () => {
  const hooks = await hooksBase();
  const output = {
    message: {
      id: "m4",
      sessionID: "s4",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "qwen3.7-plus" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use strong", synthetic: true }],
  };

  await hooks["chat.message"]({ sessionID: "s4" }, output);
  assert.deepEqual(output.message.model, {
    providerID: "opencode-go",
    modelID: "qwen3.7-plus",
  });
});

test("chat.message skips unmanaged pinned models", async () => {
  const hooks = await hooksBase();
  const output = {
    message: {
      id: "m5",
      sessionID: "s5",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "hy3" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use strong please" }],
  };

  await hooks["chat.message"](
    { sessionID: "s5", model: { providerID: "opencode-go", modelID: "hy3" } },
    output,
  );
  assert.deepEqual(output.message.model, {
    providerID: "opencode-go",
    modelID: "hy3",
  });
});

test("chat.message skips child sessions marked internal", async () => {
  const hooks = await hooksBase();
  await hooks.event({
    event: {
      type: "session.created",
      properties: { info: { id: "child", parentID: "parent" } },
    },
  });

  const output = {
    message: {
      id: "m6",
      sessionID: "child",
      role: "user",
      agent: "general",
      model: { providerID: "opencode-go", modelID: "qwen3.7-plus" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use strong" }],
  };
  await hooks["chat.message"]({ sessionID: "child" }, output);
  assert.equal(output.message.model.modelID, "qwen3.7-plus");
});

test("chat.message uses fallback when primary is exhausted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-hook-quota-"));
  const quota = new QuotaStore({ dir, now: OFF_PEAK });
  quota.mark(
    "opencode-go/mimo-v2.5",
    OFF_PEAK() + 60 * 60 * 1000,
    "manual",
    OFF_PEAK(),
  );

  const hooks = await hooksBase({ quota });
  const output = {
    message: {
      id: "m7",
      sessionID: "s7",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "mimo-v2.5" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use balanced for this endpoint" }],
  };

  await hooks["chat.message"]({ sessionID: "s7" }, output);
  assert.deepEqual(output.message.model, {
    providerID: "opencode-go",
    modelID: "muse-spark-1.3-contributor",
  });
});

test("chat.message keeps sticky parent on Jev strong and hints escalate", async () => {
  let asked = 0;
  const hooks = await hooksBase({
    askJev: async () => {
      asked += 1;
      return {
        choice: "strong",
        confidence: 0.97,
        metrics: {
          taskComplexity: 0.8,
          reasoningRequired: 0.9,
          toolComplexity: 0.3,
          contextSize: 0,
        },
        ms: 12,
      };
    },
  });
  const output = {
    message: {
      id: "m7b",
      sessionID: "s7b",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "debug this race carefully" }],
  };
  await hooks["chat.message"]({ sessionID: "s7b" }, output);
  assert.equal(asked, 1);
  assert.deepEqual(output.message.model, {
    providerID: "opencode-go",
    modelID: "muse-spark-1.3-contributor",
  });
  assert.ok(
    output.parts.some(
      (p) => p.type === "text" && String(p.text).includes("jev_escalate"),
    ),
  );
});

test("explicit override skips calling Jev", async () => {
  let asked = 0;
  const hooks = await hooksBase({
    askJev: async () => {
      asked += 1;
      return null;
    },
  });
  const output = {
    message: {
      id: "m7c",
      sessionID: "s7c",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use strong to debug this race" }],
  };
  await hooks["chat.message"]({ sessionID: "s7c" }, output);
  assert.equal(asked, 0);
  assert.equal(output.message.model.modelID, "gpt-5.6-luna");
});

test("session.error marks quota and can re-mark after expiry", async () => {
  let now = OFF_PEAK();
  const dir = mkdtempSync(join(tmpdir(), "jev-hook-err-"));
  const quota = new QuotaStore({ dir, now: () => now });
  const hooks = await hooksBase({ quota, now: () => now });

  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "s-err",
        model: "opencode-go/gpt-5.6-luna",
        error: { message: "monthly allowance exhausted" },
      },
    },
  });
  assert.equal(quota.isExhausted("opencode-go/gpt-5.6-luna", now), true);

  // Still exhausted — second event must not extend forever via broken dedupe.
  const until1 = quota.list(now)[0]?.exhaustedUntil;
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "s-err",
        model: "opencode-go/gpt-5.6-luna",
        error: { message: "quota exceeded" },
      },
    },
  });
  assert.equal(quota.list(now)[0]?.exhaustedUntil, until1);

  now += 6 * 60 * 60 * 1000;
  assert.equal(quota.isExhausted("opencode-go/gpt-5.6-luna", now), false);

  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: "s-err",
        model: "opencode-go/gpt-5.6-luna",
        error: { message: "usage limit reached" },
      },
    },
  });
  assert.equal(quota.isExhausted("opencode-go/gpt-5.6-luna", now), true);
});

test("unknown catalog model is never applied", async () => {
  const config = defaultConfig();
  config.echoRouting = false;
  config.tiers.strong.model = "opencode-go/does-not-exist";
  config.tiers.strong.fallbacks = [];

  const hooks = await createHooks(pluginInput(), config, {
    known,
    quota: tempQuota(),
    now: OFF_PEAK,
    resolveKey: () => undefined,
    askJev: async () => null,
  });
  const output = {
    message: {
      id: "m8",
      sessionID: "s8",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "use strong" }],
  };

  await hooks["chat.message"]({ sessionID: "s8" }, output);
  assert.notEqual(output.message.model.modelID, "does-not-exist");
  // Override aimed at strong; missing catalog entry clamps down (balanced → MiMo).
  assert.equal(output.message.model.modelID, "mimo-v2.5");
});

test("catalog unavailable does not mutate", async () => {
  const client = fakeClient();
  client.config.providers = async () => {
    throw new Error("catalog down");
  };
  const config = defaultConfig();
  config.echoRouting = false;
  const hooks = await createHooks(
    { client, directory: process.cwd(), project: { id: "test" } },
    config,
    {
      // no known — forces a live catalog load
      quota: tempQuota(),
      now: OFF_PEAK,
      resolveKey: () => undefined,
      askJev: async () => ({
        choice: "strong",
        confidence: 0.99,
        metrics: {
          taskComplexity: 0.8,
          reasoningRequired: 0.8,
          toolComplexity: 0.2,
          contextSize: 0,
        },
        ms: 1,
      }),
    },
  );
  const output = {
    message: {
      id: "m9",
      sessionID: "s9",
      role: "user",
      agent: "build",
      model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
      time: { created: Date.now() },
    },
    parts: [{ type: "text", text: "debug this" }],
  };
  await hooks["chat.message"]({ sessionID: "s9" }, output);
  assert.equal(output.message.model.modelID, "deepseek-v4.1-flash");
});

test("jev-exhausted rejects bad hours", async () => {
  const hooks = await hooksBase();
  const parts = [];
  await hooks["command.execute.before"](
    { command: "jev-exhausted", sessionID: "s10", arguments: "balanced abc" },
    { parts },
  );
  assert.match(String(parts[0]?.text), /Hours must be/);
});

test("jev-status never prints the key material", async () => {
  const hooks = await createHooks(pluginInput(), defaultConfig(), {
    known,
    quota: tempQuota(),
    now: OFF_PEAK,
    resolveKey: () => "super-secret-key-value",
  });
  const parts = [];
  await hooks["command.execute.before"](
    { command: "jev-status", sessionID: "s11", arguments: "" },
    { parts },
  );
  const text = String(parts[0]?.text);
  assert.match(text, /Jev key present/);
  assert.equal(text.includes("super-secret"), false);
});
