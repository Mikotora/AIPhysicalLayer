import { createServer, type Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";
import { McpCoreClient, CoreApiError, tokenFromFile } from "../integrations/mcp/core-client.ts";
import { FileMcpAccessLog, type McpAccessLogWriter, type McpAccessLogEntry } from "./mcp-access-log.ts";

const DEFAULT_LOG_PATH = fileURLToPath(new URL("../data/mcp-access.jsonl", import.meta.url));
const DEFAULT_TOKEN_PATH = fileURLToPath(new URL("../.runtime/secrets/mcp-private-plugin.key", import.meta.url));
const TOOL_INSTRUCTIONS = [
  "Use get_state for current readings and observed/unknown state.",
  "Use get_capabilities before choosing a parameterized action.",
  "Call execute_action only for an explicit user request.",
  "Use a fresh intent_id for each new user intent, including an explicit request to do it again.",
  "Reuse an intent_id only for transport retry of that same intent. Never automatically retry an unknown outcome.",
  "If an action result includes recording.status temporary, always tell the user that it was not persistently recorded and duplicate prevention is temporary.",
  "last_command is history, not current observed state.",
].join(" ");

const EmptyInput = z.object({}).strict();
const ExecuteInput = z.object({
  action_id: z.string().min(3).max(128).regex(/^[a-z0-9._-]+$/).describe("Action ID selected from get_capabilities"),
  parameters: z.record(z.string(), z.unknown()).describe("Exact parameters allowed by the selected capability"),
  intent_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9._~-]+$/).describe("Stable idempotency identifier for this one user intent"),
}).strict();

export type McpServerOptions = {
  coreClient?: McpCoreClient;
  accessLog?: McpAccessLogWriter;
  clientId?: string;
  now?: () => Date;
};

export function createPhysicalLayerMcpServer(options: McpServerOptions = {}): McpServer {
  const clientId = options.clientId ?? process.env.MCP_CLIENT_ID ?? "chatgpt-private-plugin";
  const core = options.coreClient ?? new McpCoreClient(tokenFromFile(process.env.MCP_CORE_TOKEN_FILE ?? DEFAULT_TOKEN_PATH));
  const accessLog = options.accessLog ?? new FileMcpAccessLog(process.env.MCP_ACCESS_LOG_PATH ?? DEFAULT_LOG_PATH);
  const now = options.now ?? (() => new Date());
  const server = new McpServer(
    { name: "ai-physical-layer", version: "1.0.0" },
    { instructions: TOOL_INSTRUCTIONS },
  );

  const record = async (tool: McpAccessLogEntry["tool"], status: McpAccessLogEntry["status"]) => {
    await accessLog.append({ timestamp: now().toISOString(), client_id: clientId, tool, status });
  };
  const readTool = async (tool: "get_capabilities" | "get_state", operation: () => Promise<Record<string, unknown>>) => {
    try {
      const result = await operation();
      await record(tool, "succeeded");
      return toolResult(result);
    } catch (error) {
      await record(tool, error instanceof CoreApiError ? error.outcome : "unknown");
      return toolError(error);
    }
  };

  server.registerTool("get_capabilities", {
    title: "Get physical capabilities",
    description: "List the vendor-neutral devices, readable fields, actions, and allowed parameter ranges available through the common physical layer.",
    inputSchema: EmptyInput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => readTool("get_capabilities", () => core.getCapabilities()));

  server.registerTool("get_state", {
    title: "Get physical state",
    description: "Read current observed values, explicitly unknown fields, sensor timestamps, and separate last_command history without guessing.",
    inputSchema: EmptyInput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => readTool("get_state", () => core.getState()));

  server.registerTool("execute_action", {
    title: "Execute physical action",
    description: "Execute one catalog action explicitly requested by the user. Select action_id and parameters from get_capabilities. A new user intent requires a fresh intent_id; a retry of the same intent must reuse it. If recording.status is temporary, explicitly relay its warning to the user.",
    inputSchema: ExecuteInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action_id, parameters, intent_id }) => {
    try {
      const result = await core.executeAction(action_id, parameters, intent_id);
      await record("execute_action", "succeeded");
      return toolResult(result);
    } catch (error) {
      await record("execute_action", error instanceof CoreApiError ? error.outcome : "unknown");
      return toolError(error);
    }
  });

  return server;
}

export function createMcpHttpServer(options: McpServerOptions = {}): Server {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.get("/health", (_request, response) => response.status(200).json({
    service: "ai-physical-layer-mcp",
    status: "ok",
    protocol: "streamable-http",
    endpoint: "/mcp",
    listening_scope: "localhost",
    external_auth_boundary: "secure-mcp-tunnel",
    downstream_auth: "dedicated-client-key",
    tools: ["get_capabilities", "get_state", "execute_action"],
    actuation_performed: false,
  }));
  app.post("/mcp", async (request, response) => {
    const mcp = createPhysicalLayerMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    } finally {
      response.on("close", () => { void transport.close(); void mcp.close(); });
    }
  });
  app.all("/mcp", (_request, response) => response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
  return createServer(app);
}

function toolResult(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Common physical layer request failed";
  const outcome = error instanceof CoreApiError ? error.outcome : "unknown";
  const recording = error instanceof CoreApiError ? error.recording : undefined;
  const payload = { error: message, outcome, ...(recording ? { recording } : {}) };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? "8792");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP_PORT must be an integer between 1 and 65535");
  return port;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const host = "127.0.0.1";
  const port = parsePort(process.env.MCP_PORT);
  const server = createMcpHttpServer();
  server.listen(port, host, () => {
    console.log(`AIPhysicalLayer Streamable HTTP MCP listening at http://${host}:${port}/mcp`);
    console.log("External access requires the authenticated Secure MCP Tunnel boundary");
  });
}
