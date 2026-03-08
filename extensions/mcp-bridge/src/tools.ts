import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { McpServerConnection } from "./types.js";

type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function ensureToolParameters(inputSchema: unknown): Record<string, unknown> {
  if (
    inputSchema &&
    typeof inputSchema === "object" &&
    !Array.isArray(inputSchema) &&
    (inputSchema as Record<string, unknown>).type === "object"
  ) {
    return inputSchema as Record<string, unknown>;
  }
  return {
    type: "object",
    additionalProperties: true,
    properties: {},
  };
}

function stringifyMcpResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function mapMcpContent(rawContent: unknown): McpToolContent[] {
  if (!Array.isArray(rawContent)) {
    return [];
  }

  const content: McpToolContent[] = [];
  for (const item of rawContent) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return content;
}

function createFallbackContent(callResult: Record<string, unknown>): McpToolContent[] {
  if (callResult.structuredContent !== undefined) {
    return [{ type: "text", text: stringifyMcpResult(callResult.structuredContent) }];
  }
  return [{ type: "text", text: stringifyMcpResult(callResult) }];
}

function extractErrorMessage(
  callResult: Record<string, unknown>,
  content: McpToolContent[],
): string {
  const textParts = content
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean);
  if (textParts.length > 0) {
    return textParts.join("\n\n");
  }
  if (callResult.structuredContent !== undefined) {
    return stringifyMcpResult(callResult.structuredContent);
  }
  return stringifyMcpResult(callResult);
}

async function listAllMcpTools(conn: McpServerConnection) {
  const tools: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;

  do {
    const page = await conn.client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as Array<Record<string, unknown>>));
    cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor);

  return tools;
}

export async function createMcpTools(conn: McpServerConnection): Promise<AnyAgentTool[]> {
  const discoveredTools = await listAllMcpTools(conn);

  return discoveredTools.map((mcpTool) => {
    const mcpToolName = String(mcpTool.name ?? "").trim();
    const toolName = `mcp_${conn.name}__${mcpToolName}`;

    return {
      name: toolName,
      label: `${conn.name}: ${mcpToolName}`,
      description:
        typeof mcpTool.description === "string" && mcpTool.description.trim()
          ? mcpTool.description
          : `MCP tool from ${conn.name}`,
      parameters: ensureToolParameters(mcpTool.inputSchema),
      execute: async (_toolCallId, args) => {
        const callResult = (await conn.client.callTool({
          name: mcpToolName,
          arguments:
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
        })) as Record<string, unknown>;

        const content = mapMcpContent(callResult.content);
        const normalizedContent = content.length > 0 ? content : createFallbackContent(callResult);
        if (callResult.isError === true) {
          throw new Error(extractErrorMessage(callResult, normalizedContent));
        }

        return {
          content: normalizedContent,
          details: callResult,
        };
      },
    };
  });
}
