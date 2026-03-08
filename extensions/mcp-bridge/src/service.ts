import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { connectMcpServer } from "./client.js";
import { resolveMcpBridgeConfig } from "./config.js";
import { createMcpTools } from "./tools.js";
import type { McpBridgeState, ResolvedMcpServerConfig } from "./types.js";

function describeServerTarget(config: ResolvedMcpServerConfig): string {
  return config.transport === "http" ? config.url! : config.command!;
}

async function closeConnections(
  state: McpBridgeState,
  logger: OpenClawPluginServiceContext["logger"],
): Promise<void> {
  state.tools.length = 0;

  const connections = state.connections.splice(0, state.connections.length);
  for (const connection of connections) {
    try {
      await connection.close();
    } catch (error) {
      logger.warn(
        `mcp-bridge: failed to close "${connection.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export function createMcpBridgeState(): McpBridgeState {
  return {
    tools: [],
    connections: [],
  };
}

export function createMcpBridgeService(params: {
  state: McpBridgeState;
  pluginConfig: unknown;
}): OpenClawPluginService {
  return {
    id: "mcp-bridge",
    async start(ctx) {
      await closeConnections(params.state, ctx.logger);

      const resolved = resolveMcpBridgeConfig({
        pluginConfig: params.pluginConfig,
        legacyMcpServers: ctx.config.mcpServers,
      });
      if (!resolved.ok) {
        throw new Error(resolved.message);
      }

      const serverEntries = Object.entries(resolved.value.servers);
      if (serverEntries.length === 0) {
        ctx.logger.info("mcp-bridge: no servers configured");
        return;
      }

      for (const [name, serverConfig] of serverEntries) {
        if (!serverConfig.enabled) {
          ctx.logger.info(`mcp-bridge: skipping disabled server "${name}"`);
          continue;
        }

        try {
          ctx.logger.info(
            `mcp-bridge: connecting to "${name}" via ${serverConfig.transport} (${describeServerTarget(serverConfig)})`,
          );
          const connection = await connectMcpServer(name, serverConfig);
          const tools = await createMcpTools(connection);
          params.state.connections.push(connection);
          params.state.tools.push(...tools);
          ctx.logger.info(`mcp-bridge: "${name}" connected with ${tools.length} tools`);
        } catch (error) {
          ctx.logger.warn(
            `mcp-bridge: failed to connect to "${name}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      ctx.logger.info(`mcp-bridge: total ${params.state.tools.length} tools registered`);
    },
    async stop(ctx) {
      await closeConnections(params.state, ctx.logger);
    },
  };
}
