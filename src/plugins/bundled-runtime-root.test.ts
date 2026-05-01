import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.doUnmock("./bundled-runtime-deps.js");
});

describe("prepareBundledPluginRuntimeRoot", () => {
  it("reuses the prepared mirror for repeated loads from the same built plugin root", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-runtime-root-"));
    tempDirs.push(tempRoot);

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "demo");
    fs.mkdirSync(path.join(pluginRoot, "nested"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "nested", "sidecar.js"),
      "export const sidecar = 1;\n",
      "utf8",
    );

    const installRoot = path.join(tempRoot, "state", "plugin-runtime-deps");
    const ensureBundledPluginRuntimeDeps = vi.fn(() => ({
      installedSpecs: [],
      retainSpecs: [],
    }));
    const registerBundledRuntimeDependencyNodePath = vi.fn();

    vi.doMock("./bundled-runtime-deps.js", async () => {
      const actual = await vi.importActual<typeof import("./bundled-runtime-deps.js")>(
        "./bundled-runtime-deps.js",
      );
      return {
        ...actual,
        ensureBundledPluginRuntimeDeps,
        resolveBundledRuntimeDependencyInstallRoot: vi.fn(() => installRoot),
        resolveBundledRuntimeDependencyPackageRoot: vi.fn(() => null),
        registerBundledRuntimeDependencyNodePath,
      };
    });

    const runtimeRoot = await importFreshModule<typeof import("./bundled-runtime-root.js")>(
      import.meta.url,
      "./bundled-runtime-root.js?scope=cache",
    );

    const first = runtimeRoot.prepareBundledPluginRuntimeRoot({
      pluginId: "demo",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
    });
    const second = runtimeRoot.prepareBundledPluginRuntimeRoot({
      pluginId: "demo",
      pluginRoot,
      modulePath: path.join(pluginRoot, "nested", "sidecar.js"),
    });

    expect(ensureBundledPluginRuntimeDeps).toHaveBeenCalledTimes(1);
    expect(registerBundledRuntimeDependencyNodePath).toHaveBeenCalledTimes(1);
    expect(first.pluginRoot).not.toBe(pluginRoot);
    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(first.modulePath).toBe(path.join(first.pluginRoot, "index.js"));
    expect(second.modulePath).toBe(path.join(first.pluginRoot, "nested", "sidecar.js"));
    expect(fs.existsSync(first.pluginRoot)).toBe(true);
  });
});
