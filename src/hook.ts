#!/usr/bin/env node
// Claude Code PreToolUse hook: forces an approval prompt before changes to protected instances.
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

// The server's list for the version it is running; the build-time list until a server has started.
// Without either, nothing counts as read-only, so protected instances always ask.
const catalog = readCatalog([runtimeCatalogPath(), BUNDLED_CATALOG])?.tools;

const reason = decide(input, config, catalog);
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
    }),
  );
}
