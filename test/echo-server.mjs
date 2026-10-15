// A generic MCP server for the tests: its tools echo back what the process or the request was given.
// Imported by the HTTP tests; run directly, it serves stdio.
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tools = [
  {
    name: "whoami",
    description: "Echo what this server was started with",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "save_issue",
    description: "Echo the arguments",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
  {
    name: "collide",
    description: "Has its own workspace argument, so a bundle routing on workspace must skip it",
    inputSchema: { type: "object", properties: { workspace: { type: "string" } } },
  },
];

export function createEchoServer() {
  const server = new Server({ name: "echo", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tool: params.name,
          args: params.arguments ?? {},
          authorization: extra.requestInfo?.headers?.authorization ?? null,
          marker: process.env.ECHO_MARKER ?? null,
          argv: process.argv.slice(2),
          leakedSecrets: Object.keys(process.env).filter((key) => key.startsWith("TEST_SECRET_")),
        }),
      },
    ],
  }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createEchoServer().connect(new StdioServerTransport());
}
