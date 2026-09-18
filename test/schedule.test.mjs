import test from "node:test";
import assert from "node:assert/strict";
import {
  isDeepSeekPeak,
  deepSeekPeriod,
  orderCandidatesForSchedule,
  isDeepSeekScheduledModel,
} from "../dist/schedule.js";
import { modelForTier } from "../dist/models.js";
import { defaultConfig } from "../dist/config.js";

test("isDeepSeekScheduledModel matches Go DeepSeek ids", () => {
  assert.equal(isDeepSeekScheduledModel("opencode-go/deepseek-v4.1-flash"), true);
  assert.equal(isDeepSeekScheduledModel("opencode-go/muse-spark-1.3-contributor"), false);
});

test("weekends are always off-peak", () => {
  // 2026-09-19 is a Saturday
  const sat = new Date(Date.UTC(2026, 8, 19, 8, 0, 0));
  assert.equal(isDeepSeekPeak(sat), false);
  assert.equal(deepSeekPeriod(sat), "off-peak");
});

test("weekday peak windows are detected", () => {
  // 2026-09-18 is Friday
  assert.equal(isDeepSeekPeak(new Date(Date.UTC(2026, 8, 18, 1, 0, 0))), true);
  assert.equal(isDeepSeekPeak(new Date(Date.UTC(2026, 8, 18, 3, 59, 0))), true);
  assert.equal(isDeepSeekPeak(new Date(Date.UTC(2026, 8, 18, 4, 0, 0))), false);
  assert.equal(isDeepSeekPeak(new Date(Date.UTC(2026, 8, 18, 6, 0, 0))), true);
  assert.equal(isDeepSeekPeak(new Date(Date.UTC(2026, 8, 18, 9, 59, 0))), true);
  assert.equal(isDeepSeekPeak(new Date(Date.UTC(2026, 8, 18, 10, 0, 0))), false);
  assert.equal(isDeepSeekPeak(new Date(Date.UTC(2026, 8, 18, 15, 0, 0))), false);
});

test("orderCandidatesForSchedule defers DeepSeek only during peak", () => {
  const candidates = [
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/muse-spark-1.3-contributor",
    "opencode-go/mimo-v2.5",
  ];
  const peak = new Date(Date.UTC(2026, 8, 18, 7, 0, 0));
  const off = new Date(Date.UTC(2026, 8, 18, 15, 0, 0));
  assert.deepEqual(orderCandidatesForSchedule(candidates, peak), [
    "opencode-go/muse-spark-1.3-contributor",
    "opencode-go/mimo-v2.5",
    "opencode-go/deepseek-v4.1-flash",
  ]);
  assert.deepEqual(orderCandidatesForSchedule(candidates, off), candidates);
});

test("balanced prefers Muse over DeepSeek during peak", () => {
  const peak = new Date(Date.UTC(2026, 8, 18, 7, 0, 0));
  const off = new Date(Date.UTC(2026, 8, 18, 15, 0, 0));
  const config = defaultConfig();
  assert.equal(
    modelForTier(config, "balanced", { at: peak })?.model.modelID,
    "muse-spark-1.3-contributor",
  );
  assert.equal(
    modelForTier(config, "balanced", { at: off })?.model.modelID,
    "deepseek-v4.1-flash",
  );
});
