#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type BundleConfig, loadConfig } from "./config.js";
import { createBundleServer } from "./server.js";
import { UpstreamPool } from "./upstream.js";

let config: BundleConfig;
try {
  config = loadConfig();
} catch (error) {
  process.stderr.write(`dokploy-bundle-mcp: ${(error as Error).message}\n`);
  process.exit(1);
}

const pool = new UpstreamPool(config);
const server = createBundleServer(config, pool);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await pool.closeAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);

await server.connect(new StdioServerTransport());
// Start resolving the upstream (for Dokploy: which @dokploy/mcp version) now rather than on the first call.
void pool.label();
