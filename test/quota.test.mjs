import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaStore, isQuotaError } from "../dist/quota.js";

test("QuotaStore mark/list/clear with injectable clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-quota-unit-"));
  let now = 1_000_000;
  const store = new QuotaStore({ dir, now: () => now });

  store.mark("opencode-go/gpt-5.6-luna", now + 5_000, "manual", now);
  assert.equal(store.isExhausted("opencode-go/gpt-5.6-luna"), true);
  assert.equal(store.list().length, 1);

  now = 1_006_000;
  assert.equal(store.isExhausted("opencode-go/gpt-5.6-luna"), false);
  assert.equal(store.list().length, 0);
});

test("QuotaStore persists to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-quota-persist-"));
  const now = 2_000_000;
  const a = new QuotaStore({ dir, now: () => now });
  a.mark("opencode-go/mimo-v2.5", now + 60_000, "test", now);

  const raw = JSON.parse(readFileSync(join(dir, "quota.json"), "utf8"));
  assert.equal(raw["opencode-go/mimo-v2.5"].reason, "test");

  const b = new QuotaStore({ dir, now: () => now });
  assert.equal(b.isExhausted("opencode-go/mimo-v2.5"), true);
  b.clear("opencode-go/mimo-v2.5");
  assert.equal(b.isExhausted("opencode-go/mimo-v2.5"), false);
});

test("isQuotaError covers common shapes", () => {
  assert.equal(isQuotaError("quota exceeded"), true);
  assert.equal(isQuotaError("monthly allowance exhausted"), true);
  assert.equal(isQuotaError("usage limit reached"), true);
  assert.equal(isQuotaError({ data: { message: "allowance exhausted" } }), true);
  assert.equal(
    isQuotaError({ status: 429, message: "quota exceeded for plan" }),
    true,
  );
});

test("isQuotaError ignores context length and bare rate limits", () => {
  assert.equal(isQuotaError(429), false);
  assert.equal(isQuotaError("context length exceeded"), false);
  assert.equal(isQuotaError("max tokens exceeded"), false);
  assert.equal(isQuotaError("rate limit exceeded"), false);
  assert.equal(isQuotaError({ statusCode: 429 }), false);
  assert.equal(isQuotaError({ id: "req_4291" }), false);
  assert.equal(isQuotaError("Model not found"), false);
  const circular = { message: "ok" };
  circular.self = circular;
  assert.equal(isQuotaError(circular), false);
});
