import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { defaultAuthDir } from "./adapters.js";
import { runtimeCatalogPath, writeCatalog } from "./catalog.js";
import { type BundleConfig, type InstanceConfig, resolveApiKey } from "./config.js";
import type { Log, UpstreamPool } from "./upstream.js";
import { VERSION } from "./version.js";

const CHECK_TIMEOUT_MS = 10_000;
const CHECK_RESULT_CHARS = 500;

export interface ServerDeps {
  fetch: typeof fetch;
  log: Log;
  /** Where to write the read-only list for the hook; null to skip. */
  catalogPath: string | null;
}

export function createBundleServer(config: BundleConfig, pool: UpstreamPool, deps: Partial<ServerDeps> = {}): Server {
  const {
    fetch: fetchFn = globalThis.fetch,
    log = (line: string) => process.stderr.write(`${line}\n`),
    catalogPath = runtimeCatalogPath(config.name),
  } = deps;
  const { argument } = config;
  const names = config.instances.map((instance) => instance.name);
  const server = new Server(
    { name: `${config.name}-bundle`, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        `Every ${subject(config)} tool takes a required "${argument}" argument naming the ${noun(config)} to act on ` +
        `(${names.join(", ")}). There is no default. bundle-instances describes them.`,
    },
  );

  let catalog: Promise<Map<string, Tool>> | undefined;
  const upstreamTools = (): Promise<Map<string, Tool>> => {
    if (!catalog) {
      catalog = pool.listTools().then(async (tools) => {
        if (catalogPath) {
          try {
            writeCatalog(catalogPath, await pool.label(), tools);
          } catch (error) {
            log(`could not write ${catalogPath}: ${(error as Error).message}`);
          }
        }
        return new Map(
          tools.flatMap((tool) => {
            const wrapped = withInstanceArg(tool, config);
            if (!wrapped) log(`skipping ${tool.name}: it already has an "${argument}" argument`);
            return wrapped ? [[tool.name, wrapped] as const] : [];
          }),
        );
      });
      // Let the next request retry instead of caching the failure.
      catalog.catch(() => {
        catalog = undefined;
      });
    }
    return catalog;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...bundleTools(config), ...(await upstreamTools()).values()],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const args = params.arguments ?? {};
    if (params.name === "bundle-instances") return listInstances(config, pool);
    if (params.name === "bundle-check") return checkInstances(config, pool, args[argument], fetchFn);
    if (!(await upstreamTools()).has(params.name)) return errorResult(`Unknown tool "${params.name}".`);

    const { [argument]: target, ...forwarded } = args;
    const instance = config.instances.find((candidate) => candidate.name === target);
    if (!instance) {
      return errorResult(`"${argument}" must be one of ${names.join(", ")}; got ${JSON.stringify(target ?? null)}.`);
    }
    try {
      return await pool.callTool(instance, params.name, forwarded);
    } catch (error) {
      return errorResult(`${instance.name}: ${(error as Error).message}`);
    }
  });

  return server;
}

/** Undefined when the upstream tool already has an argument with the routing argument's name. */
export function withInstanceArg(tool: Tool, config: BundleConfig): Tool | undefined {
  const { properties = {}, required = [] } = tool.inputSchema;
  if (config.argument in properties) return undefined;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { [config.argument]: instanceArgSchema(config), ...properties },
      required: [config.argument, ...required],
    },
  };
}

/** "Dokploy" or the bundle's name, as in "every Linear tool". */
function subject(config: BundleConfig): string {
  return config.type === "dokploy" ? "Dokploy" : config.name;
}

/** "Dokploy instance" or the argument's name, as in "the workspace to act on". */
function noun(config: BundleConfig): string {
  return config.type === "dokploy" ? "Dokploy instance" : config.argument;
}

function instanceArgSchema(config: BundleConfig) {
  const guarded = config.instances.filter((instance) => instance.protected).map((instance) => instance.name);
  return {
    type: "string",
    enum: config.instances.map((instance) => instance.name),
    description:
      `${capitalize(noun(config))} to act on.` +
      (guarded.length ? ` Protected, changes need approval: ${guarded.join(", ")}.` : ""),
  };
}

