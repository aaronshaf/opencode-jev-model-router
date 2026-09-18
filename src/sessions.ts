import type { DecisionRecord, ModelRef, Tier } from "./types.js";
import { formatModelRef } from "./models.js";

/**
 * Per-session routing state. Kept in-process; OpenCode reloads plugins rarely.
 */
export class SessionStore {
  private readonly modes = new Map<string, boolean>();
  private readonly internal = new Set<string>();
  private readonly lastServed = new Map<string, ModelRef>();
  private readonly lastTier = new Map<string, Tier>();
  private readonly contextTokens = new Map<string, number>();
  private readonly pinToast = new Set<string>();
  private readonly history: DecisionRecord[] = [];
  private readonly maxEntries: number;
  private readonly retainPrompt: boolean;
  private readonly historyEnabled: boolean;

  constructor(opts: {
    maxEntries: number;
    retainPrompt: boolean;
    historyEnabled: boolean;
  }) {
    this.maxEntries = opts.maxEntries;
    this.retainPrompt = opts.retainPrompt;
    this.historyEnabled = opts.historyEnabled;
  }

  isAutomatic(sessionID: string, defaultEnabled: boolean): boolean {
    return this.modes.has(sessionID)
      ? this.modes.get(sessionID)!
      : defaultEnabled;
  }

  setAutomatic(sessionID: string, enabled: boolean): void {
    this.modes.set(sessionID, enabled);
  }

  markInternal(sessionID: string): void {
    this.internal.add(sessionID);
  }

  isInternal(sessionID: string): boolean {
    return this.internal.has(sessionID);
  }

  setLastServed(sessionID: string, model: ModelRef): void {
    this.lastServed.set(sessionID, model);
  }

  getLastServed(sessionID: string): ModelRef | undefined {
    return this.lastServed.get(sessionID);
  }

  setLastTier(sessionID: string, tier: Tier): void {
    this.lastTier.set(sessionID, tier);
  }

  getLastTier(sessionID: string): Tier | undefined {
    return this.lastTier.get(sessionID);
  }

  setContextTokens(sessionID: string, tokens: number): void {
    this.contextTokens.set(sessionID, Math.max(0, tokens));
  }

  getContextTokens(sessionID: string): number {
    return this.contextTokens.get(sessionID) ?? 0;
  }

  shouldToastPin(sessionID: string): boolean {
    if (this.pinToast.has(sessionID)) return false;
    this.pinToast.add(sessionID);
    return true;
  }

  forget(sessionID: string): void {
    this.modes.delete(sessionID);
    this.internal.delete(sessionID);
    this.lastServed.delete(sessionID);
    this.lastTier.delete(sessionID);
    this.contextTokens.delete(sessionID);
    this.pinToast.delete(sessionID);
  }

  record(entry: DecisionRecord): void {
    if (!this.historyEnabled) return;
    const stored: DecisionRecord = this.retainPrompt
      ? entry
      : { ...entry, prompt: undefined };
    this.history.push(stored);
    while (this.history.length > this.maxEntries) this.history.shift();
  }

  last(sessionID?: string): DecisionRecord | undefined {
    if (!sessionID) return this.history[this.history.length - 1];
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i]?.sessionID === sessionID) return this.history[i];
    }
    return undefined;
  }

  explain(sessionID?: string): string {
    const last = this.last(sessionID);
    if (!last) return "No routing decisions recorded yet.";

    const lines = [
      "Jev Router",
      "",
      `Current tier:        ${last.currentTier}`,
      `Recommended tier:    ${last.decision.tier}`,
      `Selected model:      ${last.model ?? "(unchanged)"}`,
      `Used fallback:       ${last.usedFallback ? "yes" : "no"}`,
      `Confidence:          ${last.jev ? `${Math.round(last.jev.confidence * 100)}%` : "n/a"}`,
      `Decision:            ${last.decision.reason}`,
    ];

    const served = sessionID ? this.getLastServed(sessionID) : undefined;
    if (served) {
      lines.push(`Last served:         ${formatModelRef(served)}`);
    }
    if (sessionID) {
      const tier = this.getLastTier(sessionID);
      if (tier) lines.push(`Last routed tier:    ${tier}`);
      lines.push(`Context tokens:      ${this.getContextTokens(sessionID)}`);
    }

    if (last.metrics) {
      lines.push(
        "",
        `Task complexity:     ${last.metrics.taskComplexity.toFixed(2)}`,
        `Reasoning required:  ${last.metrics.reasoningRequired.toFixed(2)}`,
        `Tool complexity:     ${last.metrics.toolComplexity.toFixed(2)}`,
        `Context size:        ${last.metrics.contextSize.toFixed(2)}`,
      );
    }

    if (typeof last.latencyMs === "number") {
      lines.push("", `Latency:             ${last.latencyMs} ms`);
    }

    return lines.join("\n");
  }
}
