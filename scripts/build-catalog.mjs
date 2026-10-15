// Writes dist/catalog.json (upstream tool name → annotations) from the bundled upstream. The hook falls back
// to it until a running server has written the list for its own version. Runs after tsc to reuse dist/.
import { fileURLToPath } from "node:url";
import { writeCatalog } from "../dist/catalog.js";
import { UpstreamPool } from "../dist/upstream.js";

const pool = new UpstreamPool(
  { instances: [], env: {}, tools: { enabledTags: [], disabledTags: [] }, upstream: { version: "bundled" } },
  () => {},
);
const tools = await pool.listTools();
const { label } = await pool.upstream();
writeCatalog(fileURLToPath(new URL("../dist/catalog.json", import.meta.url)), label, tools);
const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
console.log(`dist/catalog.json: ${tools.length} tools, ${readOnly} read-only (${label})`);
