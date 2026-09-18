/**
 * DeepSeek peak/off-peak on OpenCode Go.
 * @see https://opencode.ai/docs/go/#usage-limits
 *
 * Peak (≈2× token $): Mon–Fri UTC 01:00–04:00 and 06:00–10:00.
 * Else off-peak, including weekends. Monthly $ cap is unchanged.
 */

const PEAK_WINDOWS = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 },
] as const;

export function isDeepSeekScheduledModel(ref: string): boolean {
  const id = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
  return (
    id === "deepseek-v4.1-flash" ||
    id === "deepseek-v4-pro" ||
    id === "deepseek-v4-flash" ||
    id === "deepseek-v4-flash-vision-exp"
  );
}

/** Half-open UTC hour ranges; weekends always off-peak. */
export function isDeepSeekPeak(now: Date = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return PEAK_WINDOWS.some((w) => hour >= w.startHour && hour < w.endHour);
}

export type SchedulePeriod = "peak" | "off-peak";

export function deepSeekPeriod(now: Date = new Date()): SchedulePeriod {
  return isDeepSeekPeak(now) ? "peak" : "off-peak";
}

/** During peak, put non-DeepSeek candidates first. */
export function orderCandidatesForSchedule(
  candidates: string[],
  now: Date = new Date(),
): string[] {
  if (!isDeepSeekPeak(now)) return [...candidates];
  const preferred: string[] = [];
  const deferred: string[] = [];
  for (const ref of candidates) {
    (isDeepSeekScheduledModel(ref) ? deferred : preferred).push(ref);
  }
  return [...preferred, ...deferred];
}

export function describeDeepSeekPeakWindows(): string {
  return "Mon–Fri UTC 01:00–04:00 and 06:00–10:00 (else off-peak, incl. weekends)";
}
