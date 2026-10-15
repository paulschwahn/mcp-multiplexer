#!/usr/bin/env node
// Claude Code PreToolUse hook: forces an approval prompt before changes to protected instances.
// Takes the same --config as the server it guards.
import { readFileSync } from "node:fs";
import { BUNDLED_CATALOG, readCatalog, runtimeCatalogPath } from "./catalog.js";
import { type BundleConfig, loadConfig } from "./config.js";
import { decide, type HookInput } from "./hook-decision.js";

const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;

let config: BundleConfig | Error;
try {
  config = loadConfig();
} catch (error) {
  config = error as Error;
}

// The list the server wrote for the upstream it runs. A Dokploy bundle falls back to the build-time list
// until its server has started. Without either, nothing counts as read-only, so protected instances ask.
const catalog =
  config instanceof Error
    ? undefined
    : readCatalog([runtimeCatalogPath(config.name), ...(config.type === "dokploy" ? [BUNDLED_CATALOG] : [])])?.tools;

const reason = decide(input, config, catalog);
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
    }),
  );
}
