import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type BundleConfig, type InstanceConfig, resolveApiKey, resolveHeaders, toolFilterEnv } from "./config.js";
import { resolveUpstream, type Upstream } from "./upstream-package.js";

const require = createRequire(import.meta.url);

/** An OAuth login waits for you in the browser, so give it longer than a normal start. */
const OAUTH_TIMEOUT_SECONDS = 300;

export type Log = (line: string) => void;

export type Connection =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; initTimeoutMs?: number }
  | { kind: "http"; url: string; headers: Record<string, string> };

/** How one bundle type reaches its instances. */
export interface Adapter {
  /** What serves the instances, for bundle-instances, e.g. "@dokploy/mcp@0.30.7 (latest)". */
  label(): Promise<string>;
  connection(instance: InstanceConfig): Promise<Connection>;
}

export function createAdapter(config: BundleConfig, log: Log): Adapter {
  const env = (instance: InstanceConfig) => ({ ...getDefaultEnvironment(), ...config.env, ...instance.env });
  const { upstream } = config;

  if ("url" in upstream) {
    if (upstream.auth === "headers") {
      return {
        label: async () => upstream.url,
        connection: async (instance) => ({ kind: "http", url: upstream.url, headers: resolveHeaders(instance) }),
      };
    }
    // mcp-remote does the OAuth flow and keeps each instance's tokens in its own directory.
    const mcpRemote = require.resolve("mcp-remote/dist/proxy.js");
    const { version } = JSON.parse(readFileSync(join(dirname(mcpRemote), "..", "package.json"), "utf8")) as {
      version: string;
    };
    return {
      label: async () => `${upstream.url} (OAuth via mcp-remote@${version})`,
      connection: async (instance) => ({
        kind: "stdio",
        command: process.execPath,
        args: [mcpRemote, upstream.url, "--auth-timeout", String(OAUTH_TIMEOUT_SECONDS)],
        env: { ...env(instance), MCP_REMOTE_CONFIG_DIR: instance.authDir ?? defaultAuthDir(config.name, instance.name) },
        initTimeoutMs: OAUTH_TIMEOUT_SECONDS * 1000,
      }),
    };
  }

  if (config.type === "command" && "command" in upstream) {
    return {
      label: async () => [upstream.command, ...upstream.args].join(" "),
      connection: async (instance) => ({
        kind: "stdio",
        command: upstream.command,
        args: [...upstream.args, ...instance.args],
        env: env(instance),
      }),
    };
  }

  let resolved: Promise<Upstream> | undefined;
  const resolve = () => (resolved ??= resolveUpstream(upstream, { log }));
  return {
    label: async () => (await resolve()).label,
    connection: async (instance) => {
      const { command, args } = await resolve();
      return {
        kind: "stdio",
        command,
        args,
        env: {
          ...env(instance),
          ...toolFilterEnv(config.tools),
          DOKPLOY_URL: instance.url ?? "",
          DOKPLOY_API_KEY: resolveApiKey(instance),
        },
      };
    },
  };
}

export function defaultAuthDir(bundle: string, instance: string): string {
  return join(homedir(), ".mcp-auth", "dokploy-bundle-mcp", bundle, instance);
}
