import { existsSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapter, defaultAuthDir } from "../src/adapters.js";
import { type BundleConfig, parseConfig } from "../src/config.js";
import { createBundleServer } from "../src/server.js";
import { UpstreamPool } from "../src/upstream.js";
import { createEchoServer } from "./echo-server.mjs";

const echo = fileURLToPath(new URL("./echo-server.mjs", import.meta.url));
process.env.TEST_SECRET_NORTH = "north-token";
delete process.env.TEST_SECRET_MISSING;

async function connect(config: BundleConfig) {
  const pool = new UpstreamPool(config, () => {});
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createBundleServer(config, pool, { log: () => {}, catalogPath: null }).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "";
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
  const close = async () => {
    await client.close();
    await pool.closeAll();
  };
  return { client, call, close };
}

describe("command bundles", () => {
  const config = parseConfig(
    {
      type: "command",
      argument: "workspace",
      upstream: { command: process.execPath, args: [echo] },
      checkTool: "whoami",
      instances: {
        alpha: { args: ["--alpha"], env: { ECHO_MARKER: "a" } },
        beta: { env: { ECHO_MARKER: "b" }, protected: true },
      },
    },
    "test",
    "echo",
  );
  let bundle: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    process.env.TEST_SECRET_COMMAND = "must-not-leak";
    bundle = await connect(config);
  });
  afterAll(() => bundle.close());

  it("routes on the configured argument and skips tools that already have it", async () => {
    const { tools } = await bundle.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["bundle-instances", "bundle-check", "whoami", "save_issue"]);
    const save = tools.find((tool) => tool.name === "save_issue");
    expect(save?.inputSchema.required).toEqual(["workspace", "title"]);
    expect(save?.inputSchema.properties?.workspace).toMatchObject({
      enum: ["alpha", "beta"],
      description: "Workspace to act on. Protected, changes need approval: beta.",
    });
  });

  it("starts each instance with its own args and env, and nothing else from this process", async () => {
    expect((await bundle.call("save_issue", { workspace: "beta", title: "Hi" })).json()).toMatchObject({
      args: { title: "Hi" },
      marker: "b",
      argv: [],
      leakedSecrets: [],
    });
    expect((await bundle.call("whoami", { workspace: "alpha" })).json()).toMatchObject({
      marker: "a",
      argv: ["--alpha"],
    });
  });

  it("checks each instance with the check tool", async () => {
    const results = (await bundle.call("bundle-check", {})).json();
    expect(results).toMatchObject([
      { workspace: "alpha", ok: true },
      { workspace: "beta", ok: true },
    ]);
    expect(JSON.parse(results[1].result)).toMatchObject({ tool: "whoami", marker: "b" });
  });

  it("lists instances under the argument's name", async () => {
    expect((await bundle.call("bundle-instances", {})).json()).toEqual({
      upstream: `${process.execPath} ${echo}`,
      workspaces: [
        { name: "alpha", description: null, protected: false, args: ["--alpha"], connected: true },
        { name: "beta", description: null, protected: true, connected: true },
      ],
    });
  });
});

describe("url bundles with headers", () => {
  let http: HttpServer;
  let bundle: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    // Stateless Streamable HTTP: a fresh MCP server per request.
    http = createServer(async (req, res) => {
      const server = createEchoServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    bundle = await connect(
      parseConfig(
        {
          type: "url",
          argument: "workspace",
          upstream: { url: `http://127.0.0.1:${port}/mcp` },
          instances: {
            north: { headers: { Authorization: "Bearer ${TEST_SECRET_NORTH}" } },
            acme: { headers: { Authorization: "Bearer acme-literal" } },
            broken: { headers: { Authorization: "Bearer ${TEST_SECRET_MISSING}" } },
          },
        },
        "test",
        "remote",
      ),
    );
  });
  afterAll(async () => {
    await bundle.close();
    await new Promise((resolve) => http.close(resolve));
  });

  it("sends each instance's own headers", async () => {
    expect((await bundle.call("whoami", { workspace: "north" })).json().authorization).toBe("Bearer north-token");
    expect((await bundle.call("whoami", { workspace: "acme" })).json().authorization).toBe("Bearer acme-literal");
  });

  it("pings each instance and names a missing variable", async () => {
    expect((await bundle.call("bundle-check", {})).json()).toEqual([
      { workspace: "north", ok: true },
      { workspace: "acme", ok: true },
      { workspace: "broken", ok: false, error: "environment variable TEST_SECRET_MISSING is not set" },
    ]);
  });

  it("shows header names but never their values", async () => {
    const result = await bundle.call("bundle-instances", {});
    expect(result.text).not.toContain("north-token");
    expect(result.text).not.toContain("acme-literal");
    expect(result.json().workspaces[0]).toMatchObject({ name: "north", headers: ["Authorization"] });
  });
});

describe("url bundles with OAuth", () => {
  const config = parseConfig(
    {
      type: "url",
      argument: "workspace",
      upstream: { url: "https://mcp.linear.app/mcp", auth: "oauth" },
      instances: { north: { authDir: "~/.mcp-auth/linear-north" }, acme: {} },
    },
    "test",
    "linear",
  );
  const adapter = createAdapter(config, () => {});

  it("runs mcp-remote per instance with that instance's token directory", async () => {
    const [north, acme] = await Promise.all(config.instances.map((instance) => adapter.connection(instance)));
    expect(north).toMatchObject({
      kind: "stdio",
      command: process.execPath,
      args: [expect.stringMatching(/mcp-remote\/dist\/proxy\.js$/), "https://mcp.linear.app/mcp", "--auth-timeout", "300"],
      env: { MCP_REMOTE_CONFIG_DIR: join(homedir(), ".mcp-auth", "linear-north") },
      initTimeoutMs: 300_000,
    });
    expect(existsSync((north as { args: string[] }).args[0]!)).toBe(true);
    expect(acme).toMatchObject({ env: { MCP_REMOTE_CONFIG_DIR: defaultAuthDir("linear", "acme") } });
  });

  it("names mcp-remote's version", async () => {
    expect(await adapter.label()).toMatch(/^https:\/\/mcp\.linear\.app\/mcp \(OAuth via mcp-remote@\d+\.\d+\.\d+\)$/);
  });
});
