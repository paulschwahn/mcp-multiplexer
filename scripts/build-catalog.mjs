// Writes dist/catalog.json (upstream tool name → annotations) from the bundled @dokploy/mcp. The hook falls
// back to it for Dokploy bundles until a running server has written the list for its own version. Runs after
// tsc to reuse dist/. Listing tools never calls the Dokploy API, so the instance's URL goes nowhere.
import { fileURLToPath } from "node:url";
import { writeCatalog } from "../dist/catalog.js";
import { parseConfig } from "../dist/config.js";
import { UpstreamPool } from "../dist/upstream.js";

const config = parseConfig({ instances: { catalog: { url: "http://127.0.0.1:9", apiKey: "catalog" } } });
const pool = new UpstreamPool(config, () => {});
try {
  const tools = await pool.listTools();
  const label = await pool.label();
  writeCatalog(fileURLToPath(new URL("../dist/catalog.json", import.meta.url)), label, tools);
  const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
  console.log(`dist/catalog.json: ${tools.length} tools, ${readOnly} read-only (${label})`);
} finally {
  await pool.closeAll();
}
