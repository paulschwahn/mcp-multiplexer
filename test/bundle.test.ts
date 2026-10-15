import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createBundleServer } from "../src/server.js";
import { UpstreamPool } from "../src/upstream.js";

const stub = fileURLToPath(new URL("./stub-upstream.mjs", import.meta.url));
process.env.TEST_DOKPLOY_KEY_STAGING = "staging-key";
delete process.env.TEST_DOKPLOY_KEY_MISSING;

const config = parseConfig({
  upstream: { command: process.execPath, args: [stub] },
  tools: { enabledTags: ["project", "application"] },
  env: { DOKPLOY_REDACT_ENV: "true" },
  instances: {
    staging: { url: "https://staging.example/", apiKeyEnv: "TEST_DOKPLOY_KEY_STAGING", description: "Staging" },
    prod: { url: "https://prod.example/api", apiKey: "prod-key", protected: true, env: { DOKPLOY_TIMEOUT: "5000" } },
    broken: { url: "https://broken.example", apiKeyEnv: "TEST_DOKPLOY_KEY_MISSING" },
  },
});

const fetchCalls: { url: string; apiKey: string | null }[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  fetchCalls.push({ url, apiKey: new Headers(init?.headers).get("x-api-key") });
  return url.startsWith("https://staging.example")
    ? new Response(JSON.stringify("v0.25.3"), { status: 200 })
    : new Response("unauthorized", { status: 401 });
};

const catalogPath = join(mkdtempSync(join(tmpdir(), "mcp-multiplexer-test-")), "catalog.json");
let pool: UpstreamPool;
let client: Client;

beforeAll(async () => {
  pool = new UpstreamPool(config, () => {});
  const server = createBundleServer(config, pool, { fetch: fakeFetch, log: () => {}, catalogPath });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await pool.closeAll();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

describe("tools/list", () => {
  it("adds a required instance argument to every upstream tool", async () => {
    const { tools } = await client.listTools();
    const deploy = tools.find((tool) => tool.name === "application-deploy");
    expect(deploy?.inputSchema.required).toEqual(["instance", "applicationId"]);
    expect(deploy?.inputSchema.properties?.instance).toMatchObject({
      type: "string",
      enum: ["staging", "prod", "broken"],
      description: expect.stringContaining("prod"),
    });
    expect(deploy?.annotations).toEqual({ title: "Application Deploy", idempotentHint: true });
    expect(tools.map((tool) => tool.name)).toEqual([
      "bundle-instances",
      "bundle-check",
      "project-all",
      "application-deploy",
    ]);
  });

  it("writes the read-only list of the running upstream for the hook", () => {
    expect(JSON.parse(readFileSync(catalogPath, "utf8"))).toEqual({
      upstream: `custom command: ${process.execPath} ${stub}`,
      tools: {
        "project-all": { readOnlyHint: true, destructiveHint: false },
        "application-deploy": { readOnlyHint: false, destructiveHint: false },
      },
    });
  });
});

describe("tools/call", () => {
  it("routes to the named instance and forwards the rest of the arguments", async () => {
    const result = await call("application-deploy", { instance: "prod", applicationId: "app-1" });
    expect(result.isError).toBe(false);
    expect(result.json()).toMatchObject({
      tool: "application-deploy",
      args: { applicationId: "app-1" },
      url: "https://prod.example",
      apiKey: "prod-key",
      enabledTags: "project,application",
      redactEnv: "true",
      timeout: "5000",
    });
  });

  it("gives each process only its own key", async () => {
    const result = await call("project-all", { instance: "staging" });
    expect(result.json()).toMatchObject({ url: "https://staging.example", apiKey: "staging-key", leakedKeys: [] });
  });

  it("rejects a missing or unknown instance", async () => {
    for (const args of [{}, { instance: "unknown" }]) {
      const result = await call("project-all", args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("staging, prod, broken");
    }
  });

  it("reports a missing key without affecting other instances", async () => {
    const broken = await call("project-all", { instance: "broken" });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("TEST_DOKPLOY_KEY_MISSING");
    expect((await call("project-all", { instance: "staging" })).isError).toBe(false);
  });

  it("rejects tools the upstream does not have", async () => {
    const result = await call("stripe-getProducts", { instance: "staging" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Unknown tool");
  });
});

describe("bundle tools", () => {
  it("bundle-instances describes instances and the upstream without exposing keys", async () => {
    const result = await call("bundle-instances", {});
    expect(result.text).not.toContain("prod-key");
    expect(result.text).not.toContain("staging-key");
    expect(result.json().upstream).toBe(`custom command: ${process.execPath} ${stub}`);
    expect(result.json().instances).toContainEqual(
      expect.objectContaining({ name: "staging", apiKey: "from $TEST_DOKPLOY_KEY_STAGING", connected: true }),
    );
  });

  it("bundle-check reports the version or the failure per instance", async () => {
    fetchCalls.length = 0;
    const result = await call("bundle-check", {});
    expect(result.json()).toEqual([
      { instance: "staging", ok: true, version: "v0.25.3" },
      { instance: "prod", ok: false, error: "HTTP 401 (API key rejected)" },
      { instance: "broken", ok: false, error: "environment variable TEST_DOKPLOY_KEY_MISSING is not set" },
    ]);
    expect(fetchCalls).toEqual([
      { url: "https://staging.example/api/settings.getDokployVersion", apiKey: "staging-key" },
      { url: "https://prod.example/api/settings.getDokployVersion", apiKey: "prod-key" },
    ]);
  });
});
