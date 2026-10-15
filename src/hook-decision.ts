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
  if (tool.startsWith("bundle-")) return undefined;
  if (config instanceof Error) {
    // Without the config there's no telling which argument names the instance or whether it's protected.
    return `Could not load the bundle config to check whether this call needs approval: ${config.message}`;
  }
  const instance = input.tool_input?.[config.argument];
  if (typeof instance !== "string") return undefined;
  if (!config.instances.find((candidate) => candidate.name === instance)?.protected) return undefined;
  const hints = catalog?.[tool];
  if (hints?.readOnlyHint) return undefined;
  return `"${instance}" is protected and ${tool} ${hints ? "can change it" : "is not in the read-only catalog"}.`;
}
