import type { PluginInput } from "@opencode-ai/plugin";
import {
  formatModelRef,
  modelForTier,
  type KnownModels,
  type SelectOptions,
} from "./models.js";
import type { QuotaStore } from "./quota.js";
import type { SessionStore } from "./sessions.js";
import type { ModelRef, OrchestratorConfig } from "./types.js";

export type DelegateClient = PluginInput["client"];

export type MessageBundle = {
  info?: { role?: string; id?: string };
  parts?: Array<{
    type?: string;
    text?: string;
    ignored?: boolean;
    synthetic?: boolean;
    filename?: string;
    name?: string;
    tool?: string;
    state?: { status?: string; output?: unknown; title?: string };
    mime?: string;
  }>;
};

function partSummary(p: NonNullable<MessageBundle["parts"]>[number]): string | null {
  if (p.ignored) return null;
  if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
    if (p.synthetic) return null;
    return p.text.trim();
  }
  if (p.type === "file" || p.type === "attachment") {
    const name = p.filename || p.name || p.mime || "file";
    return `[file: ${name}]`;
  }
  if (p.type === "tool" || p.tool) {
    const name = p.tool || p.name || "tool";
    const title = p.state?.title ? ` ${p.state.title}` : "";
    const out =
      typeof p.state?.output === "string"
        ? p.state.output.slice(0, 400)
        : p.state?.status
          ? `(${p.state.status})`
          : "";
    return `[tool ${name}${title}]${out ? ` ${out}` : ""}`;
  }
  return null;
}

/** Format parent transcript for a child; optionally skip older messages (resume delta). */
export function formatParentContext(
  messages: MessageBundle[],
  maxBytes: number,
  opts: { skipFirst?: number } = {},
): string {
  const skip = Math.max(0, opts.skipFirst ?? 0);
  const slice = skip > 0 ? messages.slice(skip) : messages;
  const lines: string[] = [];
  for (const msg of slice) {
    const role = msg.info?.role ?? "unknown";
    const bits = (msg.parts ?? [])
      .map(partSummary)
      .filter((s): s is string => Boolean(s));
    if (!bits.length) continue;
    lines.push(`${role}: ${bits.join("\n")}`);
  }
  if (!lines.length && skip > 0) {
    return "(no new parent messages since last handoff)";
  }
  let out = lines.join("\n\n");
  const encoder = new TextEncoder();
  if (encoder.encode(out).byteLength <= maxBytes) return out;

  while (lines.length > 1 && encoder.encode(out).byteLength > maxBytes) {
    lines.shift();
    out = lines.join("\n\n");
  }
  if (encoder.encode(out).byteLength > maxBytes) {
    const buf = encoder.encode(out);
    out = new TextDecoder().decode(buf.slice(buf.byteLength - maxBytes));
  }
  return `…(truncated)\n\n${out}`;
}

export async function fetchParentMessages(
  client: DelegateClient,
  parentSessionID: string,
  directory?: string,
): Promise<MessageBundle[]> {
  const result = await client.session.messages({
    path: { id: parentSessionID },
    query: directory ? { directory, limit: 200 } : { limit: 200 },
  });
  if (result.error || !result.data) return [];
  return result.data as MessageBundle[];
}

export async function buildNearFullContext(
  client: DelegateClient,
  parentSessionID: string,
  maxBytes: number,
  directory?: string,
  opts: { skipFirst?: number } = {},
): Promise<{ text: string; messageCount: number }> {
  const messages = await fetchParentMessages(client, parentSessionID, directory);
  return {
    text: formatParentContext(messages, maxBytes, opts),
    messageCount: messages.length,
  };
}

export function pickEscalateModel(
  config: OrchestratorConfig,
  opts: SelectOptions = {},
): { model: ModelRef; usedFallback: boolean } | undefined {
  return modelForTier(config, "strong", opts);
}

export function pickParallelModel(
  config: OrchestratorConfig,
  opts: SelectOptions = {},
): { model: ModelRef; usedFallback: boolean } | undefined {
  return (
    modelForTier(config, "fast", opts) ??
    modelForTier(config, config.orchestration.parentTier, opts)
  );
}

export type SpawnDeps = {
  client: DelegateClient;
  sessions: SessionStore;
  config: OrchestratorConfig;
  directory?: string;
  known?: KnownModels;
  quota?: QuotaStore;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional log sink for compliance / token metrics. */
  log?: (message: string, level?: "info" | "warn" | "error") => void | Promise<void>;
};

