import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import {
  pickEscalateModel,
  pickParallelModel,
  spawnOrResumeChild,
} from "./delegate.js";
import { askJev as defaultAskJev, resolveApiKey as defaultResolveApiKey } from "./jev.js";
import type { AskJevDeps, AskJevInput } from "./jev.js";
import type { JevResult } from "./types.js";
import {
  configAvailableTiers,
  formatModelRef,
  isManagedModel,
  modelForTier,
  parseModelRef,
  resolveAvailableTiers,
  tierCandidates,
  tierOfModel,
} from "./models.js";
import {
  actionHint,
  buildOverridePatterns,
  decide,
  decideAction,
  detectOverride,
} from "./policy.js";
import { extractPromptText } from "./prompt.js";
import { QuotaStore, isQuotaError } from "./quota.js";
import { deepSeekPeriod } from "./schedule.js";
import { SessionStore } from "./sessions.js";
import type { ModelRef, RouterConfig, Tier } from "./types.js";
import { isTier } from "./types.js";

type ToastVariant = "info" | "success" | "warning" | "error";

export type HookDeps = {
  quota?: QuotaStore;
  known?: Set<string>;
  /** Fixed clock for peak/off-peak tests. */
  now?: () => number;
  askJev?: (
    input: AskJevInput,
    deps?: AskJevDeps,
  ) => Promise<JevResult | null>;
  resolveKey?: () => string | undefined;
  /** Injectable for tests — skip real child wait. */
  sleep?: (ms: number) => Promise<void>;
};

function cleanError(value: unknown): string {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240);
}

function setCommandResult(
  output: { parts: Array<Record<string, unknown>> },
  text: string,
): void {
  output.parts.splice(0, output.parts.length, {
    type: "text",
    text,
    synthetic: true,
  });
}

/** Set pending message model; variant nests inside `model` (Phase 0). */
export function applyModel(
  message: { model: { providerID: string; modelID: string; variant?: string } },
  target: ModelRef,
): void {
  message.model = target.variant
    ? {
        providerID: target.providerID,
        modelID: target.modelID,
        variant: target.variant,
      }
    : { providerID: target.providerID, modelID: target.modelID };
}

async function loadKnownModels(
  input: PluginInput,
): Promise<Set<string> | undefined> {
  try {
    const result = await input.client.config.providers({
      query: { directory: input.directory },
      signal: AbortSignal.timeout(3000),
    });
    if (result.error || !result.data?.providers) return undefined;
    const known = new Set<string>();
    for (const provider of result.data.providers) {
      const models = provider.models ?? {};
      for (const modelID of Object.keys(models)) {
        known.add(`${provider.id}/${modelID}`);
      }
    }
    return known;
  } catch {
    return undefined;
  }
}

function modelPropAsRef(value: unknown): string | undefined {
  if (typeof value === "string" && value.includes("/")) return value;
  return undefined;
}

