import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, parseConfig, resolveApiKey, resolveHeaders, toolFilterEnv } from "../src/config.js";

const instance = { url: "https://dokploy.example", apiKey: "key" };
const linear = { type: "url", upstream: { url: "https://mcp.linear.app/mcp", auth: "oauth" } };

describe("parseConfig", () => {
  it("normalises URLs and fills defaults", () => {
    const config = parseConfig({ instances: { staging: { ...instance, url: "https://dokploy.example/api/" } } });
    expect(config).toMatchObject({ type: "dokploy", name: "config", argument: "instance", checkTool: undefined });
    expect(config.instances).toEqual([
      {
        name: "staging",
        url: "https://dokploy.example",
        apiKey: "key",
        apiKeyEnv: undefined,
        description: undefined,
        protected: false,
        env: {},
        args: [],
        headers: {},
      },
    ]);
    expect(config.tools).toEqual({ preset: undefined, enabledTags: [], disabledTags: [] });
    expect(config.upstream).toEqual({ version: "bundled" });
  });

  it("reads an upstream version or command", () => {
    const parse = (upstream: unknown) => parseConfig({ instances: { staging: instance }, upstream }).upstream;
    expect(parse({ version: "latest" })).toEqual({ version: "latest" });
    expect(parse({})).toEqual({ version: "bundled" });
    expect(parse({ command: "node", args: ["stub.mjs"] })).toEqual({ command: "node", args: ["stub.mjs"] });
  });

  it("reads url bundles", () => {
    const config = parseConfig(
      { ...linear, argument: "workspace", checkTool: "get_workspace", instances: { north: { authDir: "~/tokens" } } },
      "test",
      "linear",
    );
    expect(config).toMatchObject({
      type: "url",
      name: "linear",
      argument: "workspace",
      checkTool: "get_workspace",
      upstream: { url: "https://mcp.linear.app/mcp", auth: "oauth" },
    });
    expect(config.instances[0]?.authDir).toBe(join(homedir(), "tokens"));
    expect(
      parseConfig({ type: "url", upstream: { url: "https://x.example/mcp" }, instances: { a: { headers: { A: "b" } } } })
        .upstream,
    ).toEqual({ url: "https://x.example/mcp", auth: "headers" });
  });

  it.each([
    [{}, `"instances" must be an object`],
    [{ instances: {} }, `"instances" is empty`],
    [{ instances: { Staging: instance } }, "names may only use"],
    [{ instances: { staging: { apiKey: "key" } } }, `needs a "url"`],
    [{ instances: { staging: { ...instance, url: "dokploy.example" } } }, "must start with http"],
    [{ instances: { staging: { url: instance.url } } }, `exactly one of "apiKey" or "apiKeyEnv"`],
    [{ instances: { staging: { ...instance, apiKeyEnv: "KEY" } } }, `exactly one of "apiKey" or "apiKeyEnv"`],
    [{ instances: { staging: { ...instance, protected: "yes" } } }, `"protected" must be true or false`],
    [{ instances: { staging: instance }, tools: { enabledTags: "project" } }, "must be an array of strings"],
    [{ instances: { staging: { ...instance, env: { DOKPLOY_TIMEOUT: 5000 } } } }, "must be an object of strings"],
    [{ instances: { staging: instance }, upstream: { version: "" } }, `"upstream.version" must be a non-empty string`],
    [{ instances: { staging: instance }, upstream: { version: "latest", command: "node" } }, "not both"],
    [{ instances: { staging: instance }, typo: true }, `unknown field "typo"`],
    [{ instances: { staging: { ...instance, headers: {} } } }, `instance "staging" (type "dokploy"): unknown field "headers"`],
    [{ type: "rest", instances: { staging: instance } }, `"type" must be`],
    [{ argument: "the instance", instances: { staging: instance } }, `"argument" must be a plain identifier`],
    [{ name: "My Bundle", instances: { staging: instance } }, `"name" may only use`],
    [{ instances: { staging: instance }, checkTool: "x" }, `"checkTool" doesn't apply to type "dokploy"`],
    [{ ...linear, tools: {}, instances: { a: {} } }, `"tools" only applies to type "dokploy"`],
    [{ type: "url", instances: { a: {} } }, `"upstream" must be an object`],
    [{ type: "url", upstream: { url: "mcp.linear.app" }, instances: { a: {} } }, `"upstream.url" must start with http`],
    [{ ...linear, upstream: { url: "https://x.example", auth: "basic" }, instances: { a: {} } }, `"headers" or "oauth"`],
    [{ ...linear, instances: { a: { headers: { A: "b" } } } }, `"headers" only apply with`],
    [{ type: "url", upstream: { url: "https://x.example" }, instances: { a: { authDir: "/x" } } }, `"authDir" only applies`],
    [{ type: "command", instances: { a: {} } }, `"upstream" must be an object`],
    [{ type: "command", upstream: { args: [] }, instances: { a: {} } }, `"upstream" needs a "command"`],
  ])("rejects %j", (json, message) => {
    expect(() => parseConfig(json, "test")).toThrow(message);
  });
});

describe("configPath", () => {
  it("takes --config first, then DOKPLOY_BUNDLE_CONFIG, and expands ~", () => {
    expect(configPath({ DOKPLOY_BUNDLE_CONFIG: "/env.json" }, ["--config", "~/linear.json"])).toBe(
      join(homedir(), "linear.json"),
    );
    expect(configPath({ DOKPLOY_BUNDLE_CONFIG: "/env.json" }, [])).toBe("/env.json");
    expect(configPath({}, [])).toBe(join(homedir(), ".config", "dokploy-bundle-mcp", "config.json"));
    expect(() => configPath({}, ["--config"])).toThrow("--config needs a path");
  });
});

describe("resolveApiKey", () => {
  const [fromEnv] = parseConfig({ instances: { staging: { url: instance.url, apiKeyEnv: "STAGING_KEY" } } }).instances;

  it("reads the named environment variable", () => {
    expect(resolveApiKey(fromEnv!, { STAGING_KEY: "secret" })).toBe("secret");
  });

  it("names the variable when it is missing", () => {
    expect(() => resolveApiKey(fromEnv!, {})).toThrow("environment variable STAGING_KEY is not set");
  });
});

describe("resolveHeaders", () => {
  const [withVars] = parseConfig({
    type: "url",
    upstream: { url: "https://x.example/mcp" },
    instances: { a: { headers: { Authorization: "Bearer ${TOKEN}", "X-Team": "${TEAM}-${TEAM}" } } },
  }).instances;

  it("fills in environment variables", () => {
    expect(resolveHeaders(withVars!, { TOKEN: "t", TEAM: "core" })).toEqual({
      Authorization: "Bearer t",
      "X-Team": "core-core",
    });
  });

  it("names a missing variable", () => {
    expect(() => resolveHeaders(withVars!, { TEAM: "core" })).toThrow("environment variable TOKEN is not set");
  });
});

describe("toolFilterEnv", () => {
  it("maps the filter onto upstream variables and leaves out empty ones", () => {
    expect(toolFilterEnv({ preset: "deploy", enabledTags: [], disabledTags: ["stripe", "sso"] })).toEqual({
      DOKPLOY_TOOL_PRESET: "deploy",
      DOKPLOY_DISABLED_TAGS: "stripe,sso",
    });
  });
});
