import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { type BundleConfig, type InstanceConfig, resolveApiKey, toolFilterEnv } from "./config.js";
import { resolveUpstream, type Upstream } from "./upstream-package.js";
import { VERSION } from "./version.js";

/** Listing tools never calls the Dokploy API, so the catalog process gets a URL that goes nowhere. */
const CATALOG_URL = "http://127.0.0.1:9";
const CALL_TIMEOUT_MS = 120_000;

export type Log = (line: string) => void;

/**
 * One @dokploy/mcp process per instance, started on first use. Each process only sees its own
 * URL and key, never the other instances' keys from this process's environment.
 */
export class UpstreamPool {
  readonly #config: BundleConfig;
  readonly #log: Log;
  readonly #clients = new Map<string, Promise<Client>>();
  #upstream: Promise<Upstream> | undefined;

  constructor(config: BundleConfig, log: Log = (line) => process.stderr.write(`${line}\n`)) {
    this.#config = config;
    this.#log = log;
  }

  /** Resolved once per process: every instance runs the same upstream version. */
  upstream(): Promise<Upstream> {
    this.#upstream ??= resolveUpstream(this.#config.upstream, { log: this.#log });
    return this.#upstream;
  }

  isRunning(instance: string): boolean {
    return this.#clients.has(instance);
  }

  /** Every instance runs the same package with the same tool filter, so one throwaway process lists them all. */
  async listTools(): Promise<Tool[]> {
    const client = await this.#connect("catalog", this.#env(CATALOG_URL, "catalog", {}));
    try {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    } finally {
      await client.close();
    }
  }

  async callTool(instance: InstanceConfig, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.#client(instance);
    return (await client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as CallToolResult;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(pending.map(async (client) => (await client).close()));
  }

  #client(instance: InstanceConfig): Promise<Client> {
    const existing = this.#clients.get(instance.name);
    if (existing) return existing;
    const pending = (async () =>
      this.#connect(instance.name, this.#env(instance.url, resolveApiKey(instance), instance.env)))();
    const forget = () => {
      if (this.#clients.get(instance.name) === pending) this.#clients.delete(instance.name);
    };
    this.#clients.set(instance.name, pending);
    pending.then((client) => {
      client.onclose = forget;
    }, forget);
    return pending;
  }

  #env(url: string, apiKey: string, extra: Record<string, string>): Record<string, string> {
    return {
      ...getDefaultEnvironment(),
      ...this.#config.env,
      ...extra,
      ...toolFilterEnv(this.#config.tools),
      DOKPLOY_URL: url,
      DOKPLOY_API_KEY: apiKey,
    };
  }

  async #connect(label: string, env: Record<string, string>): Promise<Client> {
    const { command, args } = await this.upstream();
    const transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
    transport.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) this.#log(`[${label}] ${line}`);
    });
    const client = new Client({ name: "dokploy-bundle-mcp", version: VERSION });
    await client.connect(transport);
    return client;
  }
}
