# dokploy-bundle-mcp

One MCP server for all your [Dokploy](https://dokploy.com) instances, or for all your accounts on any other MCP
server, such as several [Linear](https://linear.app) workspaces.

It runs one upstream connection per instance and adds a required argument to every tool (`instance`,
`workspace` or a name you pick) that says which instance the call goes to. Your MCP client (Claude Desktop,
Claude Code or any other) sees one set of tools, however many instances you have.

For Dokploy, the bundle wraps the official [`@dokploy/mcp`](https://www.npmjs.com/package/@dokploy/mcp).
[Other MCP servers](#other-mcp-servers) can be any stdio command or remote URL, with per-instance headers or a
per-instance OAuth login.

## Why

If you register an MCP server once per instance, every instance adds its own copy of all its tools. Claude Code
lists every tool name in context at session start, even when it defers the schemas. `@dokploy/mcp` has 604
tools, so each Dokploy instance costs about 8k tokens before you've typed anything.

| Setup | Tool names | ≈ Tokens |
|---|---|---|
| 6 separate `@dokploy/mcp` servers | 3,624 | 50k |
| This bundle, all tools | 606 | 6k |
| This bundle, tags from `config.example.json` | 159 | 1.6k |

With the bundle, that cost stays the same however many instances you add. Built-in connectors often reach only
one account; Linear's, for example, connects to a single workspace. The bundle reaches all of them through one
connection.

## Requirements

- Node.js 20 or newer, and pnpm (npm works too)
- For Dokploy: an API key for each instance. You generate these in Dokploy under your profile settings.

## Install

```bash
git clone https://github.com/paulschwahn/dokploy-bundle-mcp.git
```

```bash
cd dokploy-bundle-mcp && pnpm install && pnpm build
```

## Configure

Each bundle has its own config file. The server reads the file you pass with `--config`, then
`DOKPLOY_BUNDLE_CONFIG`, then `~/.config/dokploy-bundle-mcp/config.json`. The examples below are for Dokploy,
the default type; see [Other MCP servers](#other-mcp-servers) for the rest.

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
| `type` | `dokploy` (default), `command` or `url`. See [Other MCP servers](#other-mcp-servers). |
| `name` | Names this bundle's cache files. Defaults to the config file's name, e.g. `linear` for `linear.json`. |
| `argument` | The routing argument added to every tool. Defaults to `instance`. |
| `instances.<name>` | One entry per instance. Names may only use `a-z`, `0-9` and `-`. |
| `.description` | Shown by `bundle-instances`. It helps Claude pick the right instance, so say what it is. |
| `.protected` | Changes need your approval (see [Protect production](#protect-production)). |
| `.env` | Extra environment for this instance's upstream process. |
| `.url` (dokploy) | Dokploy base URL. A trailing `/api` is stripped, because upstream adds it. |
| `.apiKey` / `.apiKeyEnv` (dokploy) | The key itself, or the name of an environment variable that holds it. Exactly one is required. |
| `env` | Environment for every instance's upstream, e.g. `DOKPLOY_REDACT_ENV`. |
| `tools` (dokploy) | Which tools to expose (see below). It applies to all instances. |
| `upstream.version` (dokploy) | Which `@dokploy/mcp` to run: `bundled` (default), `latest`, a range or an exact version (see [Upgrading](#upgrading-dokploymcp)). |

Unknown fields are rejected, so a typo fails at startup rather than being silently ignored.

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

### Upgrading `@dokploy/mcp`

By default the bundle runs the `@dokploy/mcp` version pinned in `package.json`. To follow upstream releases
instead, set `upstream.version`:

```json
{ "upstream": { "version": "latest" } }
```

| `version` | Runs |
|---|---|
| `"bundled"` (default) | the version in `package.json`, updated when you pull this repo and rebuild |
| `"latest"` | the newest release |
| `"~0.30.7"` | the newest 0.30.x patch release |
| `"0.31.2"` | exactly that version |

How it works:
- **Checked once per start.** When your client starts the server, the bundle asks npm which version the spec
  resolves to. A running session never switches versions.
- **Installed once per version.** A new version is installed into `~/.cache/dokploy-bundle-mcp/upstream/<version>`
  with `--ignore-scripts`. The three newest versions are kept.
- **Falls back when offline.** If npm or the registry can't be reached, the bundle uses the newest cached
  version, or else the bundled one.
- **Easy to check.** `bundle-instances` shows which version is running and why.

Before you switch, know two things:
- **Every API key goes to whatever version runs.** With `latest`, a new upstream release gets your keys without
  anyone reviewing it. For production instances, a patch range or `bundled` is the more careful choice.
- **Upstream is still 0.x**, so a minor release can rename or remove tools. This repo's tests only cover the
  bundled version.

## Connect your client

The server talks MCP over stdio. The name you register it under becomes the tool prefix, so Dokploy registered
as `dokploy` gives `mcp__dokploy__…`. The approval hook below matches on that name.

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

For a second bundle, add another entry with `"--config", "/path/to/its-config.json"` after `index.js` in
`args`. Claude Desktop doesn't load your shell's `PATH`, so give node's absolute path (`which node`). This
matters especially if you use nvm.

**Claude Code:**

```bash
claude mcp add dokploy --scope user -- "$(which node)" /path/to/dokploy-bundle-mcp/dist/index.js
```

**Any other MCP client:** run `node /path/to/dokploy-bundle-mcp/dist/index.js [--config <file>]` as a stdio
server.

## Use it

Start with a health check. Ask Claude to *"run bundle-check"*. Each instance should come back with its Dokploy
version, or with the reason it failed.

After that, just ask for what you want and name the instance:

- *"Show the last deployments of the api app on staging."*
- *"Redeploy the web compose on production."* On a protected instance, this asks for your approval first.

Every tool takes the required routing argument, and there is no default. Claude has to choose an instance on
every call, and an unknown name is rejected with the list of valid ones. Two tools come from the bundle itself:

| Tool | What it does |
|---|---|
| `bundle-instances` | Lists name, description, whether it's protected, whether a connection is open, and what serves the instances. Never shows keys or header values. |
| `bundle-check` | Checks one instance, or all of them. For Dokploy it returns the version; for other types it calls `checkTool` or pings. |

## Other MCP servers

Set `type` to bundle a server other than Dokploy. Every instance must serve the same tools: the bundle lists them
from the first instance that connects.

| `type` | `upstream` | Per instance |
|---|---|---|
| `command` | `{ "command": "…", "args": [ … ] }`: any stdio server | `args` (appended), `env` |
| `url` | `{ "url": "…" }`: a remote server, using headers | `headers`; `${VAR}` in a value is read from the environment |
| `url` | `{ "url": "…", "auth": "oauth" }`: a remote server with an OAuth login | `authDir`: where its tokens live |

`checkTool` names a read-only tool that `bundle-check` calls on each instance. Pick one that shows which account
the instance reached. Without it, `bundle-check` only pings.

OAuth logins go through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), pinned in `package.json`, which
keeps each instance's tokens in its own directory. By default that's
`~/.mcp-auth/dokploy-bundle-mcp/<bundle>/<instance>`. Point `authDir` at an existing `MCP_REMOTE_CONFIG_DIR` to
reuse a login you already have.

### Example: Linear across several workspaces

`~/.config/dokploy-bundle-mcp/linear.json`:

```json
{
  "type": "url",
  "argument": "workspace",
  "upstream": { "url": "https://mcp.linear.app/mcp", "auth": "oauth" },
  "checkTool": "get_workspace",
  "instances": {
    "acme": { "description": "Acme (linear.app/acme)" },
    "side-project": { "description": "Side project (linear.app/side)" }
  }
}
```

Register it as a second server:

```bash
claude mcp add linear --scope user -- "$(which node)" /path/to/dokploy-bundle-mcp/dist/index.js --config ~/.config/dokploy-bundle-mcp/linear.json
```

Then ask Claude to *"run bundle-check"*. It goes through the workspaces one at a time:
- A workspace without a login opens Linear's sign-in in your browser.
- **Choose the workspace that instance is for** on Linear's consent screen. Linear preselects the one you used last.
- `get_workspace` then shows which workspace each login reached. If one is wrong, delete that instance's token
  directory and run the check again.

Linear's MCP server may also accept a personal API key instead of OAuth. Third-party docs say so, but Linear's
own docs don't confirm it:

```json
"upstream": { "url": "https://mcp.linear.app/mcp" },
"instances": { "acme": { "headers": { "Authorization": "Bearer ${LINEAR_ACME_API_KEY}" } } }
```

## Protect production

A Claude Code `PreToolUse` hook asks for your approval before any tool that isn't read-only runs against an
instance marked `"protected": true`. Read-only tools still run without asking. Add one entry per bundle to
`~/.claude/settings.json`. Give each the same `--config` as its server, and a matcher with the name you
registered that server under:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__dokploy__.*",
        "hooks": [
          { "type": "command", "command": "/absolute/path/to/node /path/to/dokploy-bundle-mcp/dist/hook.js" }
        ]
      },
      {
        "matcher": "mcp__linear__.*",
        "hooks": [
          { "type": "command", "command": "/absolute/path/to/node /path/to/dokploy-bundle-mcp/dist/hook.js --config ~/.config/dokploy-bundle-mcp/linear.json" }
        ]
      }
    ]
  }
}
```

What counts as read-only comes from upstream's `readOnlyHint` annotations: 226 of Dokploy's 604 tools, and 43 of
Linear's 82. Each time the server lists tools, it writes that list for the upstream it runs to
`~/.cache/dokploy-bundle-mcp/catalogs/<bundle>.json`. Until a Dokploy server has started, the hook uses
`dist/catalog.json` from the build. If the hook can't read the config or doesn't know a tool, it asks.

Hooks only run in Claude Code: the CLI, the IDE extensions and the Code tab in Claude Desktop. In other clients,
`protected` is only a note in the tool description.

## Troubleshooting

- **The tools don't appear in Claude Desktop.** Check `~/Library/Logs/Claude/mcp-server-<name>.log` on macOS.
  The usual cause is a node path that isn't absolute. If the config is invalid, the server exits at startup
  with a message naming the field.
- **`bundle-check` reports `HTTP 401 (API key rejected)`.** The key is wrong or was revoked. A connection error
  means the URL is wrong; it should be the base URL you open in the browser.
- **One instance fails and the others work.** That's by design, for example when an `apiKeyEnv` or `${VAR}`
  variable isn't set, or a login is missing. The error says which.
- **An OAuth login doesn't open a browser.** mcp-remote writes the sign-in URL to the server log; open it from
  there. The login waits for up to five minutes.
- **A config change has no effect.** The server reads the config at startup, so restart your client.
- **`upstream.version` isn't the version you expected.** Ask for `bundle-instances`: its `upstream` field shows
  the running version, and if npm failed, the reason it fell back.
- **The hook doesn't prompt.** Check that its matcher uses the server name from your client config and that it
  has the same `--config` as the server. Then run it by hand, adjusting the tool and instance to a protected
  instance of yours:
  ```bash
  echo '{"tool_name":"mcp__dokploy__application-deploy","tool_input":{"instance":"production"}}' | node dist/hook.js
  ```
  For a protected instance this prints a `permissionDecision: "ask"`.

## How it works

- **Listing tools:** the bundle connects to the first instance that works and lists its tools. It puts the
  required routing argument first in each one, and adds `bundle-instances` and `bundle-check`. A tool that
  already has an argument with the routing argument's name is skipped, and the skip is logged.
- **Calling a tool:** the bundle removes the routing argument and forwards the call to that instance's own
  connection, which opens on first use and stays open. A stdio upstream gets only its own settings, plus PATH,
  HOME and similar, and never sees the other instances' keys.
- **Why `instance` and not `server` for Dokploy:** Dokploy already uses "server" for its remote build hosts
  (`serverId`).

## Development

```bash
pnpm test        # stub and echo upstreams, an HTTP server, and the real @dokploy/mcp pointed at a dead URL
pnpm typecheck
```

To change the bundled `@dokploy/mcp`, bump it in `package.json` and run `pnpm build`, which regenerates
`dist/catalog.json`.

## License

[MIT](LICENSE)