export type SpawnResult = {
  childID: string;
  text: string;
  model: string;
  usedFallback: boolean;
  resumed: boolean;
  contextBytes: number;
  contextMode: "full" | "delta";
};

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForIdle(
  client: DelegateClient,
  childID: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  directory?: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.session.status({
      query: directory ? { directory } : undefined,
    });
    const row = status.data?.[childID];
    if (!row || row.type === "idle") return;
    await sleep(500);
  }
  throw new Error(`Child session ${childID} timed out after ${timeoutMs}ms`);
}

function extractLastAssistantText(messages: MessageBundle[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.info?.role !== "assistant") continue;
    const texts = (msg.parts ?? [])
      .map(partSummary)
      .filter((s): s is string => Boolean(s));
    if (texts.length) return texts.join("\n");
  }
  return "(no assistant reply from child)";
}

export async function spawnOrResumeChild(input: {
  parentID: string;
  task: string;
  model: ModelRef;
  usedFallback: boolean;
  existingChildId?: string;
  strong?: boolean;
  deps: SpawnDeps;
}): Promise<SpawnResult> {
  const { parentID, task, model, usedFallback, existingChildId, strong, deps } =
    input;
  const {
    client,
    sessions,
    config,
    directory,
    sleep = defaultSleep,
    log,
  } = deps;
  const orch = config.orchestration;

  let childID = existingChildId;
  let resumed = false;

  if (childID) {
    resumed = true;
  } else {
    if (!sessions.canSpawn(parentID, orch.maxConcurrentChildren)) {
      throw new Error(
        `Already at maxConcurrentChildren (${orch.maxConcurrentChildren})`,
      );
    }
    const created = await client.session.create({
      body: {
        parentID,
        title: strong ? "Jev escalate" : "Jev parallel",
      },
      query: directory ? { directory } : undefined,
    });
    if (created.error || !created.data?.id) {
      throw new Error(
        `Failed to create child session: ${String(created.error ?? "unknown")}`,
      );
    }
    childID = created.data.id;
    sessions.registerChild(parentID, childID, { strong: Boolean(strong) });
  }

  if (strong) {
    sessions.registerChild(parentID, childID, { strong: true });
  }

  const skipFirst =
    resumed && strong ? sessions.getStrongHandoffMessageCount(parentID) : 0;
  const contextMode: "full" | "delta" = skipFirst > 0 ? "delta" : "full";
  const { text: context, messageCount } = await buildNearFullContext(
    client,
    parentID,
    orch.delegateMaxContextBytes,
    directory,
    { skipFirst },
  );
  const contextBytes = new TextEncoder().encode(context).byteLength;

  const promptText = resumed
    ? [
        "Continue the escalation. New parent messages since last handoff (delta):",
        context,
        "",
        "Follow-up task from parent:",
        task,
      ].join("\n")
    : [
        "You are a temporary specialist subagent. Parent session context (near-full):",
        context,
        "",
        "Complete this task and return a concise result the parent can merge:",
        task,
      ].join("\n");

  void log?.(
    `delegate ${resumed ? "resume" : "spawn"} child=${childID} model=${formatModelRef(model)} context=${contextMode} bytes=${contextBytes} parentMsgs=${messageCount}`,
  );

  const prompted = await client.session.prompt({
    path: { id: childID },
    body: {
      model: { providerID: model.providerID, modelID: model.modelID },
      parts: [{ type: "text", text: promptText }],
    },
    query: directory ? { directory } : undefined,
  });
  if (prompted.error) {
    throw new Error(`Child prompt failed: ${String(prompted.error)}`);
  }

  await waitForIdle(client, childID, orch.childTimeoutMs, sleep, directory);

  const messages = await client.session.messages({
    path: { id: childID },
    query: directory ? { directory, limit: 50 } : { limit: 50 },
  });
  const text = extractLastAssistantText(
    (messages.data ?? []) as MessageBundle[],
  );

  if (strong) {
    sessions.setStrongHandoffMessageCount(parentID, messageCount);
  } else {
    // Parallel one-shot: free the concurrent slot.
    sessions.releaseChild(parentID, childID);
  }

  return {
    childID,
    text,
    model: formatModelRef(model),
    usedFallback,
    resumed,
    contextBytes,
    contextMode,
  };
}
