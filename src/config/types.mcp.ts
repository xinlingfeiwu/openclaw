export type McpServerEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  description?: string;
};
