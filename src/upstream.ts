import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Adapter, type Connection, createAdapter, type Log } from "./adapters.js";
import type { BundleConfig, InstanceConfig } from "./config.js";
import { VERSION } from "./version.js";

const CALL_TIMEOUT_MS = 120_000;

export type { Log };

/**
 * One upstream connection per instance, opened on first use. A stdio upstream only sees its own
 * instance's settings, never the other instances' secrets from this process's environment.
 */
export class UpstreamPool {
  readonly #config: BundleConfig;
  readonly #log: Log;
  readonly #adapter: Adapter;
  readonly #clients = new Map<string, Promise<Client>>();

  constructor(
    config: BundleConfig,
    log: Log = (line) => process.stderr.write(`${line}\n`),
    adapter: Adapter = createAdapter(config, log),
  ) {
    this.#config = config;
    this.#log = log;
    this.#adapter = adapter;
  }

  /** What serves the instances, e.g. "@dokploy/mcp@0.30.7 (latest)". */
  label(): Promise<string> {
    return this.#adapter.label();
  }

  isRunning(instance: string): boolean {
    return this.#clients.has(instance);
  }

  /** Every instance serves the same tools, so the first one that connects lists them. */
  async listTools(): Promise<Tool[]> {
    const failures: string[] = [];
    for (const instance of this.#config.instances) {
      try {
        const client = await this.#client(instance);
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      } catch (error) {
        failures.push(`${instance.name}: ${(error as Error).message}`);
      }
    }
    throw new Error(`no instance could list its tools (${failures.join("; ")})`);
  }

  async callTool(instance: InstanceConfig, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.#client(instance);
    return (await client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as CallToolResult;
  }

  async ping(instance: InstanceConfig): Promise<void> {
    await (await this.#client(instance)).ping();
  }

  async closeAll(): Promise<void> {
    const pending = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(pending.map(async (client) => (await client).close()));
  }

  #client(instance: InstanceConfig): Promise<Client> {
    const existing = this.#clients.get(instance.name);
    if (existing) return existing;
    const pending = (async () => this.#connect(instance.name, await this.#adapter.connection(instance)))();
    const forget = () => {
      if (this.#clients.get(instance.name) === pending) this.#clients.delete(instance.name);
    };
    this.#clients.set(instance.name, pending);
    pending.then((client) => {
      client.onclose = forget;
    }, forget);
    return pending;
  }

  async #connect(label: string, connection: Connection): Promise<Client> {
    let transport: Transport;
    if (connection.kind === "http") {
      transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: connection.headers },
      });
    } else {
      const stdio = new StdioClientTransport({
        command: connection.command,
        args: connection.args,
        env: connection.env,
        stderr: "pipe",
      });
      stdio.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) if (line.trim()) this.#log(`[${label}] ${line}`);
      });
      transport = stdio;
    }
    const client = new Client({ name: "dokploy-bundle-mcp", version: VERSION });
    const timeout = connection.kind === "stdio" ? connection.initTimeoutMs : undefined;
    await client.connect(transport, timeout ? { timeout } : undefined);
    return client;
  }
}
