import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstanceConfig {
  name: string;
  /** Dokploy base URL without the /api suffix, e.g. https://dokploy.example.com */
  url: string;
  apiKey?: string;
  /** Environment variable holding the API key, to keep secrets out of the config file. */
  apiKeyEnv?: string;
  description?: string;
  /** Non-read-only tools on a protected instance need approval (see the hook). */
  protected: boolean;
  /** Extra environment for this instance's upstream process, e.g. DOKPLOY_TIMEOUT. */
  env: Record<string, string>;
}

/** Passed to every upstream process as DOKPLOY_TOOL_PRESET / DOKPLOY_ENABLED_TAGS / DOKPLOY_DISABLED_TAGS. */
export interface ToolFilter {
  preset?: string;
  enabledTags: string[];
  disabledTags: string[];
}

export type UpstreamConfig =
  /** "bundled" (the version in package.json), "latest", a range like "~0.30.7", or an exact version. */
  | { version: string }
  /** Replaces @dokploy/mcp entirely; the tests point it at a stub. */
  | { command: string; args: string[] };

export interface BundleConfig {
  instances: InstanceConfig[];
  /** Environment for every upstream process, e.g. DOKPLOY_REDACT_ENV. */
  env: Record<string, string>;
  tools: ToolFilter;
  upstream: UpstreamConfig;
}

type Fail = (message: string) => never;

const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "dokploy-bundle-mcp", "config.json");

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DOKPLOY_BUNDLE_CONFIG || DEFAULT_CONFIG_PATH;
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
  return parseConfig(json, path);
}

export function parseConfig(json: unknown, source = "config"): BundleConfig {
  const fail: Fail = (message) => {
    throw new Error(`${source}: ${message}`);
  };
  const root = asObject(json) ?? fail("expected a JSON object");
  const instances = Object.entries(
    asObject(root.instances) ?? fail(`"instances" must be an object keyed by instance name`),
  ).map(([name, value]) => parseInstance(name, value, fail));
  if (instances.length === 0) fail(`"instances" is empty`);
  const tools = root.tools === undefined ? {} : (asObject(root.tools) ?? fail(`"tools" must be an object`));
  return {
    instances,
    env: stringRecord(root.env, `"env"`, fail),
    tools: {
      preset: optionalString(tools.preset, `"tools.preset"`, fail),
      enabledTags: stringArray(tools.enabledTags, `"tools.enabledTags"`, fail),
      disabledTags: stringArray(tools.disabledTags, `"tools.disabledTags"`, fail),
    },
    upstream: root.upstream === undefined ? { version: "bundled" } : parseUpstream(root.upstream, fail),
  };
}

export function resolveApiKey(instance: InstanceConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (instance.apiKey !== undefined) return instance.apiKey;
  const value = env[instance.apiKeyEnv ?? ""];
  if (!value) throw new Error(`environment variable ${instance.apiKeyEnv} is not set`);
  return value;
}

export function toolFilterEnv(tools: ToolFilter): Record<string, string> {
  return {
    ...(tools.preset ? { DOKPLOY_TOOL_PRESET: tools.preset } : {}),
    ...(tools.enabledTags.length ? { DOKPLOY_ENABLED_TAGS: tools.enabledTags.join(",") } : {}),
    ...(tools.disabledTags.length ? { DOKPLOY_DISABLED_TAGS: tools.disabledTags.join(",") } : {}),
  };
}

function parseInstance(name: string, value: unknown, fail: Fail): InstanceConfig {
  const where = `instance "${name}"`;
  if (!INSTANCE_NAME.test(name)) fail(`${where}: names may only use a-z, 0-9 and "-"`);
  const raw = asObject(value) ?? fail(`${where} must be an object`);
  const url = optionalString(raw.url, `${where} "url"`, fail) ?? fail(`${where} needs a "url"`);
  if (!/^https?:\/\//.test(url)) fail(`${where} "url" must start with http:// or https://`);
  const apiKey = optionalString(raw.apiKey, `${where} "apiKey"`, fail);
  const apiKeyEnv = optionalString(raw.apiKeyEnv, `${where} "apiKeyEnv"`, fail);
  if ((apiKey === undefined) === (apiKeyEnv === undefined)) {
    fail(`${where} needs exactly one of "apiKey" or "apiKeyEnv"`);
  }
  if (raw.protected !== undefined && typeof raw.protected !== "boolean") {
    fail(`${where} "protected" must be true or false`);
  }
  return {
    name,
    // Upstream appends /api itself.
    url: url.replace(/\/+$/, "").replace(/\/api$/, ""),
    apiKey,
    apiKeyEnv,
    description: optionalString(raw.description, `${where} "description"`, fail),
    protected: raw.protected === true,
    env: stringRecord(raw.env, `${where} "env"`, fail),
  };
}

function parseUpstream(value: unknown, fail: Fail): UpstreamConfig {
  const raw = asObject(value) ?? fail(`"upstream" must be an object`);
  if (raw.command === undefined) {
    return { version: optionalString(raw.version, `"upstream.version"`, fail) ?? "bundled" };
  }
  if (raw.version !== undefined) fail(`"upstream" takes "version" or "command", not both`);
  return {
    command: optionalString(raw.command, `"upstream.command"`, fail) ?? fail(`"upstream" needs a "command"`),
    args: stringArray(raw.args, `"upstream.args"`, fail),
  };
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
