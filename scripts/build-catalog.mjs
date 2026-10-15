// Writes dist/catalog.json (upstream tool name → annotations) for the protected-instance hook.
// Runs after tsc, so it can reuse the compiled pool.
import { readFileSync, writeFileSync } from "node:fs";
import { UpstreamPool } from "../dist/upstream.js";

const upstream = JSON.parse(
  readFileSync(new URL("../node_modules/@dokploy/mcp/package.json", import.meta.url), "utf8"),
);
const pool = new UpstreamPool({ instances: [], env: {}, tools: { enabledTags: [], disabledTags: [] } }, () => {});
const tools = await pool.listTools();
const catalog = Object.fromEntries(
  tools.map((tool) => [
    tool.name,
    { readOnlyHint: tool.annotations?.readOnlyHint === true, destructiveHint: tool.annotations?.destructiveHint === true },
  ]),
);
writeFileSync(
  new URL("../dist/catalog.json", import.meta.url),
  `${JSON.stringify({ upstream: `${upstream.name}@${upstream.version}`, tools: catalog }, null, 2)}\n`,
);
const readOnly = Object.values(catalog).filter((hints) => hints.readOnlyHint).length;
console.log(`dist/catalog.json: ${tools.length} tools, ${readOnly} read-only (${upstream.name}@${upstream.version})`);
