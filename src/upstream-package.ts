import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cacheDir } from "./paths.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const PACKAGE = "@dokploy/mcp";
const ENTRY = ["node_modules", "@dokploy", "mcp", "build", "index.js"];
/** Also guards the cache paths: a version never contains "/" or "..". */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KEEP_VERSIONS = 3;
const NPM_TIMEOUT_MS = 120_000;

/** A Dokploy bundle's upstream: an @dokploy/mcp version spec, or a replacement command. */
export type PackageSpec = { version: string } | { command: string; args: string[] };

export interface Upstream {
  command: string;
  args: string[];
  /** Shown by bundle-instances, e.g. "@dokploy/mcp@0.31.0 (latest)". */
  label: string;
}

export interface ResolveDeps {
  /** Runs npm with these arguments and returns stdout. */
  npm: (args: string[]) => Promise<string>;
  /** Where resolved versions are installed, one directory per version. */
  dir: string;
  log: (line: string) => void;
}

/**
 * Turns the upstream config into a command. The bundle calls this once per process, so "latest" means the
 * newest release when the client started the server. When npm or the registry is unreachable it falls back
 * to the newest cached version, then to the bundled one.
 */
export async function resolveUpstream(config: PackageSpec, deps: Partial<ResolveDeps> = {}): Promise<Upstream> {
  if ("command" in config) {
    return { ...config, label: `custom command: ${[config.command, ...config.args].join(" ")}` };
  }
  if (config.version === "bundled") return bundled();

  const {
    npm = runNpm,
    dir = join(cacheDir(), "upstream"),
    log = (line: string) => process.stderr.write(`${line}\n`),
  } = deps;
  try {
    const version = await resolveVersion(npm, config.version);
    const entry = await ensureInstalled(npm, dir, version);
    prune(dir, version);
    return onNode(entry, `${PACKAGE}@${version} (${config.version})`);
  } catch (error) {
    const reason = (error as Error).message;
    const cached = cachedVersions(dir).at(-1);
    log(`could not resolve ${PACKAGE}@${config.version}: ${reason}; using ${cached ?? "the bundled version"}`);
    if (cached) {
      return onNode(join(dir, cached, ...ENTRY), `${PACKAGE}@${cached} (cached; ${config.version} unavailable: ${reason})`);
    }
    const fallback = bundled();
    return { ...fallback, label: `${fallback.label}; ${config.version} unavailable: ${reason}` };
  }
}

/** The first npm error line that says what went wrong, rather than "code E404" style key-value lines. */
export function npmErrorSummary(stderr: string): string | undefined {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^npm (error|ERR!) /.test(line) && !/^npm (error|ERR!) \S+ \S+$/.test(line))
    .map((line) => line.replace(/^npm (error|ERR!) /, ""))[0];
}

export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.split(/-(.*)/);
  const [coreB = "", preB] = b.split(/-(.*)/);
  const partsA = coreA.split(".").map(Number);
  const partsB = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

function bundled(): Upstream {
  const entry = require.resolve("@dokploy/mcp/build/index.js");
  const { version } = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
    version: string;
  };
  return onNode(entry, `${PACKAGE}@${version} (bundled)`);
}

function onNode(entry: string, label: string): Upstream {
  return { command: process.execPath, args: [entry], label };
}

async function resolveVersion(npm: ResolveDeps["npm"], spec: string): Promise<string> {
  const parsed: unknown = JSON.parse(await npm(["view", `${PACKAGE}@${spec}`, "version", "--json"]));
  const candidates = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is string => typeof value === "string" && VERSION.test(value),
  );
  const version = candidates.sort(compareVersions).at(-1);
  if (!version) throw new Error(`npm returned no usable version for "${spec}"`);
  return version;
}

async function ensureInstalled(npm: ResolveDeps["npm"], dir: string, version: string): Promise<string> {
  const target = join(dir, version);
  if (existsSync(join(target, ...ENTRY))) return join(target, ...ENTRY);

  // Install next to the target and rename, so a second bundle process never sees a half-installed version.
  const staging = `${target}.installing-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    await npm([
      "install",
      "--prefix",
      staging,
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      `${PACKAGE}@${version}`,
    ]);
    if (!existsSync(join(staging, ...ENTRY))) throw new Error(`npm install left no ${ENTRY.join("/")}`);
    try {
      renameSync(staging, target);
    } catch (error) {
      // Another bundle process finished first; use its copy.
      if (!existsSync(join(target, ...ENTRY))) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return join(target, ...ENTRY);
}

/** Installed versions, oldest first. */
function cachedVersions(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => VERSION.test(name) && existsSync(join(dir, name, ...ENTRY))).sort(compareVersions);
}

function prune(dir: string, current: string): void {
  const keep = new Set([...cachedVersions(dir).slice(-KEEP_VERSIONS), current]);
  for (const name of readdirSync(dir)) {
    if (VERSION.test(name) && !keep.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

async function runNpm(args: string[]): Promise<string> {
  // Claude Desktop starts servers without the shell's PATH, so look for npm next to the running node first.
  const nodeDir = dirname(process.execPath);
  const npmCli = [
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => existsSync(path));
  const [command, prefix] = npmCli ? [process.execPath, [npmCli]] : ["npm", []];
  // npm gets no API keys: only the default variables, proxy settings and npm's own config.
  const passthrough = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && /^(https?_proxy|no_proxy|npm_config_\w+)$/i.test(entry[0]),
    ),
  );
  try {
    const { stdout } = await execFileAsync(command, [...prefix, ...args], {
      env: { ...getDefaultEnvironment(), ...passthrough, PATH: [nodeDir, process.env.PATH].filter(Boolean).join(delimiter) },
      timeout: NPM_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const { stderr = "", message } = error as { stderr?: string; message: string };
    throw new Error(npmErrorSummary(stderr) ?? message.split("\n")[0]);
  }
}
