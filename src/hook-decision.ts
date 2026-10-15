import type { ToolCatalog } from "./catalog.js";
import type { BundleConfig } from "./config.js";

export type { ToolCatalog };

export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/**
 * Returns why to ask for approval, or undefined to leave the call to the normal permission rules.
 * Asks for any tool not known to be read-only that targets a protected instance.
 */
export function decide(input: HookInput, config: BundleConfig | Error, catalog: ToolCatalog | undefined): string | undefined {
  const toolName = input.tool_name ?? "";
  const tool = toolName.slice(toolName.lastIndexOf("__") + 2);
  const instance = input.tool_input?.instance;
  if (typeof instance !== "string" || tool.startsWith("bundle-")) return undefined;
  if (config instanceof Error) {
    return `Could not load the dokploy-bundle config to check whether "${instance}" is protected: ${config.message}`;
  }
  if (!config.instances.find((candidate) => candidate.name === instance)?.protected) return undefined;
  const hints = catalog?.[tool];
  if (hints?.readOnlyHint) return undefined;
  return `"${instance}" is a protected Dokploy instance and ${tool} ${hints ? "can change it" : "is not in the read-only catalog"}.`;
}
