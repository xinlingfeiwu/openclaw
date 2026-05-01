const COMPANION_MEMORY_PLUGIN_IDS = new Set<string>(["memory-core"]);

export function isCompanionMemoryPluginId(id: string): boolean {
  return COMPANION_MEMORY_PLUGIN_IDS.has(id);
}
