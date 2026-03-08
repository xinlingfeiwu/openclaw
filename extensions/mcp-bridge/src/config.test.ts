import { describe, expect, it } from "vitest";
import { resolveMcpBridgeConfig } from "./config.js";

describe("resolveMcpBridgeConfig", () => {
  it("merges legacy top-level mcpServers with plugin servers", () => {
    const resolved = resolveMcpBridgeConfig({
      pluginConfig: {
        servers: {
          fetcher: {
            url: "https://example.com/mcp",
          },
        },
      },
      legacyMcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { DEMO: "1" },
          description: "Filesystem bridge",
        },
      },
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    expect(resolved.value.servers.filesystem).toEqual({
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { DEMO: "1" },
      description: "Filesystem bridge",
      url: undefined,
    });
    expect(resolved.value.servers.fetcher).toEqual({
      transport: "http",
      enabled: true,
      url: "https://example.com/mcp",
      command: undefined,
      args: undefined,
      env: undefined,
      description: undefined,
    });
  });

  it("infers stdio transport when only command is provided", () => {
    const resolved = resolveMcpBridgeConfig({
      pluginConfig: {
        servers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
        },
      },
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    expect(resolved.value.servers.github.transport).toBe("stdio");
  });

  it("prefers plugin config when both plugin and legacy define the same server", () => {
    const resolved = resolveMcpBridgeConfig({
      pluginConfig: {
        servers: {
          github: {
            command: "node",
            args: ["custom-github-mcp.js"],
            enabled: false,
            description: "Plugin override",
          },
        },
      },
      legacyMcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          description: "Legacy github",
        },
      },
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    expect(resolved.value.servers.github).toEqual({
      transport: "stdio",
      enabled: false,
      command: "node",
      args: ["custom-github-mcp.js"],
      env: undefined,
      url: undefined,
      description: "Plugin override",
    });
  });

  it("rejects invalid server definitions", () => {
    const resolved = resolveMcpBridgeConfig({
      pluginConfig: {
        servers: {
          broken: {},
        },
      },
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected config parsing to fail");
    }
    expect(resolved.message).toContain("must define either url or command");
  });
});
