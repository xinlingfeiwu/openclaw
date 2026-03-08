import { describe, expect, it, vi } from "vitest";
import { createMcpTools } from "./tools.js";
import type { McpServerConnection } from "./types.js";

function createConnection(params: {
  listTools: (args?: { cursor?: string }) => Promise<Record<string, unknown>>;
  callTool: (args: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
}): McpServerConnection {
  return {
    name: "demo",
    config: {
      transport: "stdio",
      enabled: true,
      command: "npx",
    },
    client: {
      listTools: params.listTools,
      callTool: params.callTool,
    } as McpServerConnection["client"],
    close: vi.fn(async () => {}),
  };
}

describe("createMcpTools", () => {
  it("loads all tool pages", async () => {
    const listTools = vi
      .fn<(args?: { cursor?: string }) => Promise<Record<string, unknown>>>()
      .mockImplementation(async (args) => {
        if (!args?.cursor) {
          return {
            tools: [
              {
                name: "first",
                description: "first tool",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            nextCursor: "cursor-2",
          };
        }

        return {
          tools: [
            {
              name: "second",
              description: "second tool",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          nextCursor: null,
        };
      });

    const connection = createConnection({
      listTools,
      callTool: vi.fn(async () => ({ content: [] })),
    });

    const tools = await createMcpTools(connection);

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp_demo__first", "mcp_demo__second"]);
  });

  it("propagates MCP tool errors", async () => {
    const connection = createConnection({
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: "explode",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        nextCursor: null,
      })),
      callTool: vi.fn(async () => ({
        isError: true,
        content: [{ type: "text", text: "boom" }],
      })),
    });

    const [tool] = await createMcpTools(connection);
    await expect(tool.execute?.("tool-call", {})).rejects.toThrow("boom");
  });
});
