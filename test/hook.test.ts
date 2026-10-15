import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { decide, type ToolCatalog } from "../src/hook-decision.js";

const config = parseConfig({
  instances: {
    staging: { url: "https://staging.example", apiKey: "key" },
    prod: { url: "https://prod.example", apiKey: "key", protected: true },
  },
});
const catalog: ToolCatalog = {
  "application-readLogs": { readOnlyHint: true },
  "application-deploy": { readOnlyHint: false },
  "application-delete": { readOnlyHint: false, destructiveHint: true },
};
const input = (tool: string, toolInput: Record<string, unknown>) => ({
  tool_name: `mcp__dokploy__${tool}`,
  tool_input: toolInput,
});

describe("decide", () => {
  it("asks before a change to a protected instance", () => {
    expect(decide(input("application-deploy", { instance: "prod" }), config, catalog)).toBe(
      `"prod" is protected and application-deploy can change it.`,
    );
  });

  it("reads the instance from the configured argument", () => {
    const linear = parseConfig({
      type: "url",
      argument: "workspace",
      upstream: { url: "https://mcp.linear.app/mcp", auth: "oauth" },
      instances: { north: {}, acme: { protected: true } },
    });
    const save = (toolInput: Record<string, unknown>) => ({ tool_name: "mcp__linear__save_issue", tool_input: toolInput });
    expect(decide(save({ workspace: "acme" }), linear, {})).toBe(
      `"acme" is protected and save_issue is not in the read-only catalog.`,
    );
    expect(decide(save({ workspace: "north" }), linear, {})).toBeUndefined();
    expect(decide(save({ instance: "acme" }), linear, {})).toBeUndefined();
  });

  it("lets read-only tools on a protected instance through", () => {
    expect(decide(input("application-readLogs", { instance: "prod" }), config, catalog)).toBeUndefined();
  });

  it("leaves unprotected instances to the normal rules", () => {
    expect(decide(input("application-delete", { instance: "staging" }), config, catalog)).toBeUndefined();
  });

  it("leaves the bundle's own tools alone", () => {
    expect(decide(input("bundle-check", { instance: "prod" }), config, catalog)).toBeUndefined();
  });

  it("asks when it cannot tell whether a tool is read-only", () => {
    expect(decide(input("application-readLogs", { instance: "prod" }), config, undefined)).toContain(
      "not in the read-only catalog",
    );
  });

  it("asks when the config cannot be loaded", () => {
    expect(decide(input("application-deploy", { instance: "prod" }), new Error("missing"), catalog)).toContain(
      "Could not load the bundle config",
    );
  });
});
