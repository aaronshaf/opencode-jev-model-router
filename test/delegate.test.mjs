import test from "node:test";
import assert from "node:assert/strict";
import {
  formatParentContext,
  pickEscalateModel,
  pickParallelModel,
  spawnOrResumeChild,
} from "../dist/delegate.js";
import { defaultConfig } from "../dist/config.js";
import { SessionStore } from "../dist/sessions.js";
import { QuotaStore } from "../dist/quota.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("formatParentContext keeps recent turns under budget", () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "AAAA".repeat(1000) }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "BBBB".repeat(1000) }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "recent ask" }] },
  ];
  const out = formatParentContext(messages, 80);
  assert.match(out, /recent ask/);
  assert.ok(new TextEncoder().encode(out).byteLength <= 200);
});

test("pickEscalateModel falls back when Luna is exhausted", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-del-"));
  const quota = new QuotaStore({ dir, now: () => 1_000_000 });
  quota.mark("opencode-go/gpt-5.6-luna", 2_000_000, "test", 1_000_000);
  const picked = pickEscalateModel(defaultConfig(), { quota, now: 1_000_000 });
  assert.equal(picked?.model.modelID, "kimi-k2.7-code");
  assert.equal(picked?.usedFallback, true);
});

test("pickParallelModel prefers fast", () => {
  const picked = pickParallelModel(defaultConfig());
  assert.equal(picked?.model.modelID, "muse-spark-1.3-contributor");
});

test("spawnOrResumeChild creates, prompts, waits, returns text", async () => {
  const sessions = new SessionStore({
    maxEntries: 10,
    retainPrompt: false,
    historyEnabled: true,
  });
  const config = defaultConfig();
  config.orchestration.childTimeoutMs = 2_000;

  let created = 0;
  const client = {
    session: {
      create: async () => {
        created += 1;
        return { data: { id: "child-1" } };
      },
      prompt: async () => ({ data: {} }),
      status: async () => ({ data: { "child-1": { type: "idle" } } }),
      messages: async ({ path }) => {
        if (path.id === "parent") {
          return {
            data: [
              {
                info: { role: "user" },
                parts: [{ type: "text", text: "parent ask" }],
              },
            ],
          };
        }
        return {
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "child answer" }],
            },
          ],
        };
      },
    },
  };

  const result = await spawnOrResumeChild({
    parentID: "parent",
    task: "hard bug",
    model: { providerID: "opencode-go", modelID: "gpt-5.6-luna" },
    usedFallback: false,
    strong: true,
    deps: {
      client,
      sessions,
      config,
      sleep: async () => {},
    },
  });

  assert.equal(created, 1);
  assert.equal(result.childID, "child-1");
  assert.equal(result.text, "child answer");
  assert.equal(result.contextMode, "full");
  assert.equal(sessions.getActiveStrongChild("parent"), "child-1");
  assert.equal(sessions.isInternal("child-1"), true);

  const resumed = await spawnOrResumeChild({
    parentID: "parent",
    task: "follow up",
    model: { providerID: "opencode-go", modelID: "gpt-5.6-luna" },
    usedFallback: false,
    existingChildId: "child-1",
    strong: true,
    deps: {
      client,
      sessions,
      config,
      sleep: async () => {},
    },
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.contextMode, "delta");
  assert.equal(created, 1);
});

test("parallel child frees concurrent slot when done", async () => {
  const sessions = new SessionStore({
    maxEntries: 10,
    retainPrompt: false,
    historyEnabled: false,
  });
  const config = defaultConfig();
  config.orchestration.maxConcurrentChildren = 1;
  config.orchestration.childTimeoutMs = 2_000;

  const client = {
    session: {
      create: async () => ({ data: { id: "p1" } }),
      prompt: async () => ({ data: {} }),
      status: async () => ({ data: { p1: { type: "idle" } } }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "done" }],
          },
        ],
      }),
    },
  };

  await spawnOrResumeChild({
    parentID: "parent",
    task: "rename",
    model: { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" },
    usedFallback: false,
    strong: false,
    deps: { client, sessions, config, sleep: async () => {} },
  });
  assert.equal(sessions.getActiveChildIds("parent").length, 0);
  assert.equal(sessions.canSpawn("parent", 1), true);
});

test("spawnOrResumeChild enforces max concurrent children", async () => {
  const sessions = new SessionStore({
    maxEntries: 10,
    retainPrompt: false,
    historyEnabled: false,
  });
  const config = defaultConfig();
  config.orchestration.maxConcurrentChildren = 1;
  sessions.registerChild("parent", "existing");

  await assert.rejects(
    () =>
      spawnOrResumeChild({
        parentID: "parent",
        task: "x",
        model: { providerID: "opencode-go", modelID: "muse-spark-1.3-contributor" },
        usedFallback: false,
        deps: {
          client: {
            session: {
              create: async () => ({ data: { id: "nope" } }),
              prompt: async () => ({}),
              status: async () => ({ data: {} }),
              messages: async () => ({ data: [] }),
            },
          },
          sessions,
          config,
          sleep: async () => {},
        },
      }),
    /maxConcurrentChildren/,
  );
});
