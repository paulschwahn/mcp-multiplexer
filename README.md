# dokploy-bundle-mcp

One MCP server for all your [Dokploy](https://dokploy.com) instances.

It wraps the official [`@dokploy/mcp`](https://www.npmjs.com/package/@dokploy/mcp) server and adds a required
`instance` argument to every tool. Your MCP client (Claude Desktop, Claude Code or any other) then sees one set
of Dokploy tools, however many instances you run.

## Why

If you register `@dokploy/mcp` once per instance, every instance adds its own copy of all 604 tools. Claude
Code lists every tool name in context at session start, even when it defers the schemas. So each new instance
costs about 8k tokens before you've typed anything.

| Setup | Tool names | ≈ Tokens |
|---|---|---|
| 6 separate `@dokploy/mcp` servers | 3,624 | 50k |
| This bundle, all tools | 606 | 6k |
| This bundle, tags from `config.example.json` | 159 | 1.6k |

With the bundle, that cost stays the same however many instances you add.

## Requirements

- Node.js 20 or newer, and pnpm (npm works too)
- A Dokploy API key for each instance. You generate these in Dokploy under your profile settings.

## Install

```bash
git clone https://github.com/paulschwahn/dokploy-bundle-mcp.git
```

```bash
cd dokploy-bundle-mcp && pnpm install && pnpm build
```

## Configure

The server reads `~/.config/dokploy-bundle-mcp/config.json`. To use a different file, set
`DOKPLOY_BUNDLE_CONFIG`.

```json
{
  "tools": { "enabledTags": ["project", "environment", "application", "compose", "domain", "deployment"] },
  "instances": {
    "staging": {
      "url": "https://dokploy-staging.example.com",
      "apiKeyEnv": "DOKPLOY_STAGING_API_KEY",
      "description": "Staging; hosts the PR preview deployments"
    },
    "production": {
      "url": "https://dokploy.example.com",
      "apiKey": "paste-key-here",
      "description": "Production",
      "protected": true
    }
  }
}
```

If you put keys in the file, make it readable only by you (`chmod 600`). If you'd rather keep keys out of the
file, use `apiKeyEnv` and set the variable in your MCP client's server entry.

### Already using `@dokploy/mcp` in Claude Desktop?

```bash
pnpm import-desktop-config
```

This copies every `@dokploy/mcp` entry from Claude Desktop's config into the bundle config: URL, key and any
extra `DOKPLOY_*` variables. Instance names come from the entry keys, so `dokploy-acme-prod-mcp` becomes
`acme-prod`. Names that contain `prod` are marked protected.

The script:
- writes the file with mode 600;
- refuses to overwrite an existing config unless you pass `--force`;
- prints instance names only, never keys;
- leaves the Desktop config alone and prints the entry to replace them with.

It finds the Desktop config on macOS, Windows and Linux. To read a different file, pass its path as an
argument.

### Config reference

| Field | Meaning |
|---|---|
| `instances.<name>` | One entry per Dokploy instance. Names may only use `a-z`, `0-9` and `-`. |
| `.url` | Dokploy base URL. A trailing `/api` is stripped, because upstream adds it. |
| `.apiKey` / `.apiKeyEnv` | The key itself, or the name of an environment variable that holds it. Exactly one is required. |
| `.description` | Shown by `bundle-instances`. It helps Claude pick the right instance, so say what runs there. |
| `.protected` | Changes need your approval (see [Protect production](#protect-production)). |
| `.env` | Extra upstream variables for this instance, e.g. `DOKPLOY_TIMEOUT`. |
| `env` | Upstream variables for every instance, e.g. `DOKPLOY_REDACT_ENV`. |
| `tools` | Which tools to expose (see below). It applies to all instances. |

### Choosing tools

The bundle passes upstream's own filter through. A tool's tag is the part of its name before the dash:
`application-deploy` has the tag `application`. Use either a `preset` or a list of `enabledTags`, and
optionally `disabledTags` to drop tags from it.

| `tools` | Tags | Tools |
|---|---|---|
| `{ "preset": "minimal" }` | project, application | 43 |
| `{ "preset": "core" }` | minimal + server | 62 |
| `{ "preset": "deploy" }` | core + environment, compose, domain, deployment | 119 |
| `{ "preset": "databases" }` | postgres, redis, mysql, mariadb, mongo, libsql | 94 |
| `{ "preset": "git" }` | github, gitlab, bitbucket, gitea, gitProvider, registry, sshKey | 46 |
| `{}` (default) | everything | 604 |

## Connect your client

The server talks MCP over stdio. Name it `dokploy`: the name becomes the tool prefix (`mcp__dokploy__…`)
and the hook below matches on it.

**Claude Desktop.** Quit the app completely first, because it rewrites its config while running. Then add
this to `claude_desktop_config.json` and start the app again:

```json
"mcpServers": {
  "dokploy": {
    "command": "/absolute/path/to/node",
    "args": ["/path/to/dokploy-bundle-mcp/dist/index.js"]
  }
}
```

Claude Desktop doesn't load your shell's `PATH`, so give node's absolute path (`which node`). This matters
especially if you use nvm.

**Claude Code:**

```bash
claude mcp add dokploy --scope user -- "$(which node)" /path/to/dokploy-bundle-mcp/dist/index.js
```

**Any other MCP client:** run `node /path/to/dokploy-bundle-mcp/dist/index.js` as a stdio server.

## Use it

Start with a health check. Ask Claude to *"run bundle-check"*. Each instance should come back with its Dokploy
version, or with the reason it failed.

After that, just ask for what you want and name the instance:

- *"Show the last deployments of the api app on staging."*
- *"Redeploy the web compose on production."* On a protected instance, this asks for your approval first.

Every Dokploy tool takes a required `instance` argument, and there is no default. Claude has to choose an
instance on every call, and an unknown name is rejected with the list of valid ones. Two tools come from the
bundle itself:

| Tool | What it does |
|---|---|
| `bundle-instances` | Lists name, URL, description, whether it's protected, and whether a connection is open. Never shows keys. |
| `bundle-check` | Checks that one instance, or all of them, is reachable and accepts its key. Returns the Dokploy version. |

## Protect production

A Claude Code `PreToolUse` hook asks for your approval before any tool
that isn't read-only runs against an instance marked `"protected": true`. Read-only tools still run without
asking. Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__dokploy__.*",
        "hooks": [
          { "type": "command", "command": "/absolute/path/to/node /path/to/dokploy-bundle-mcp/dist/hook.js" }
        ]
      }
    ]
  }
}
```

What counts as read-only is upstream's `readOnlyHint` (226 of the 604 tools). The build writes that list to
`dist/catalog.json`. If the hook can't read the config or doesn't know a tool, it asks.

Hooks only run in Claude Code: the CLI, the IDE extensions and the Code tab in Claude Desktop. In other clients,
`protected` is only a note in the tool description.

## Troubleshooting

- **The tools don't appear in Claude Desktop.** Check `~/Library/Logs/Claude/mcp-server-dokploy.log` on macOS.
  The usual cause is a node path that isn't absolute. If the config is invalid, the server exits at startup
  with a message naming the field.
- **`bundle-check` reports `HTTP 401 (API key rejected)`.** The key is wrong or was revoked. A connection error
  means the URL is wrong; it should be the base URL you open in the browser.
- **One instance fails and the others work.** That's by design, for example when an `apiKeyEnv` variable
  isn't set. The error names the missing variable.
- **A config change has no effect.** The server reads the config at startup, so restart your client.
- **The hook doesn't prompt.** Check that its matcher uses the server name from your client config. Then run
  the hook by hand, adjusting the instance and tool to a protected instance of yours:
  ```bash
  echo '{"tool_name":"mcp__dokploy__application-deploy","tool_input":{"instance":"production"}}' | node dist/hook.js
  ```
  For a protected instance this prints a `permissionDecision: "ask"`. If you set `DOKPLOY_BUNDLE_CONFIG` for the
  server, the hook needs it too.

## How it works

- **Listing tools:** the bundle starts a throwaway `@dokploy/mcp` process with a URL that goes nowhere, since
  listing never calls the API. It takes that process's tool list, puts the required `instance` argument first
  in each tool, and adds `bundle-instances` and `bundle-check`.
- **Calling a tool:** the bundle removes `instance` and forwards the call to that instance's own `@dokploy/mcp`
  process. The process starts on first use and stays running. It gets only its own URL and key, plus PATH,
  HOME and similar, and never sees the other instances' keys.
- **Why `instance` and not `server`:** Dokploy already uses "server" for its remote build hosts (`serverId`).

## Development

```bash
pnpm test        # stub upstream, plus the real @dokploy/mcp pointed at a dead URL
pnpm typecheck
```

To upgrade `@dokploy/mcp`, bump the version and run `pnpm build` again, which regenerates the read-only
catalog. If a new upstream tool has its own `instance` argument, the server logs it and skips that tool.

## License

[MIT](LICENSE)
