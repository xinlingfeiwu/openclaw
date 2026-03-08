import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnyAgentTool } from "openclaw/plugin-sdk";

export type McpTransport = "http" | "stdio";

export type McpServerConfig = {
  transport?: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  description?: string;
};

export type ResolvedMcpServerConfig = {
  transport: McpTransport;
  enabled: boolean;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
};

export type McpBridgeConfig = {
  servers?: Record<string, McpServerConfig>;
};

export type McpServerConnection = {
  name: string;
  config: ResolvedMcpServerConfig;
  client: Client;
  close: () => Promise<void>;
};

export type McpBridgeState = {
  tools: AnyAgentTool[];
  connections: McpServerConnection[];
};
