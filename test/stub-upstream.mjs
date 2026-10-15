// Stands in for @dokploy/mcp: two tools, and every call echoes back what the process was given.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tools = [
  {
    name: "project-all",
    description: "GET /project.all",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "Project All", readOnlyHint: true },
  },
  {
    name: "application-deploy",
    description: "POST /application.deploy",
    inputSchema: { type: "object", properties: { applicationId: { type: "string" } }, required: ["applicationId"] },
    annotations: { title: "Application Deploy", idempotentHint: true },
  },
];

const server = new Server({ name: "stub-dokploy", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        tool: params.name,
        args: params.arguments ?? {},
        url: process.env.DOKPLOY_URL,
        apiKey: process.env.DOKPLOY_API_KEY,
        enabledTags: process.env.DOKPLOY_ENABLED_TAGS ?? null,
        redactEnv: process.env.DOKPLOY_REDACT_ENV ?? null,
        timeout: process.env.DOKPLOY_TIMEOUT ?? null,
        leakedKeys: Object.keys(process.env).filter((key) => key.startsWith("TEST_DOKPLOY_KEY_")),
      }),
    },
  ],
}));
await server.connect(new StdioServerTransport());
