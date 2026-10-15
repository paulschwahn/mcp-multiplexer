import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

/**
 * dokploy: one @dokploy/mcp per Dokploy instance.
 * command: any stdio MCP server, started once per instance.
 * url: any remote MCP server, with per-instance headers or an OAuth login per instance.
 */
export type BundleType = "dokploy" | "command" | "url";

export interface InstanceConfig {
  name: string;
  description?: string;
  /** Tools that aren't read-only need approval on a protected instance (see the hook). */
  protected: boolean;
  /** Extra environment for this instance's upstream process. */
  env: Record<string, string>;
  /** dokploy: base URL without the /api suffix, e.g. https://dokploy.example.com */
  url?: string;
  /** dokploy: the API key, or the environment variable that holds it. */
  apiKey?: string;
  apiKeyEnv?: string;
  /** command: arguments appended to the upstream command's own. */
  args: string[];
  /** url: request headers; `${VAR}` in a value is replaced from the environment. */
  headers: Record<string, string>;
  /** url with OAuth: where mcp-remote keeps this instance's tokens. */
  authDir?: string;
}

/** dokploy only: passed to every upstream as DOKPLOY_TOOL_PRESET / DOKPLOY_ENABLED_TAGS / DOKPLOY_DISABLED_TAGS. */
export interface ToolFilter {
  preset?: string;
  enabledTags: string[];
  disabledTags: string[];
}

export type UpstreamConfig =
  /** dokploy: "bundled" (the version in package.json), "latest", a range like "~0.30.7", or an exact version. */
  | { version: string }
  /** command, or dokploy with a replacement for @dokploy/mcp (the tests use a stub). */
  | { command: string; args: string[] }
  /** url: a remote MCP server. */
  | { url: string; auth: "headers" | "oauth" };

export interface BundleConfig {
  type: BundleType;
  /** Names this bundle's cache files; defaults to the config file's name. */
  name: string;
  /** The routing argument added to every tool, e.g. "instance" or "workspace". */
  argument: string;
  instances: InstanceConfig[];
  /** Environment for every upstream process. */
  env: Record<string, string>;
  tools: ToolFilter;
  upstream: UpstreamConfig;
  /** command and url: a read-only tool bundle-check calls on each instance. Without one it only pings. */
  checkTool?: string;
}

type Fail = (message: string) => never;

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const ARGUMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOP_LEVEL_FIELDS = ["$schema", "type", "name", "argument", "upstream", "instances", "env", "tools", "checkTool"];
const UPSTREAM_FIELDS: Record<BundleType, string[]> = {
  dokploy: ["version", "command", "args"],
  command: ["command", "args"],
  url: ["url", "auth"],
};
const COMMON_INSTANCE_FIELDS = ["description", "protected", "env"];
const INSTANCE_FIELDS: Record<BundleType, string[]> = {
  dokploy: ["url", "apiKey", "apiKeyEnv"],
  command: ["args"],
  url: ["headers", "authDir"],
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "mcp-multiplexer", "config.json");

/** `--config <path>`, then MCP_MULTIPLEXER_CONFIG, then the default path. */
export function configPath(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv.slice(2)): string {
  const flag = argv.indexOf("--config");
  if (flag >= 0) {
    const path = argv[flag + 1];
    if (!path) throw new Error("--config needs a path");
    return expandHome(path);
  }
  return env.MCP_MULTIPLEXER_CONFIG ? expandHome(env.MCP_MULTIPLEXER_CONFIG) : DEFAULT_CONFIG_PATH;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(path = configPath()): BundleConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config ${path}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Config ${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(json, path, basename(path, extname(path)));
}

export function parseConfig(json: unknown, source = "config", defaultName = "config"): BundleConfig {
  const fail: Fail = (message) => {
    throw new Error(`${source}: ${message}`);
  };
  const root = asObject(json) ?? fail("expected a JSON object");
  rejectUnknown(root, TOP_LEVEL_FIELDS, "", fail);

  const type = optionalString(root.type, `"type"`, fail) ?? "dokploy";
  if (!isBundleType(type)) fail(`"type" must be "dokploy", "command" or "url"`);
  const name = optionalString(root.name, `"name"`, fail) ?? defaultName;
  if (!NAME.test(name)) fail(`"name" may only use a-z, 0-9 and "-" (it defaults to the config file's name)`);
  const argument = optionalString(root.argument, `"argument"`, fail) ?? "instance";
  if (!ARGUMENT.test(argument)) fail(`"argument" must be a plain identifier like "instance" or "workspace"`);
  if (type !== "dokploy" && root.tools !== undefined) fail(`"tools" only applies to type "dokploy"`);
  if (type === "dokploy" && root.checkTool !== undefined) {
    fail(`"checkTool" doesn't apply to type "dokploy"; bundle-check asks Dokploy for its version`);
  }

  const upstream = parseUpstream(type, root.upstream, fail);
  const instances = Object.entries(
    asObject(root.instances) ?? fail(`"instances" must be an object keyed by instance name`),
  ).map(([instanceName, value]) => parseInstance(type, upstream, instanceName, value, fail));
  if (instances.length === 0) fail(`"instances" is empty`);
  const tools = root.tools === undefined ? {} : (asObject(root.tools) ?? fail(`"tools" must be an object`));
  return {
    type,
    name,
    argument,
    instances,
    env: stringRecord(root.env, `"env"`, fail),
    tools: {
      preset: optionalString(tools.preset, `"tools.preset"`, fail),
      enabledTags: stringArray(tools.enabledTags, `"tools.enabledTags"`, fail),
      disabledTags: stringArray(tools.disabledTags, `"tools.disabledTags"`, fail),
    },
    upstream,
    checkTool: optionalString(root.checkTool, `"checkTool"`, fail),
  };
}

export function resolveApiKey(instance: InstanceConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (instance.apiKey !== undefined) return instance.apiKey;
  const value = env[instance.apiKeyEnv ?? ""];
  if (!value) throw new Error(`environment variable ${instance.apiKeyEnv} is not set`);
  return value;
}

/** The instance's headers with every `${VAR}` replaced from the environment. */
export function resolveHeaders(instance: InstanceConfig, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(instance.headers).map(([header, value]) => [
      header,
      value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
        const resolved = env[variable];
        if (!resolved) throw new Error(`environment variable ${variable} is not set`);
        return resolved;
      }),
    ]),
  );
}

