import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { askJev as defaultAskJev, resolveApiKey as defaultResolveApiKey } from "./jev.js";
import type { AskJevDeps, AskJevInput } from "./jev.js";
import type { JevResult } from "./types.js";
import {
  configAvailableTiers,
  formatModelRef,
  isEligibleCandidate,
  isManagedModel,
  modelForTier,
  parseModelRef,
  resolveAvailableTiers,
  tierCandidates,
  tierOfModel,
} from "./models.js";
import { buildOverridePatterns, decide, detectOverride } from "./policy.js";
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
  const overridePatterns = buildOverridePatterns(resolved.tiers);

  let known = deps.known;
  let catalogFailedAt = 0;

  const toast = async (message: string, variant: ToastVariant = "info") => {
    try {
      await Promise.race([
        input.client.tui.showToast({
          body: { title: "Jev Router", message, variant, duration: 5000 },
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
        body: { service: "opencode-jev-router", level, message },
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

  return {
    config: async (cfg) => {
      cfg.command = {
        ...cfg.command,
        "jev-on": {
          template: "jev-on",
          description: "Enable Jev automatic model routing for this session",
        },
        "jev-off": {
          template: "jev-off",
          description: "Disable Jev automatic model routing for this session",
        },
        "jev-status": {
          template: "jev-status",
          description: "Show Jev router status for this session",
        },
        "jev-explain": {
          template: "jev-explain",
          description: "Explain the last Jev routing decision",
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
        const message = [
          key
            ? "Jev key present"
            : "Jev key MISSING — set JEV_KEY or ~/.config/opencode/opencode-jev-router.key",
          `routing ${on ? "ON" : "OFF"}`,
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
            await toast("Model catalog unavailable; keeping current", "warning");
          }
          return;
        }

        const at = new Date(nowFn());
        const selectOpts = { known: catalog, quota, now: nowFn(), at };
        const eligible = resolveAvailableTiers(resolved, selectOpts);
        const configAvailable = configAvailableTiers(resolved, catalog);
        if (!eligible.length && !configAvailable.length) return;

        const lastServed = sessions.getLastServed(msgInput.sessionID);
        const current =
          sessions.getLastTier(msgInput.sessionID) ??
          tierOfModel(resolved, lastServed ?? incoming);
        const contextTokens = sessions.getContextTokens(msgInput.sessionID);

        const override = detectOverride(prompt, overridePatterns);
        let jevError: string | undefined;
        let jev = null as Awaited<ReturnType<typeof ask>>;
        // Skip Jev when an explicit override is present or nothing is eligible.
        if (!override && eligible.length > 0) {
          jev = await ask(
            {
              prompt,
              current,
              contextTokens,
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

        const decision = decide({
          prompt,
          jev,
          current,
          available: eligible,
          configAvailable,
          contextTokens,
          overridePatterns,
          thresholds: resolved.routing,
        });

        // Unchanged tier: keep the model already on the message when it is
        // still eligible. Avoids peak-hour swaps when Jev is down.
        if (
          !decision.changed &&
          isEligibleCandidate(
            resolved,
            decision.tier,
            output.message.model,
            selectOpts,
          )
        ) {
          sessions.setLastTier(msgInput.sessionID, decision.tier);
          sessions.record({
            at: nowFn(),
            sessionID: msgInput.sessionID,
            prompt,
            currentTier: current,
            jev: jev
              ? { choice: jev.choice, confidence: jev.confidence }
              : null,
            metrics: jev?.metrics,
            decision,
            model: formatModelRef(output.message.model),
            latencyMs: jev?.ms,
          });
          if (!jev && !override && resolved.echoRouting) {
            await toast(
              jevError
                ? `Jev unavailable (${jevError}); keeping current model`
                : "Routing unavailable; keeping current model",
              "warning",
            );
          }
          return;
        }

        const selected = modelForTier(resolved, decision.tier, selectOpts);
        const modelLabel = selected
          ? formatModelRef(selected.model)
          : undefined;

        sessions.setLastTier(msgInput.sessionID, decision.tier);
        sessions.record({
          at: nowFn(),
          sessionID: msgInput.sessionID,
          prompt,
          currentTier: current,
          jev: jev
            ? { choice: jev.choice, confidence: jev.confidence }
            : null,
          metrics: jev?.metrics,
          decision,
          model: modelLabel,
          usedFallback: selected?.usedFallback,
          latencyMs: jev?.ms,
        });

        if (!selected) {
          if (resolved.echoRouting) {
            await toast("No eligible Go models; keeping current", "warning");
          }
          return;
        }

        const same =
          selected.model.providerID === output.message.model.providerID &&
          selected.model.modelID === output.message.model.modelID &&
          (selected.model.variant ?? undefined) ===
            ((output.message.model as { variant?: string }).variant ??
              undefined);

        if (same) {
          if (!jev && !override && resolved.echoRouting) {
            await toast(
              jevError
                ? `Jev unavailable (${jevError}); keeping current model`
                : "Routing unavailable; keeping current model",
              "warning",
            );
          }
          return;
        }

        applyModel(output.message, selected.model);

        if (resolved.echoRouting) {
          const label = selected.model.variant
            ? `${formatModelRef(selected.model)} (${selected.model.variant})`
            : formatModelRef(selected.model);
          const via = selected.usedFallback ? " via fallback" : "";
          const why = jev
            ? ` · jev ${decision.tier} ${Math.round(jev.confidence * 100)}% ${jev.ms}ms`
            : ` · ${decision.reason}`;
          await toast(`Routed to ${label}${via}${why} · /jev-off`, "success");
          await log(
            `Routed session ${msgInput.sessionID} to ${label} (${decision.reason}${jev ? `, jev=${jev.choice}@${jev.confidence}` : ""})`,
          );
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
