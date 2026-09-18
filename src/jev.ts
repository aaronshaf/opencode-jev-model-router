import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
} from "./config.js";
import type { JevResult, RouterConfig, Tier } from "./types.js";

let client: TypeSafeClient | undefined;
let cachedKey: string | undefined;

/** Env vars first, then ~/.config/opencode key files (OpenCode often lacks shell exports). */
export function resolveApiKey(
  env: NodeJS.ProcessEnv = process.env,
  opts: { configDir?: string; skipFiles?: boolean } = {},
): string | undefined {
  const fromEnv = env.JEV_API_KEY || env.JEV_KEY || env.TYPESAFE_API_KEY;
  if (fromEnv?.trim()) return fromEnv.trim();
  if (opts.skipFiles) return undefined;

  if (cachedKey && !opts.configDir) return cachedKey;

  const configDir = opts.configDir ?? join(homedir(), ".config", "opencode");
  const keyFile = join(configDir, "opencode-jev-router.key");
  if (existsSync(keyFile)) {
    try {
      const raw = readFileSync(keyFile, "utf8").trim();
      if (raw && !raw.includes("\n")) {
        if (!opts.configDir) cachedKey = raw;
        return raw;
      }
    } catch {
      // ignore
    }
  }

  const envFile = join(configDir, ".env");
  if (existsSync(envFile)) {
    try {
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const m = /^(?:JEV_API_KEY|JEV_KEY|TYPESAFE_API_KEY)\s*=\s*(.*)$/.exec(
          line.trim(),
        );
        if (!m) continue;
        let value = m[1]!.trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (value) {
          if (!opts.configDir) cachedKey = value;
          return value;
        }
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

/** Tests only. */
export function resetJevClient(): void {
  client = undefined;
  cachedKey = undefined;
}

function getClient(config: RouterConfig["routing"], apiKey: string): TypeSafeClient {
  client ??= new TypeSafeClient({
    apiKey,
    timeout: config.timeoutMs,
    retry: {
      maxRetries: config.maxRetries,
      backoffInitialMs: 150,
      backoffMaxMs: 400,
    },
    logLevel: "warn",
  });
  return client;
}

export type AskJevInput = {
  prompt: string;
  current: Tier;
  contextTokens: number;
  available: Tier[];
  routing: RouterConfig["routing"];
};

export type AskJevDeps = {
  /** Override for tests. */
  systemOne?: (
    request: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<{
    answers: {
      model_tier?: { choice?: string; confidence?: number };
      task_complexity?: { score?: number };
      reasoning_required?: { score?: number };
      tool_complexity?: { score?: number };
    };
  }>;
  resolveKey?: () => string | undefined;
  onError?: (message: string) => void;
};

/**
 * Ask Jev which tier fits this prompt. Returns null on any failure — never
 * blocks the user turn.
 */
export async function askJev(
  input: AskJevInput,
  deps: AskJevDeps = {},
): Promise<JevResult | null> {
  const { prompt, current, contextTokens, available, routing } = input;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), routing.deadlineMs);

  const request = {
    state: {
      request: prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: available },
    },
    questions: QUESTIONS,
  };

  const fail = (message: string): null => {
    deps.onError?.(message);
    return null;
  };

  try {
    const apiKey = (deps.resolveKey ?? (() => resolveApiKey()))();
    if (!apiKey) {
      return fail("Jev API key missing (set JEV_KEY or ~/.config/opencode/opencode-jev-router.key)");
    }

    const systemOne =
      deps.systemOne ??
      ((req: unknown, options?: { signal?: AbortSignal }) =>
        getClient(routing, apiKey).systemOne(req as never, options));

    const result = await systemOne(request, { signal: abort.signal });
    const answers = result.answers as {
      model_tier?: { choice?: string; confidence?: number };
      task_complexity?: { score?: number };
      reasoning_required?: { score?: number };
      tool_complexity?: { score?: number };
    };
    const answer = answers.model_tier;
    const task_complexity = answers.task_complexity;
    const reasoning_required = answers.reasoning_required;
    const tool_complexity = answers.tool_complexity;

    if (
      !answer ||
      typeof answer.choice !== "string" ||
      typeof answer.confidence !== "number" ||
      !Number.isFinite(answer.confidence)
    ) {
      return fail("Jev returned a malformed model_tier answer");
    }

    return {
      choice: answer.choice,
      confidence: answer.confidence,
      metrics: {
        taskComplexity: (task_complexity?.score ?? 0) / COMPLEXITY_MAX_SCORE,
        reasoningRequired:
          (reasoning_required?.score ?? 0) / COMPLEXITY_MAX_SCORE,
        toolComplexity: (tool_complexity?.score ?? 0) / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Jev call failed: ${message}`);
  } finally {
    clearTimeout(deadline);
  }
}
