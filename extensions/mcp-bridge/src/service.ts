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

      const enabledEntries = serverEntries.filter(([name, serverConfig]) => {
        if (!serverConfig.enabled) {
          ctx.logger.info(`mcp-bridge: skipping disabled server "${name}"`);
          return false;
        }
        return true;
      });

      // Connect all servers in parallel to avoid serialized startup latency
      // (e.g. 14 servers × ~3 s each = 47 s serial → ~7 s parallel).
      const results = await Promise.allSettled(
        enabledEntries.map(async ([name, serverConfig]) => {
          ctx.logger.info(
            `mcp-bridge: connecting to "${name}" via ${serverConfig.transport} (${describeServerTarget(serverConfig)})`,
          );
          const connection = await connectMcpServer(name, serverConfig);
          const tools = await createMcpTools(connection);
          return { name, connection, tools };
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const [name] = enabledEntries[i];
        if (result.status === "fulfilled") {
          const { connection, tools } = result.value;
          params.state.connections.push(connection);
          params.state.tools.push(...tools);
          ctx.logger.info(`mcp-bridge: "${name}" connected with ${tools.length} tools`);
        } else {
          ctx.logger.warn(
            `mcp-bridge: failed to connect to "${name}": ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
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
