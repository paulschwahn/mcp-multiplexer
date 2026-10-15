import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { type BundleConfig, type InstanceConfig, resolveApiKey } from "./config.js";
import type { Log, UpstreamPool } from "./upstream.js";
import { VERSION } from "./version.js";

/** Not "server": Dokploy already has servers (remote build hosts, `serverId`). */
export const INSTANCE_ARG = "instance";

const CHECK_TIMEOUT_MS = 10_000;

export interface ServerDeps {
  fetch: typeof fetch;
  log: Log;
}

export function createBundleServer(config: BundleConfig, pool: UpstreamPool, deps: Partial<ServerDeps> = {}): Server {
  const { fetch: fetchFn = globalThis.fetch, log = (line: string) => process.stderr.write(`${line}\n`) } = deps;
  const names = config.instances.map((instance) => instance.name);
  const server = new Server(
    { name: "dokploy-bundle", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        `Every Dokploy tool takes a required "${INSTANCE_ARG}" argument naming the instance to act on ` +
        `(${names.join(", ")}). There is no default. bundle-instances describes them.`,
    },
  );

  let catalog: Promise<Map<string, Tool>> | undefined;
  const upstreamTools = (): Promise<Map<string, Tool>> => {
    if (!catalog) {
      catalog = pool.listTools().then(
        (tools) =>
          new Map(
            tools.flatMap((tool) => {
              const wrapped = withInstanceArg(tool, config.instances);
              if (!wrapped) log(`skipping ${tool.name}: it already has an "${INSTANCE_ARG}" argument`);
              return wrapped ? [[tool.name, wrapped] as const] : [];
            }),
          ),
      );
      // Let the next request retry instead of caching the failure.
      catalog.catch(() => {
        catalog = undefined;
      });
    }
    return catalog;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...bundleTools(config.instances), ...(await upstreamTools()).values()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const args = params.arguments ?? {};
    if (params.name === "bundle-instances") return listInstances(config.instances, pool);
    if (params.name === "bundle-check") return checkInstances(config.instances, args[INSTANCE_ARG], fetchFn);
    if (!(await upstreamTools()).has(params.name)) return errorResult(`Unknown tool "${params.name}".`);

    const { [INSTANCE_ARG]: target, ...forwarded } = args;
    const instance = config.instances.find((candidate) => candidate.name === target);
    if (!instance) {
      return errorResult(`"${INSTANCE_ARG}" must be one of ${names.join(", ")}; got ${JSON.stringify(target ?? null)}.`);
    }
    try {
      return await pool.callTool(instance, params.name, forwarded);
    } catch (error) {
      return errorResult(`${instance.name}: ${(error as Error).message}`);
    }
  });

  return server;
}

/** Undefined when the upstream tool already has an argument with that name. */
export function withInstanceArg(tool: Tool, instances: InstanceConfig[]): Tool | undefined {
  const { properties = {}, required = [] } = tool.inputSchema;
  if (INSTANCE_ARG in properties) return undefined;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { [INSTANCE_ARG]: instanceArgSchema(instances), ...properties },
      required: [INSTANCE_ARG, ...required],
    },
  };
}

function instanceArgSchema(instances: InstanceConfig[]) {
  const guarded = instances.filter((instance) => instance.protected).map((instance) => instance.name);
  return {
    type: "string",
    enum: instances.map((instance) => instance.name),
    description:
      "Dokploy instance to act on." +
      (guarded.length ? ` Protected, changes need approval: ${guarded.join(", ")}.` : ""),
  };
}

function bundleTools(instances: InstanceConfig[]): Tool[] {
  return [
    {
      name: "bundle-instances",
      description: "List the configured Dokploy instances: name, URL, description, protection, open connection.",
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "Bundle Instances", readOnlyHint: true },
    },
    {
      name: "bundle-check",
      description:
        "Check that Dokploy instances are reachable and accept their API key; returns each one's Dokploy version. " +
        `Omit "${INSTANCE_ARG}" to check all.`,
      inputSchema: { type: "object", properties: { [INSTANCE_ARG]: instanceArgSchema(instances) } },
      annotations: { title: "Bundle Check", readOnlyHint: true, openWorldHint: true },
    },
  ];
}

function listInstances(instances: InstanceConfig[], pool: UpstreamPool): CallToolResult {
  return textResult(
    instances.map((instance) => ({
      name: instance.name,
      url: instance.url,
      description: instance.description ?? null,
      protected: instance.protected,
      apiKey: instance.apiKeyEnv ? `from $${instance.apiKeyEnv}` : "in config",
      connected: pool.isRunning(instance.name),
    })),
  );
}

async function checkInstances(
  instances: InstanceConfig[],
  target: unknown,
  fetchFn: typeof fetch,
): Promise<CallToolResult> {
  const selected = target === undefined ? instances : instances.filter((instance) => instance.name === target);
  if (selected.length === 0) {
    return errorResult(`Unknown instance ${JSON.stringify(target)}; expected one of ${instances.map((i) => i.name).join(", ")}.`);
  }
  return textResult(await Promise.all(selected.map((instance) => checkInstance(instance, fetchFn))));
}

async function checkInstance(instance: InstanceConfig, fetchFn: typeof fetch) {
  try {
    const response = await fetchFn(`${instance.url}/api/settings.getDokployVersion`, {
      headers: { "x-api-key": resolveApiKey(instance), accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? " (API key rejected)" : "";
      return { instance: instance.name, ok: false, error: `HTTP ${response.status}${hint}` };
    }
    return { instance: instance.name, ok: true, version: parseVersion(body) };
  } catch (error) {
    return { instance: instance.name, ok: false, error: (error as Error).message };
  }
}

function parseVersion(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "string") return parsed;
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return body.trim().slice(0, 200);
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