export function toolFilterEnv(tools: ToolFilter): Record<string, string> {
  return {
    ...(tools.preset ? { DOKPLOY_TOOL_PRESET: tools.preset } : {}),
    ...(tools.enabledTags.length ? { DOKPLOY_ENABLED_TAGS: tools.enabledTags.join(",") } : {}),
    ...(tools.disabledTags.length ? { DOKPLOY_DISABLED_TAGS: tools.disabledTags.join(",") } : {}),
  };
}

function isBundleType(value: string): value is BundleType {
  return value === "dokploy" || value === "command" || value === "url";
}

function parseUpstream(type: BundleType, value: unknown, fail: Fail): UpstreamConfig {
  if (value === undefined && type === "dokploy") return { version: "bundled" };
  const raw = asObject(value) ?? fail(`"upstream" must be an object`);
  rejectUnknown(raw, UPSTREAM_FIELDS[type], `"upstream" for type "${type}"`, fail);
  if (type === "url") {
    const url = optionalString(raw.url, `"upstream.url"`, fail) ?? fail(`"upstream" needs a "url"`);
    if (!/^https?:\/\//.test(url)) fail(`"upstream.url" must start with http:// or https://`);
    const auth = optionalString(raw.auth, `"upstream.auth"`, fail) ?? "headers";
    if (auth !== "headers" && auth !== "oauth") fail(`"upstream.auth" must be "headers" or "oauth"`);
    return { url, auth };
  }
  if (type === "dokploy" && raw.command === undefined) {
    return { version: optionalString(raw.version, `"upstream.version"`, fail) ?? "bundled" };
  }
  if (raw.version !== undefined) fail(`"upstream" takes "version" or "command", not both`);
  return {
    command: optionalString(raw.command, `"upstream.command"`, fail) ?? fail(`"upstream" needs a "command"`),
    args: stringArray(raw.args, `"upstream.args"`, fail),
  };
}

function parseInstance(
  type: BundleType,
  upstream: UpstreamConfig,
  name: string,
  value: unknown,
  fail: Fail,
): InstanceConfig {
  const where = `instance "${name}"`;
  if (!NAME.test(name)) fail(`${where}: names may only use a-z, 0-9 and "-"`);
  const raw = asObject(value) ?? fail(`${where} must be an object`);
  rejectUnknown(raw, [...COMMON_INSTANCE_FIELDS, ...INSTANCE_FIELDS[type]], `${where} (type "${type}")`, fail);
  if (raw.protected !== undefined && typeof raw.protected !== "boolean") {
    fail(`${where} "protected" must be true or false`);
  }
  const instance: InstanceConfig = {
    name,
    description: optionalString(raw.description, `${where} "description"`, fail),
    protected: raw.protected === true,
    env: stringRecord(raw.env, `${where} "env"`, fail),
    args: stringArray(raw.args, `${where} "args"`, fail),
    headers: stringRecord(raw.headers, `${where} "headers"`, fail),
  };

  if (type === "dokploy") {
    const url = optionalString(raw.url, `${where} "url"`, fail) ?? fail(`${where} needs a "url"`);
    if (!/^https?:\/\//.test(url)) fail(`${where} "url" must start with http:// or https://`);
    const apiKey = optionalString(raw.apiKey, `${where} "apiKey"`, fail);
    const apiKeyEnv = optionalString(raw.apiKeyEnv, `${where} "apiKeyEnv"`, fail);
    if ((apiKey === undefined) === (apiKeyEnv === undefined)) {
      fail(`${where} needs exactly one of "apiKey" or "apiKeyEnv"`);
    }
    // Upstream appends /api itself.
    return { ...instance, url: url.replace(/\/+$/, "").replace(/\/api$/, ""), apiKey, apiKeyEnv };
  }

  if (type === "url") {
    const oauth = "auth" in upstream && upstream.auth === "oauth";
    const authDir = optionalString(raw.authDir, `${where} "authDir"`, fail);
    if (authDir !== undefined && !oauth) fail(`${where} "authDir" only applies with "upstream.auth": "oauth"`);
    if (raw.headers !== undefined && oauth) fail(`${where} "headers" only apply with "upstream.auth": "headers"`);
    return { ...instance, authDir: authDir === undefined ? undefined : expandHome(authDir) };
  }

  return instance;
}

function rejectUnknown(raw: Record<string, unknown>, allowed: string[], where: string, fail: Fail): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    fail(`${where ? `${where}: ` : ""}unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => `"${key}"`).join(", ")}`);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown, what: string, fail: Fail): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value !== "" ? value : fail(`${what} must be a non-empty string`);
}

function stringArray(value: unknown, what: string, fail: Fail): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${what} must be an array of strings`);
  }
  return value as string[];
}

function stringRecord(value: unknown, what: string, fail: Fail): Record<string, string> {
  if (value === undefined) return {};
  const raw = asObject(value) ?? fail(`${what} must be an object of strings`);
  if (!Object.values(raw).every((item) => typeof item === "string")) fail(`${what} must be an object of strings`);
  return raw as Record<string, string>;
}
