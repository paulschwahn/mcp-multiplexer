// Runs against the real @dokploy/mcp package; the instance URL goes nowhere, so no Dokploy is contacted.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createBundleServer } from "../src/server.js";
import { UpstreamPool } from "../src/upstream.js";

const config = parseConfig({
  tools: { enabledTags: ["project", "previewDeployment"] },
  instances: { nowhere: { url: "http://127.0.0.1:9", apiKey: "dummy" } },
});

let pool: UpstreamPool;
let client: Client;

beforeAll(async () => {
  pool = new UpstreamPool(config, () => {});
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createBundleServer(config, pool, { log: () => {}, catalogPath: null }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await pool.closeAll();
});

it("lists only the enabled tags, each with the instance argument", async () => {
  const { tools } = await client.listTools();
  const upstream = tools.filter((tool) => !tool.name.startsWith("bundle-"));
  expect(new Set(upstream.map((tool) => tool.name.split("-")[0]))).toEqual(new Set(["project", "previewDeployment"]));
  for (const tool of upstream) expect(tool.inputSchema.required?.[0]).toBe("instance");
});

it("forwards calls to the upstream process", async () => {
  const result = (await client.callTool({ name: "project-all", arguments: { instance: "nowhere" } })) as CallToolResult;
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("ECONNREFUSED 127.0.0.1:9");
});