function bundleTools(config: BundleConfig): Tool[] {
  const plural = `${noun(config)}s`;
  const check =
    config.type === "dokploy"
      ? "Check that Dokploy instances are reachable and accept their API key; returns each one's Dokploy version."
      : config.checkTool
        ? `Check each of the ${plural} by calling ${config.checkTool} there; returns what it says. ` +
          "An instance that still needs an OAuth login opens it in the browser."
        : `Check that each of the ${plural} connects. An instance that still needs an OAuth login opens it in the browser.`;
  return [
    {
      name: "bundle-instances",
      description: `List the configured ${plural} (name, description, protection, open connection) and what serves them.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { title: "Bundle Instances", readOnlyHint: true },
    },
    {
      name: "bundle-check",
      description: `${check} Omit "${config.argument}" to check all.`,
      inputSchema: { type: "object", properties: { [config.argument]: instanceArgSchema(config) } },
      annotations: { title: "Bundle Check", readOnlyHint: true, openWorldHint: true },
    },
  ];
}

async function listInstances(config: BundleConfig, pool: UpstreamPool): Promise<CallToolResult> {
  return textResult({
    upstream: await pool.label(),
    [`${config.argument}s`]: config.instances.map((instance) => ({
      name: instance.name,
      description: instance.description ?? null,
      protected: instance.protected,
      ...details(config, instance),
      connected: pool.isRunning(instance.name),
    })),
  });
}

/** Per-type facts for bundle-instances. Never secrets: header values and keys stay out. */
function details(config: BundleConfig, instance: InstanceConfig): Record<string, unknown> {
  if (config.type === "dokploy") {
    return { url: instance.url, apiKey: instance.apiKeyEnv ? `from $${instance.apiKeyEnv}` : "in config" };
  }
  if ("url" in config.upstream) {
    return config.upstream.auth === "oauth"
      ? { authDir: instance.authDir ?? defaultAuthDir(config.name, instance.name) }
      : { headers: Object.keys(instance.headers) };
  }
  return instance.args.length ? { args: instance.args } : {};
}

async function checkInstances(
  config: BundleConfig,
  pool: UpstreamPool,
  target: unknown,
  fetchFn: typeof fetch,
): Promise<CallToolResult> {
  const { instances } = config;
  const selected = target === undefined ? instances : instances.filter((instance) => instance.name === target);
  if (selected.length === 0) {
    return errorResult(`Unknown ${noun(config)} ${JSON.stringify(target)}; expected one of ${instances.map((i) => i.name).join(", ")}.`);
  }
  const named = (instance: InstanceConfig, result: object) => ({ [config.argument]: instance.name, ...result });
  if (config.type === "dokploy") {
    return textResult(
      await Promise.all(selected.map(async (instance) => named(instance, await checkDokploy(instance, fetchFn)))),
    );
  }
  // One at a time: an instance without a login opens a browser tab, and two at once would be confusing.
  const results = [];
  for (const instance of selected) results.push(named(instance, await checkUpstream(config, pool, instance)));
  return textResult(results);
}

async function checkDokploy(instance: InstanceConfig, fetchFn: typeof fetch) {
  try {
    const response = await fetchFn(`${instance.url}/api/settings.getDokployVersion`, {
      headers: { "x-api-key": resolveApiKey(instance), accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? " (API key rejected)" : "";
      return { ok: false, error: `HTTP ${response.status}${hint}` };
    }
    return { ok: true, version: parseVersion(body) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function checkUpstream(config: BundleConfig, pool: UpstreamPool, instance: InstanceConfig) {
  try {
    if (!config.checkTool) {
      await pool.ping(instance);
      return { ok: true };
    }
    const result = await pool.callTool(instance, config.checkTool, {});
    const text = result.content.find((item) => item.type === "text");
    return {
      ok: result.isError !== true,
      result: text?.type === "text" ? text.text.slice(0, CHECK_RESULT_CHARS) : null,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
