import { describe, expect, it } from "vitest";
import { parseConfig, resolveApiKey, toolFilterEnv } from "../src/config.js";

const instance = { url: "https://dokploy.example", apiKey: "key" };

describe("parseConfig", () => {
  it("normalises URLs and fills defaults", () => {
    const config = parseConfig({ instances: { staging: { ...instance, url: "https://dokploy.example/api/" } } });
    expect(config.instances).toEqual([
      {
        name: "staging",
        url: "https://dokploy.example",
        apiKey: "key",
        apiKeyEnv: undefined,
        description: undefined,
        protected: false,
        env: {},
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
  ])("rejects %j", (json, message) => {
    expect(() => parseConfig(json, "test")).toThrow(message);
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

describe("toolFilterEnv", () => {
  it("maps the filter onto upstream variables and leaves out empty ones", () => {
    expect(toolFilterEnv({ preset: "deploy", enabledTags: [], disabledTags: ["stripe", "sso"] })).toEqual({
      DOKPLOY_TOOL_PRESET: "deploy",
      DOKPLOY_DISABLED_TAGS: "stripe,sso",
    });
  });
});
