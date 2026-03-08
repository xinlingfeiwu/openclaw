import type { OpenClawConfig, OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import type { McpBridgeConfig, McpServerConfig, ResolvedMcpServerConfig } from "./types.js";

const MCP_TRANSPORTS = ["http", "stdio"] as const;

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown, label: string): ParseResult<string | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: `${label} must be a non-empty string` };
  }
  return { ok: true, value: value.trim() };
}

function normalizeStringArray(value: unknown, label: string): ParseResult<string[] | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: `${label} must be an array of strings` };
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return { ok: false, message: `${label} must contain only non-empty strings` };
    }
    normalized.push(entry.trim());
  }
  return { ok: true, value: normalized };
}

function normalizeStringRecord(
  value: unknown,
  label: string,
): ParseResult<Record<string, string> | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: `${label} must be an object with string values` };
  }
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      return { ok: false, message: `${label}.${key} must be a string` };
    }
    normalized[key] = rawValue;
  }
  return { ok: true, value: normalized };
}

function normalizeTransport(
  name: string,
  value: unknown,
  command: string | undefined,
  url: string | undefined,
): ParseResult<ResolvedMcpServerConfig["transport"]> {
  if (value !== undefined) {
    if (value !== "http" && value !== "stdio") {
      return {
        ok: false,
        message: `servers.${name}.transport must be one of: ${MCP_TRANSPORTS.join(", ")}`,
      };
    }
    return { ok: true, value };
  }

  if (command && !url) {
    return { ok: true, value: "stdio" };
  }
  if (url && !command) {
    return { ok: true, value: "http" };
  }
  if (command && url) {
    return {
      ok: false,
      message: `servers.${name}.transport is required when both url and command are provided`,
    };
  }
  return { ok: false, message: `servers.${name} must define either url or command` };
}

function normalizeServerConfig(name: string, value: unknown): ParseResult<ResolvedMcpServerConfig> {
  if (!isRecord(value)) {
    return { ok: false, message: `servers.${name} must be an object` };
  }

  const allowedKeys = new Set([
    "transport",
    "url",
    "command",
    "args",
    "env",
    "enabled",
    "description",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `servers.${name}.${key} is not supported` };
    }
  }

  const url = normalizeNonEmptyString(value.url, `servers.${name}.url`);
  if (!url.ok) {
    return url;
  }

  const command = normalizeNonEmptyString(value.command, `servers.${name}.command`);
  if (!command.ok) {
    return command;
  }

  const args = normalizeStringArray(value.args, `servers.${name}.args`);
  if (!args.ok) {
    return args;
  }

  const env = normalizeStringRecord(value.env, `servers.${name}.env`);
  if (!env.ok) {
    return env;
  }

  const description = normalizeNonEmptyString(value.description, `servers.${name}.description`);
  if (!description.ok) {
    return description;
  }

  let enabled = true;
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") {
      return { ok: false, message: `servers.${name}.enabled must be a boolean` };
    }
    enabled = value.enabled;
  }

  const transport = normalizeTransport(name, value.transport, command.value, url.value);
  if (!transport.ok) {
    return transport;
  }
  if (transport.value === "http" && !url.value) {
    return { ok: false, message: `servers.${name}.url is required for http transport` };
  }
  if (transport.value === "stdio" && !command.value) {
    return { ok: false, message: `servers.${name}.command is required for stdio transport` };
  }

  return {
    ok: true,
    value: {
      transport: transport.value,
      enabled,
      url: url.value,
      command: command.value,
      args: args.value,
      env: env.value,
      description: description.value,
    },
  };
}

function parsePluginConfig(value: unknown): ParseResult<McpBridgeConfig | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "expected config object" };
  }

  const allowedKeys = new Set(["servers"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown config key: ${key}` };
    }
  }

  const serversValue = value.servers;
  if (serversValue === undefined) {
    return { ok: true, value: {} };
  }
  if (!isRecord(serversValue)) {
    return { ok: false, message: "servers must be an object keyed by server name" };
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, rawServer] of Object.entries(serversValue)) {
    const parsed = normalizeServerConfig(name, rawServer);
    if (!parsed.ok) {
      return parsed;
    }
    servers[name] = parsed.value;
  }

  return { ok: true, value: { servers } };
}

function normalizeLegacyServers(
  value: OpenClawConfig["mcpServers"] | undefined,
): ParseResult<Record<string, ResolvedMcpServerConfig>> {
  if (!value) {
    return { ok: true, value: {} };
  }

  const normalized: Record<string, ResolvedMcpServerConfig> = {};
  for (const [name, rawServer] of Object.entries(value)) {
    const parsed = normalizeServerConfig(name, {
      ...rawServer,
      transport: "stdio",
      enabled: true,
    });
    if (!parsed.ok) {
      return parsed;
    }
    normalized[name] = parsed.value;
  }
  return { ok: true, value: normalized };
}

export function createMcpBridgePluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      const parsed = parsePluginConfig(value);
      if (parsed.ok) {
        return { success: true, data: parsed.value };
      }
      return {
        success: false,
        error: {
          issues: [{ path: [], message: parsed.message }],
        },
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        servers: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: {
              transport: {
                type: "string",
                enum: [...MCP_TRANSPORTS],
              },
              url: { type: "string" },
              command: { type: "string" },
              args: {
                type: "array",
                items: { type: "string" },
              },
              env: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              enabled: { type: "boolean" },
              description: { type: "string" },
            },
          },
        },
      },
    },
    uiHints: {
      servers: {
        label: "MCP Servers",
        help: "Configure MCP servers to connect. Legacy top-level mcpServers is also supported.",
      },
      "servers.*.transport": {
        label: "Transport",
      },
      "servers.*.url": {
        label: "HTTP URL",
      },
      "servers.*.command": {
        label: "Command",
      },
      "servers.*.args": {
        label: "Arguments",
      },
      "servers.*.env": {
        label: "Environment Variables",
        advanced: true,
      },
      "servers.*.enabled": {
        label: "Enabled",
      },
      "servers.*.description": {
        label: "Description",
        advanced: true,
      },
    },
  };
}

export function resolveMcpBridgeConfig(params: {
  pluginConfig: unknown;
  legacyMcpServers?: OpenClawConfig["mcpServers"];
}): ParseResult<{ servers: Record<string, ResolvedMcpServerConfig> }> {
  const parsedPluginConfig = parsePluginConfig(params.pluginConfig);
  if (!parsedPluginConfig.ok) {
    return parsedPluginConfig;
  }

  const parsedLegacyServers = normalizeLegacyServers(params.legacyMcpServers);
  if (!parsedLegacyServers.ok) {
    return parsedLegacyServers;
  }

  const pluginServers = parsedPluginConfig.value?.servers ?? {};
  const normalizedPluginServers: Record<string, ResolvedMcpServerConfig> = {};
  for (const [name, serverConfig] of Object.entries(pluginServers)) {
    normalizedPluginServers[name] = serverConfig as ResolvedMcpServerConfig;
  }

  return {
    ok: true,
    value: {
      servers: {
        ...parsedLegacyServers.value,
        ...normalizedPluginServers,
      },
    },
  };
}
