import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { cacheDir } from "./paths.js";

/** Tool name → upstream annotations; the hook uses it to tell read-only tools from the rest. */
export type ToolCatalog = Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean }>;

export interface CatalogFile {
  upstream: string;
  tools: ToolCatalog;
}

/** Written by the server each time it lists tools, so the hook matches the upstream that is running. */
export function runtimeCatalogPath(bundle: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), "catalogs", `${bundle}.json`);
}

/** Written at build time from the bundled @dokploy/mcp; the hook falls back to it for Dokploy bundles. */
export const BUNDLED_CATALOG = new URL("./catalog.json", import.meta.url);

export function writeCatalog(path: string, upstream: string, tools: Tool[]): void {
  const catalog: CatalogFile = {
    upstream,
    tools: Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        {
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          destructiveHint: tool.annotations?.destructiveHint === true,
        },
      ]),
    ),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`);
  renameSync(temp, path);
}

/** The first of these files that can be read. */
export function readCatalog(paths: (string | URL)[]): CatalogFile | undefined {
  for (const path of paths) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CatalogFile;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}
