#!/usr/bin/env node
/**
 * Live Jev smoke: trivial vs hard prompt should land on different tiers.
 * Usage: JEV_KEY=... node scripts/jev-smoke.mjs
 */
import { askJev, resetJevClient, resolveApiKey } from "../dist/jev.js";
import { defaultConfig } from "../dist/config.js";

resetJevClient();
if (!resolveApiKey()) {
  console.error("Set JEV_KEY (or JEV_API_KEY / TYPESAFE_API_KEY) first.");
  process.exit(1);
}

const routing = defaultConfig().routing;
const available = ["fast", "balanced", "strong", "long"];
const cases = [
  ["trivial", "Reply with exactly: pong", "fast"],
  [
    "hard",
    "Debug this race condition across three modules and design a safe fix",
    "strong",
  ],
];

let failed = 0;
for (const [label, prompt, expect] of cases) {
  const result = await askJev({
    prompt,
    current: "balanced",
    contextTokens: 1000,
    available,
    routing,
  });
  const ok = result?.choice === expect;
  console.log(
    `${ok ? "ok" : "FAIL"} ${label}: got ${result?.choice ?? "null"} (want ${expect}) conf=${result?.confidence ?? "n/a"} ${result?.ms ?? "?"}ms`,
  );
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
