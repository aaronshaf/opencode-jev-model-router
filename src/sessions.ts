import type {
  DecisionRecord,
  ModelRef,
  OrchestrationAction,
  Tier,
} from "./types.js";
import { formatModelRef } from "./models.js";

type ParentOrchestration = {
  activeStrongChildId?: string;
  /** Open children that count toward maxConcurrentChildren. */
  activeChildIds: string[];
  /** Parent message count at last strong handoff (resume sends only newer). */
  strongHandoffMessageCount?: number;
  /** Wall clock when an escalate hint was injected. */
  escalateHintedAt?: number;
  escalateCalledAfterHint?: boolean;
  lastJevAction?: OrchestrationAction;
};

/**
 * Per-session orchestration state. Kept in-process; OpenCode reloads plugins rarely.
 */
export class SessionStore {
  private readonly modes = new Map<string, boolean>();
  private readonly internal = new Set<string>();
  private readonly lastServed = new Map<string, ModelRef>();
  private readonly lastTier = new Map<string, Tier>();
  private readonly contextTokens = new Map<string, number>();
  private readonly pinToast = new Set<string>();
  private readonly orchestration = new Map<string, ParentOrchestration>();
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

  private orch(sessionID: string): ParentOrchestration {
    let state = this.orchestration.get(sessionID);
    if (!state) {
      state = { activeChildIds: [] };
      this.orchestration.set(sessionID, state);
    }
    return state;
  }

  getActiveStrongChild(sessionID: string): string | undefined {
    return this.orch(sessionID).activeStrongChildId;
  }

  getActiveChildIds(sessionID: string): string[] {
    return [...this.orch(sessionID).activeChildIds];
  }

  /** @deprecated Use getActiveChildIds */
  getChildIds(sessionID: string): string[] {
    return this.getActiveChildIds(sessionID);
  }

  canSpawn(sessionID: string, maxConcurrent: number): boolean {
    return this.orch(sessionID).activeChildIds.length < maxConcurrent;
  }

  registerChild(
    parentID: string,
    childID: string,
    opts: { strong?: boolean } = {},
  ): void {
    const state = this.orch(parentID);
    if (!state.activeChildIds.includes(childID)) {
      state.activeChildIds.push(childID);
    }
    this.markInternal(childID);
    if (opts.strong) state.activeStrongChildId = childID;
  }

  /** Drop a finished child from the concurrent cap (parallel one-shots). */
  releaseChild(parentID: string, childID: string): void {
    const state = this.orch(parentID);
    state.activeChildIds = state.activeChildIds.filter((id) => id !== childID);
    if (state.activeStrongChildId === childID) {
      state.activeStrongChildId = undefined;
      state.strongHandoffMessageCount = undefined;
    }
  }

  clearStrongStreak(parentID: string): void {
    const state = this.orch(parentID);
    const strong = state.activeStrongChildId;
    state.activeStrongChildId = undefined;
    state.strongHandoffMessageCount = undefined;
    if (strong) {
      state.activeChildIds = state.activeChildIds.filter((id) => id !== strong);
    }
  }

  setStrongHandoffMessageCount(parentID: string, count: number): void {
    this.orch(parentID).strongHandoffMessageCount = Math.max(0, count);
  }

  getStrongHandoffMessageCount(parentID: string): number {
    return this.orch(parentID).strongHandoffMessageCount ?? 0;
  }

  markEscalateHinted(sessionID: string, at: number = Date.now()): void {
    const state = this.orch(sessionID);
    state.escalateHintedAt = at;
    state.escalateCalledAfterHint = false;
  }

  markEscalateCalled(sessionID: string): void {
    const state = this.orch(sessionID);
    if (state.escalateHintedAt != null) state.escalateCalledAfterHint = true;
  }

  /**
   * If a prior turn hinted escalate and the tool was never called, return true
   * once (then clears the hint tracking).
   */
  consumeEscalateMiss(sessionID: string): boolean {
    const state = this.orch(sessionID);
    if (state.escalateHintedAt == null) return false;
    const missed = !state.escalateCalledAfterHint;
    state.escalateHintedAt = undefined;
    state.escalateCalledAfterHint = undefined;
    return missed;
  }

  setLastJevAction(sessionID: string, action: OrchestrationAction): void {
    this.orch(sessionID).lastJevAction = action;
  }

  getLastJevAction(sessionID: string): OrchestrationAction | undefined {
    return this.orch(sessionID).lastJevAction;
  }

  forget(sessionID: string): void {
    this.modes.delete(sessionID);
    this.internal.delete(sessionID);
    this.lastServed.delete(sessionID);
    this.lastTier.delete(sessionID);
    this.contextTokens.delete(sessionID);
    this.pinToast.delete(sessionID);
    this.orchestration.delete(sessionID);
    for (const [parent, state] of this.orchestration) {
      state.activeChildIds = state.activeChildIds.filter((id) => id !== sessionID);
      if (state.activeStrongChildId === sessionID) {
        state.activeStrongChildId = undefined;
        state.strongHandoffMessageCount = undefined;
      }
      if (!state.activeChildIds.length && !state.activeStrongChildId) {
        this.orchestration.delete(parent);
      }
    }
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
    if (!last) return "No orchestration decisions recorded yet.";

    const lines = [
      "Jev Orchestrator",
      "",
      `Current tier:        ${last.currentTier}`,
      `Recommended tier:    ${last.decision.tier}`,
      `Action:              ${last.action ?? "n/a"}`,
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
      if (tier) lines.push(`Last parent tier:    ${tier}`);
      lines.push(`Context tokens:      ${this.getContextTokens(sessionID)}`);
      const strong = this.getActiveStrongChild(sessionID);
      if (strong) lines.push(`Active strong child: ${strong}`);
      const children = this.getActiveChildIds(sessionID);
      if (children.length) {
        lines.push(`Active children:     ${children.join(", ")}`);
      }
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
