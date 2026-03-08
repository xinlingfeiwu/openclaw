import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMcpBridgePluginConfigSchema } from "./src/config.js";
import { createMcpBridgeService, createMcpBridgeState } from "./src/service.js";

const mcpBridgePlugin = {
  id: "mcp-bridge",
  name: "MCP Bridge",
  description: "Connect MCP servers and expose their tools as native OpenClaw tools.",
  configSchema: createMcpBridgePluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const state = createMcpBridgeState();

    api.registerService(
      createMcpBridgeService({
        pluginConfig: api.pluginConfig,
        state,
      }),
    );

    api.registerTool(() => (state.tools.length > 0 ? state.tools : null));
  },
};

export default mcpBridgePlugin;
