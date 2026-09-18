import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../dist/sessions.js";

function store() {
  return new SessionStore({
    maxEntries: 5,
    retainPrompt: false,
    historyEnabled: true,
  });
}

test("tracks lastServed and context tokens per session", () => {
  const s = store();
  s.setLastServed("ses1", {
    providerID: "opencode-go",
    modelID: "muse-spark-1.3-contributor",
  });
  s.setLastTier("ses1", "fast");
  s.setContextTokens("ses1", 12_000);
  assert.deepEqual(s.getLastServed("ses1"), {
    providerID: "opencode-go",
    modelID: "muse-spark-1.3-contributor",
  });
  assert.equal(s.getLastTier("ses1"), "fast");
  assert.equal(s.getContextTokens("ses1"), 12_000);
  assert.equal(s.getContextTokens("other"), 0);
});

test("marks child sessions internal and forgets cleanly", () => {
  const s = store();
  s.markInternal("child");
  s.setAutomatic("child", true);
  assert.equal(s.isInternal("child"), true);
  s.forget("child");
  assert.equal(s.isInternal("child"), false);
  assert.equal(s.isAutomatic("child", false), false);
});

test("history strips prompts by default and explain works", () => {
  const s = store();
  s.record({
    at: Date.now(),
    sessionID: "ses1",
    prompt: "secret prompt text",
    currentTier: "balanced",
    jev: { choice: "fast", confidence: 0.9 },
    decision: { tier: "fast", reason: "jev", changed: true },
    model: "opencode-go/muse-spark-1.3-contributor",
  });
  assert.equal(s.last("ses1")?.prompt, undefined);
  assert.match(s.explain("ses1"), /muse-spark-1.3-contributor/);
  assert.match(s.explain("ses1"), /Decision:\s+jev/);
});

test("pin toast fires once per session", () => {
  const s = store();
  assert.equal(s.shouldToastPin("ses1"), true);
  assert.equal(s.shouldToastPin("ses1"), false);
});
