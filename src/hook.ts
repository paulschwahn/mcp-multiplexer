#!/usr/bin/env node
// Claude Code PreToolUse hook: forces an approval prompt before changes to protected instances.
import { readFileSync } from "node:fs";
import { type BundleConfig, loadConfig } from "./config.js";
import { decide, type HookInput, type ToolCatalog } from "./hook-decision.js";

const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;

let config: BundleConfig | Error;
try {
  config = loadConfig();
} catch (error) {
  config = error as Error;
}

let catalog: ToolCatalog | undefined;
try {
  catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")).tools;
} catch {
  // Without the catalog nothing counts as read-only, so protected instances always ask.
}

const reason = decide(input, config, catalog);
if (reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
    }),
  );
}