export async function createHooks(
  input: PluginInput,
  config?: RouterConfig,
  deps: HookDeps = {},
): Promise<Hooks> {
  const resolved = config ?? (await loadConfig(input.directory));
  if (!resolved.enabled) return {};

  const sessions = new SessionStore({
    maxEntries: resolved.history.maxEntries,
    retainPrompt: resolved.history.retainPrompt,
    historyEnabled: resolved.history.enabled,
  });
  const quota = deps.quota ?? new QuotaStore();
  const ask = deps.askJev ?? defaultAskJev;
  const resolveKey = deps.resolveKey ?? defaultResolveApiKey;
  const nowFn = deps.now ?? Date.now;
  const sleep = deps.sleep;
  const overridePatterns = buildOverridePatterns(resolved.tiers);
  const orch = resolved.orchestration;

  let known = deps.known;
  let catalogFailedAt = 0;

  const toast = async (message: string, variant: ToastVariant = "info") => {
    try {
      await Promise.race([
        input.client.tui.showToast({
          body: { title: "Jev Orchestrator", message, variant, duration: 5000 },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("toast timeout")), 2000),
        ),
      ]);
    } catch {
      // Headless clients have no TUI.
    }
  };

  const log = async (
    message: string,
    level: "info" | "warn" | "error" = "info",
  ) => {
    try {
      await input.client.app.log({
        body: { service: "opencode-jev-orchestrator", level, message },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // optional
    }
  };

  const markQuota = async (modelRef: string, reason: string) => {
    if (quota.isExhausted(modelRef, nowFn())) return;
    const until = nowFn() + resolved.quota.cooldownHours * 60 * 60 * 1000;
    quota.mark(modelRef, until, reason, nowFn());
    await toast(
      `${modelRef} allowance exhausted; routing around it until ${new Date(until).toLocaleTimeString()}`,
      "warning",
    );
  };

  const ensureKnown = async (): Promise<Set<string> | undefined> => {
    if (known !== undefined) return known;
    if (catalogFailedAt && nowFn() - catalogFailedAt < 60_000) {
      return undefined;
    }
    const loaded = await loadKnownModels(input);
    if (!loaded) {
      catalogFailedAt = nowFn();
      return undefined;
    }
    known = loaded;
    catalogFailedAt = 0;
    const invalid: string[] = [];
    for (const tier of Object.values(resolved.tiers)) {
      if (tier.enabled === false) continue;
      if (!known.has(tier.model)) invalid.push(tier.model);
      for (const fb of tier.fallbacks ?? []) {
        if (!known.has(fb)) invalid.push(fb);
      }
    }
    if (invalid.length) {
      await log(
        `Unknown configured models (will skip): ${[...new Set(invalid)].join(", ")}`,
        "warn",
      );
    }
    return known;
  };

  const selectOpts = () => ({
    known,
    quota,
    now: nowFn(),
    at: new Date(nowFn()),
  });

  const spawnDeps = () => ({
    client: input.client,
    sessions,
    config: resolved,
    directory: input.directory,
    known,
    quota,
    now: nowFn(),
    log: (message: string, level: "info" | "warn" | "error" = "info") =>
      log(message, level),
    ...(sleep ? { sleep } : {}),
  });

  return {
    config: async (cfg) => {
      cfg.command = {
        ...cfg.command,
        "jev-on": {
          template: "jev-on",
          description: "Enable Jev automatic orchestration for this session",
        },
        "jev-off": {
          template: "jev-off",
          description: "Disable Jev automatic orchestration for this session",
        },
        "jev-status": {
          template: "jev-status",
          description: "Show Jev orchestrator status for this session",
        },
        "jev-explain": {
          template: "jev-explain",
          description: "Explain the last Jev orchestration decision",
        },
        "jev-quota": {
          template: "jev-quota",
          description: "List models marked quota-exhausted",
        },
        "jev-exhausted": {
          template: "jev-exhausted $1",
          description:
            "Mark a tier or provider/model exhausted: /jev-exhausted balanced [hours]",
        },
        "jev-reset": {
          template: "jev-reset $1",
          description:
            "Clear exhaustion for one model or all: /jev-reset [provider/model]",
        },
      };
    },

    tool: {
      jev_escalate: tool({
        description:
          "Escalate a hard task to a strong (or fallback) child subagent with near-full parent context. Resume an active strong child when one exists. Merge the returned answer into your reply.",
        args: {
          task: tool.schema.string().describe("Task for the strong subagent"),
        },
        async execute(args, ctx) {
          const catalog = await ensureKnown();
          if (!catalog) {
            return {
              title: "Escalate failed",
              output: "Model catalog unavailable; cannot escalate.",
            };
          }
          known = catalog;
          const picked = pickEscalateModel(resolved, selectOpts());
          if (!picked) {
            return {
              title: "Escalate failed",
              output:
                "No eligible strong models (quota exhausted). Stay on the parent model or /jev-reset.",
            };
          }
          try {
            sessions.markEscalateCalled(ctx.sessionID);
            const existing = sessions.getActiveStrongChild(ctx.sessionID);
            const result = await spawnOrResumeChild({
              parentID: ctx.sessionID,
              task: args.task,
              model: picked.model,
              usedFallback: picked.usedFallback,
              existingChildId: existing,
              strong: true,
              deps: spawnDeps(),
            });
            await toast(
              `Escalated to ${result.model}${result.resumed ? " (resumed)" : ""}${picked.usedFallback ? " via fallback" : ""} · ${result.contextMode} ${result.contextBytes}B`,
              "success",
            );
            return {
              title: `Escalated → ${result.model}`,
              output: result.text,
              metadata: {
                childID: result.childID,
                model: result.model,
                resumed: result.resumed,
                usedFallback: result.usedFallback,
                contextBytes: result.contextBytes,
                contextMode: result.contextMode,
              },
            };
          } catch (error) {
            return {
              title: "Escalate failed",
              output: cleanError(error),
            };
          }
        },
      }),

      jev_parallel: tool({
        description:
          "Spawn a cheap child subagent for an independent mechanical subtask (max concurrent children enforced). Merge results yourself.",
        args: {
          task: tool.schema.string().describe("Independent subtask for a cheap child"),
        },
        async execute(args, ctx) {
          const catalog = await ensureKnown();
          if (!catalog) {
            return {
              title: "Parallel failed",
              output: "Model catalog unavailable; cannot spawn.",
            };
          }
          known = catalog;
          if (!sessions.canSpawn(ctx.sessionID, orch.maxConcurrentChildren)) {
            return {
              title: "Parallel failed",
              output: `Already at maxConcurrentChildren (${orch.maxConcurrentChildren}).`,
            };
          }
          const picked = pickParallelModel(resolved, selectOpts());
          if (!picked) {
            return {
              title: "Parallel failed",
              output: "No eligible cheap models.",
            };
          }
          try {
            const result = await spawnOrResumeChild({
              parentID: ctx.sessionID,
              task: args.task,
              model: picked.model,
              usedFallback: picked.usedFallback,
              strong: false,
              deps: spawnDeps(),
            });
            await toast(`Parallel child on ${result.model}`, "success");
            return {
              title: `Parallel → ${result.model}`,
              output: result.text,
              metadata: {
                childID: result.childID,
                model: result.model,
              },
            };
          } catch (error) {
            return {
              title: "Parallel failed",
              output: cleanError(error),
            };
          }
        },
      }),
    },

    event: async ({ event }) => {
      try {
        const props = (event as { properties?: Record<string, unknown> })
          .properties;
        if (!props) return;

        if (event.type === "session.deleted") {
          const info = props.info as { id?: string } | undefined;
          if (typeof info?.id === "string") sessions.forget(info.id);
          return;
        }

        if (event.type === "session.created" || event.type === "session.updated") {
          const info = props.info as {
            id?: string;
            parentID?: string | null;
          } | undefined;
          if (typeof info?.id === "string" && info.parentID) {
            sessions.markInternal(info.id);
          }
          return;
        }

        if (event.type === "session.error") {
          const sessionID = props.sessionID as string | undefined;
          const error = props.error;
          const served = sessionID
            ? sessions.getLastServed(sessionID)
            : undefined;
          const modelRef =
            modelPropAsRef(props.model) ||
            (served ? formatModelRef(served) : undefined);
          if (error) {
            quota.appendError({
              kind: "session.error",
              sessionID,
              model: modelRef,
              error,
            });
          }
          if (modelRef && isQuotaError(error)) {
            await markQuota(modelRef, "session.error");
          }
          return;
        }

        if (event.type === "message.updated") {
          const info = props.info as {
            role?: string;
            sessionID?: string;
            providerID?: string;
            modelID?: string;
            variant?: string;
            tokens?: {
              input?: number;
              cache?: { read?: number; write?: number };
            };
            error?: unknown;
          } | undefined;
          if (!info || info.role !== "assistant" || !info.sessionID) return;

          if (info.providerID && info.modelID) {
            const ref: ModelRef = {
              providerID: info.providerID,
              modelID: info.modelID,
              ...(info.variant ? { variant: info.variant } : {}),
            };
            sessions.setLastServed(info.sessionID, ref);

            if (info.error) {
              const modelRef = formatModelRef(ref);
              quota.appendError({
                kind: "message.error",
                sessionID: info.sessionID,
                model: modelRef,
                error: info.error,
              });
              if (isQuotaError(info.error)) {
                await markQuota(modelRef, "message.error");
              }
            }
          }

          const tokens = info.tokens;
          if (tokens) {
            const total =
              (tokens.input ?? 0) +
              (tokens.cache?.read ?? 0) +
              (tokens.cache?.write ?? 0);
            if (total > 0) sessions.setContextTokens(info.sessionID, total);
          }
        }
      } catch (error) {
        await log(`event handler error: ${cleanError(error)}`, "warn");
      }
    },

    "command.execute.before": async (cmdInput, output) => {
      if (cmdInput.command === "jev-off") {
        sessions.setAutomatic(cmdInput.sessionID, false);
        setCommandResult(output, "Jev automatic routing is OFF for this session.");
        await toast("Automatic routing OFF for this session", "warning");
      } else if (cmdInput.command === "jev-on") {
        sessions.setAutomatic(cmdInput.sessionID, true);
        setCommandResult(output, "Jev automatic routing is ON for this session.");
        await toast("Automatic routing ON for this session", "success");
      } else if (cmdInput.command === "jev-status") {
        const on = sessions.isAutomatic(cmdInput.sessionID, resolved.enabled);
        const key = Boolean(resolveKey());
        const period = deepSeekPeriod(new Date(nowFn()));
        const sticky = modelForTier(resolved, orch.parentTier, {
          now: nowFn(),
          at: new Date(nowFn()),
        });
        const message = [
          key
            ? "Jev key present"
            : "Jev key MISSING — set JEV_KEY or ~/.config/opencode/opencode-jev-orchestrator.key",
          `routing ${on ? "ON" : "OFF"}`,
          `sticky parent ${sticky ? formatModelRef(sticky.model) : orch.parentTier}`,
          `DeepSeek ${period}`,
        ].join("; ");
        setCommandResult(output, message);
        await toast(message, key ? "info" : "warning");
      } else if (cmdInput.command === "jev-explain") {
        setCommandResult(output, sessions.explain(cmdInput.sessionID));
        await toast("Last routing decision shown", "info");
      } else if (cmdInput.command === "jev-quota") {
        const rows = quota.list(nowFn());
        if (!rows.length) {
          setCommandResult(output, "No models currently marked exhausted.");
        } else {
          const lines = rows.map((row) => {
            const until = new Date(row.exhaustedUntil).toLocaleString();
            return `${row.ref} until ${until} (${row.reason})`;
          });
          setCommandResult(output, ["Exhausted models:", ...lines].join("\n"));
        }
      } else if (cmdInput.command === "jev-exhausted") {
        const args = cmdInput.arguments.trim().split(/\s+/).filter(Boolean);
        const target = args[0];
        if (!target) {
          setCommandResult(
            output,
            "Usage: /jev-exhausted <tier|provider/model> [hours]",
          );
          return;
        }
        const hours =
          args[1] === undefined
            ? resolved.quota.cooldownHours
            : Number(args[1]);
        if (!Number.isFinite(hours) || hours < 0.1 || hours > 168) {
          setCommandResult(
            output,
            "Hours must be a number between 0.1 and 168.",
          );
          return;
        }
        const refs: string[] = [];
        if (isTier(target)) {
          refs.push(...tierCandidates(resolved, target));
        } else if (parseModelRef(target)) {
          refs.push(target);
        } else {
          setCommandResult(output, `Unknown target: ${target}`);
          return;
        }
        if (!refs.length) {
          setCommandResult(output, `No models configured for ${target}`);
          return;
        }
        const until = nowFn() + hours * 60 * 60 * 1000;
        for (const ref of refs) quota.mark(ref, until, "manual", nowFn());
        setCommandResult(
          output,
          `Marked exhausted until ${new Date(until).toLocaleString()}: ${refs.join(", ")}`,
        );
        await toast(`Exhausted: ${refs.join(", ")}`, "warning");
      } else if (cmdInput.command === "jev-reset") {
        const target = cmdInput.arguments.trim();
        if (!target) {
          quota.clear();
          setCommandResult(output, "Cleared all exhaustion marks.");
        } else if (parseModelRef(target)) {
          quota.clear(target);
          setCommandResult(output, `Cleared exhaustion for ${target}.`);
        } else if (isTier(target)) {
          const refs = tierCandidates(resolved, target as Tier);
          for (const ref of refs) quota.clear(ref);
          setCommandResult(
            output,
            refs.length
              ? `Cleared exhaustion for ${refs.join(", ")}.`
              : `No models configured for ${target}.`,
          );
        } else {
          setCommandResult(output, `Unknown target: ${target}`);
        }
      }
    },

    "chat.message": async (msgInput, output) => {
      try {
        if (output.message.role !== "user") return;
        if (sessions.isInternal(msgInput.sessionID)) return;
        if (!sessions.isAutomatic(msgInput.sessionID, resolved.enabled)) return;

        const prompt = extractPromptText(
          output.parts,
          resolved.routing.maxPromptBytes,
        );
        if (!prompt) return;

        const incoming =
          msgInput.model ??
          (output.message.model as { providerID: string; modelID: string });

        if (!isManagedModel(resolved, incoming)) {
          sessions.record({
            at: nowFn(),
            sessionID: msgInput.sessionID,
            prompt,
            currentTier: tierOfModel(resolved, incoming),
            jev: null,
            decision: {
              tier: tierOfModel(resolved, incoming),
              reason: "pinned",
              changed: false,
            },
            action: "stay",
          });
          if (
            sessions.shouldToastPin(msgInput.sessionID) &&
            resolved.echoRouting
          ) {
            await toast("Pinned model; Jev routing skipped · /jev-on", "info");
          }
          return;
        }

        const catalog = await ensureKnown();
        if (catalog === undefined) {
          if (resolved.echoRouting) {
            await toast("Model catalog unavailable; keeping sticky parent", "warning");
          }
          return;
        }

        const at = new Date(nowFn());
        const opts = { known: catalog, quota, now: nowFn(), at };
        const eligible = resolveAvailableTiers(resolved, opts);
        const configAvailable = configAvailableTiers(resolved, catalog);
        if (!eligible.length && !configAvailable.length) return;

        const stickySelected = modelForTier(resolved, orch.parentTier, opts);
        if (!stickySelected) {
          if (resolved.echoRouting) {
            await toast("No sticky parent model eligible; keeping current", "warning");
          }
          return;
        }

        const override = detectOverride(prompt, overridePatterns);
        let jevError: string | undefined;
        let jev = null as Awaited<ReturnType<typeof ask>>;
        if (!override && eligible.length > 0) {
          jev = await ask(
            {
              prompt,
              current: orch.parentTier,
              contextTokens: sessions.getContextTokens(msgInput.sessionID),
              available: eligible,
              routing: resolved.routing,
            },
            {
              resolveKey,
              onError: (message) => {
                jevError = message;
                void log(message, "warn");
              },
            },
          );
        }

        const hasStrongStreak = Boolean(
          sessions.getActiveStrongChild(msgInput.sessionID),
        );
        const actionDecision = decideAction({
          prompt,
          jev,
          parentTier: orch.parentTier,
          hasStrongStreak,
          orchestration: orch,
          overridePatterns,
          thresholds: resolved.routing,
        });

        if (actionDecision.action === "release") {
          sessions.clearStrongStreak(msgInput.sessionID);
        }

        // Escape hatch: explicit "use luna" etc. mutates parent model.
        if (actionDecision.overrideTier) {
          const legacy = decide({
            prompt,
            jev,
            current: orch.parentTier,
            available: eligible,
            configAvailable,
            contextTokens: sessions.getContextTokens(msgInput.sessionID),
            overridePatterns,
            thresholds: resolved.routing,
          });
          const selected = modelForTier(resolved, legacy.tier, opts);
          sessions.setLastTier(msgInput.sessionID, legacy.tier);
          sessions.setLastJevAction(msgInput.sessionID, "stay");
          sessions.record({
            at: nowFn(),
            sessionID: msgInput.sessionID,
            prompt,
            currentTier: orch.parentTier,
            jev: jev
              ? { choice: jev.choice, confidence: jev.confidence }
              : null,
            metrics: jev?.metrics,
            decision: legacy,
            action: "stay",
            model: selected ? formatModelRef(selected.model) : undefined,
            usedFallback: selected?.usedFallback,
            latencyMs: jev?.ms,
          });
          if (selected) applyModel(output.message, selected.model);
          if (resolved.echoRouting && selected) {
            await toast(
              `Override → ${formatModelRef(selected.model)} · /jev-off`,
              "success",
            );
          }
          return;
        }

        // Sticky cheap parent — never mutate onto strong/long.
        applyModel(output.message, stickySelected.model);
        sessions.setLastTier(msgInput.sessionID, orch.parentTier);
        sessions.setLastJevAction(msgInput.sessionID, actionDecision.action);
        sessions.record({
          at: nowFn(),
          sessionID: msgInput.sessionID,
          prompt,
          currentTier: orch.parentTier,
          jev: jev
            ? { choice: jev.choice, confidence: jev.confidence }
            : null,
          metrics: jev?.metrics,
          decision: {
            tier: orch.parentTier,
            reason: actionDecision.reason,
            changed:
              formatModelRef(incoming) !== formatModelRef(stickySelected.model),
          },
          action: actionDecision.action,
          model: formatModelRef(stickySelected.model),
          usedFallback: stickySelected.usedFallback,
          latencyMs: jev?.ms,
        });

        if (sessions.consumeEscalateMiss(msgInput.sessionID)) {
          await log(
            `escalate hint missed (parent did not call jev_escalate) session=${msgInput.sessionID}`,
            "warn",
          );
        }

        const hint = actionHint(actionDecision.action, prompt);
        if (hint) {
          output.parts.push({
            type: "text",
            text: hint,
            synthetic: true,
          } as (typeof output.parts)[number]);
          if (actionDecision.action === "escalate") {
            sessions.markEscalateHinted(msgInput.sessionID, nowFn());
          }
        }

        if (resolved.echoRouting) {
          if (actionDecision.action === "escalate") {
            await toast(
              `Sticky ${formatModelRef(stickySelected.model)}; escalate via jev_escalate`,
              "info",
            );
          } else if (actionDecision.action === "parallel") {
            await toast(
              `Sticky ${formatModelRef(stickySelected.model)}; use jev_parallel`,
              "info",
            );
          } else if (actionDecision.action === "release") {
            await toast("Strong streak released; parent continues", "success");
          } else if (!jev && !override) {
            await toast(
              jevError
                ? `Jev unavailable (${jevError}); sticky parent held`
                : "Routing unavailable; sticky parent held",
              "warning",
            );
          }
        }
      } catch (error) {
        if (!resolved.routing.failOpen) throw error;
        await toast(
          `Routing error; keeping current model: ${cleanError(error)}`,
          "warning",
        );
      }
    },
  };
}
