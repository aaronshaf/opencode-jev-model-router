import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { createHooks } from "./adapter.js";
import { loadConfig } from "./config.js";

/**
 * Plugin entry only. Named helpers live on their own modules so older OpenCode
 * loaders that call every export never double-register hooks.
 */
const server: Plugin = async (input) => {
  try {
    const config = await loadConfig(input.directory);
    return createHooks(input, config);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Invalid Jev orchestrator configuration";
    try {
      await input.client.app.log({
        body: {
          service: "opencode-jev-orchestrator",
          level: "error",
          message,
        },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // logging must not prevent the host from starting
    }
    return {};
  }
};

export default {
  id: "opencode-jev-orchestrator",
  server,
} satisfies PluginModule;
