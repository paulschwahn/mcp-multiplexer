#!/usr/bin/env node
// Builds the bundle config from the @dokploy/mcp entries in Claude Desktop's config.
// Copies URLs, keys and extra env as they are; prints instance names only, never keys.
// Does not touch the Claude Desktop config.
// Usage: node scripts/import-desktop-config.mjs [path/to/claude_desktop_config.json] [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const force = args.includes("--force");
const desktopPath = args.find((arg) => !arg.startsWith("--")) ?? defaultDesktopConfigPath();
const outPath = process.env.MCP_MULTIPLEXER_CONFIG || join(homedir(), ".config", "mcp-multiplexer", "config.json");

function defaultDesktopConfigPath() {
  const file = "claude_desktop_config.json";
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", file);
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", file);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", file);
}

if (existsSync(outPath) && !force) {
  console.error(`${outPath} already exists; pass --force to overwrite it.`);
  process.exit(1);
}

const desktop = JSON.parse(readFileSync(desktopPath, "utf8"));
const entries = Object.entries(desktop.mcpServers ?? {}).filter(([, server]) =>
  (server.args ?? []).some((arg) => String(arg).startsWith("@dokploy/mcp")),
);
if (entries.length === 0) {
  console.error(`No @dokploy/mcp servers in ${desktopPath}.`);
  process.exit(1);
}

const instances = {};
for (const [key, server] of entries) {
  const { DOKPLOY_URL: url, DOKPLOY_API_KEY: apiKey, ...env } = server.env ?? {};
  if (!url || !apiKey) {
    console.error(`Skipping ${key}: it has no DOKPLOY_URL or DOKPLOY_API_KEY.`);
    continue;
  }
  const name = key.replace(/^dokploy-/, "").replace(/-mcp$/, "");
  instances[name] = { url, apiKey, protected: /prod/.test(name), ...(Object.keys(env).length ? { env } : {}) };
}

const config = {
  tools: {
    enabledTags: [
      "project",
      "environment",
      "server",
      "application",
      "compose",
      "domain",
      "deployment",
      "previewDeployment",
      "postgres",
      "docker",
    ],
  },
  instances,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

console.log(`Wrote ${outPath} (mode 600) with ${Object.keys(instances).length} instances:`);
for (const [name, instance] of Object.entries(instances)) {
  console.log(`  ${name}${instance.protected ? "  (protected)" : ""}`);
}
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
console.log(`
Next, in ${desktopPath}, replace the ${entries.length} entries (${entries.map(([key]) => key).join(", ")}) with:

    "dokploy": {
      "command": ${JSON.stringify(process.execPath)},
      "args": [${JSON.stringify(entry)}]
    }`);
