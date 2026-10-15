import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { compareVersions, npmErrorSummary, resolveUpstream } from "../src/upstream-package.js";

const ENTRY = ["node_modules", "@dokploy", "mcp", "build", "index.js"];

let dir: string;
let calls: string[][];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dokploy-bundle-upstream-"));
  calls = [];
});

function install(prefix: string) {
  mkdirSync(join(prefix, ...ENTRY.slice(0, -1)), { recursive: true });
  writeFileSync(join(prefix, ...ENTRY), "");
}

/** Answers `npm view` with the given output and fakes `npm install` by creating the entry file. */
function fakeNpm(view: string | Error) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === "view") {
      if (view instanceof Error) throw view;
      return view;
    }
    install(args[args.indexOf("--prefix") + 1]!);
    return "";
  };
}

const resolve = (version: string, view: string | Error) =>
  resolveUpstream({ version }, { npm: fakeNpm(view), dir, log: () => {} });

describe("resolveUpstream", () => {
  it("installs the resolved version once and reuses it", async () => {
    const first = await resolve("latest", '"0.31.0"');
    expect(first).toEqual({
      command: process.execPath,
      args: [join(dir, "0.31.0", ...ENTRY)],
      label: "@dokploy/mcp@0.31.0 (latest)",
    });
    expect(calls.map((args) => args[0])).toEqual(["view", "install"]);
    expect(calls[1]).toContain("--ignore-scripts");

    calls = [];
    await resolve("latest", '"0.31.0"');
    expect(calls.map((args) => args[0])).toEqual(["view"]);
  });

  it("takes the highest version a range matches", async () => {
    const result = await resolve("~0.30.1", '["0.30.1", "0.30.10", "0.30.9"]');
    expect(result.label).toBe("@dokploy/mcp@0.30.10 (~0.30.1)");
  });

  it("falls back to the newest cached version when npm fails", async () => {
    for (const version of ["0.30.9", "0.31.0"]) install(join(dir, version));
    mkdirSync(join(dir, "not-a-version"));
    const result = await resolve("latest", new Error("network request failed"));
    expect(result.args).toEqual([join(dir, "0.31.0", ...ENTRY)]);
    expect(result.label).toBe("@dokploy/mcp@0.31.0 (cached; latest unavailable: network request failed)");
  });

  it("falls back to the bundled version when nothing is cached", async () => {
    const result = await resolve("latest", new Error("network request failed"));
    expect(result.label).toMatch(/^@dokploy\/mcp@\d+\.\d+\.\d+ \(bundled\); latest unavailable: network request failed$/);
  });

  it("never installs something that is not a version", async () => {
    const result = await resolve("latest", '"../../escape"');
    expect(calls.map((args) => args[0])).toEqual(["view"]);
    expect(result.label).toContain("(bundled)");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the three newest versions", async () => {
    for (const version of ["0.29.0", "0.30.0", "0.30.5", "0.30.9"]) install(join(dir, version));
    await resolve("latest", '"0.31.0"');
    expect(readdirSync(dir).sort(compareVersions)).toEqual(["0.30.5", "0.30.9", "0.31.0"]);
  });

  it("uses the bundled version without asking npm", async () => {
    const result = await resolve("bundled", '"0.31.0"');
    expect(calls).toEqual([]);
    expect(existsSync(result.args[0]!)).toBe(true);
    expect(result.label).toMatch(/^@dokploy\/mcp@\d+\.\d+\.\d+ \(bundled\)$/);
  });

  it("runs a custom command as given", async () => {
    const result = await resolveUpstream({ command: "node", args: ["stub.mjs"] });
    expect(result).toEqual({ command: "node", args: ["stub.mjs"], label: "custom command: node stub.mjs" });
  });
});

describe("compareVersions", () => {
  it("orders numerically and puts prereleases first", () => {
    expect(["0.30.10", "0.30.9", "1.0.0", "1.0.0-beta.1", "0.4.0"].sort(compareVersions)).toEqual([
      "0.4.0",
      "0.30.9",
      "0.30.10",
      "1.0.0-beta.1",
      "1.0.0",
    ]);
  });
});

describe("npmErrorSummary", () => {
  it("picks the line that explains the failure", () => {
    expect(
      npmErrorSummary(
        "npm error code E404\nnpm error 404 No match found for version ^9\nnpm error 404\nnpm error A complete log...",
      ),
    ).toBe("404 No match found for version ^9");
    expect(
      npmErrorSummary(
        "npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND\n" +
          "npm error network request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
      ),
    ).toBe("network request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org");
  });
});
