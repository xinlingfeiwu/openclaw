import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConnection, ResolvedMcpServerConfig } from "./types.js";

function buildProcessEnv(
  extraEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!extraEnv) {
    return undefined;
  }

  const merged = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return {
    ...merged,
    ...extraEnv,
  };
}

export async function connectMcpServer(
  name: string,
  config: ResolvedMcpServerConfig,
): Promise<McpServerConnection> {
  const client = new Client({
    name: `openclaw-mcp-bridge/${name}`,
    version: "2026.3.3",
  });

  if (config.transport === "http") {
    const transport = new StreamableHTTPClientTransport(new URL(config.url!));
    await client.connect(transport);
  } else {
    const transport = new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: buildProcessEnv(config.env),
    });
    await client.connect(transport);
  }

  return {
    name,
    config,
    client,
    close: async () => {
      await client.close();
    },
  };
}
