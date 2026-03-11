import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  installModelsConfigTestHooks,
  mockCopilotTokenExchangeAndModels,
  mockCopilotTokenExchangeSuccess,
  withCopilotGithubToken,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks({ restoreFetch: true });

describe("models-config", () => {
  it("auto-injects github-copilot provider when token is present", async () => {
    await withTempHome(async (home) => {
      await withCopilotGithubToken("gh-token", async () => {
        mockCopilotTokenExchangeAndModels(["claude-sonnet-4.6", "gpt-5.4"]);
        const agentDir = path.join(home, "agent-default-base-url");
        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<
            string,
            {
              baseUrl?: string;
              models?: Array<{ id?: string; api?: string }>;
            }
          >;
        };
        const copilotProvider = parsed.providers["github-copilot"];
        const claude = copilotProvider?.models?.find((model) => model.id === "claude-sonnet-4.6");
        const gpt = copilotProvider?.models?.find((model) => model.id === "gpt-5.4");

        expect(copilotProvider?.baseUrl).toBe("https://api.copilot.example");
        expect(copilotProvider?.models?.length ?? 0).toBeGreaterThan(0);
        expect(claude?.api).toBe("openai-completions");
        expect(gpt?.api).toBe("openai-responses");
      });
    });
  });

  it("only injects copilot models returned by live discovery", async () => {
    await withTempHome(async (home) => {
      await withCopilotGithubToken("gh-token", async () => {
        mockCopilotTokenExchangeAndModels(["gpt-5.4"]);
        const agentDir = path.join(home, "agent-live-model-subset");
        await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { models?: Array<{ id?: string }> }>;
        };
        const modelIds = parsed.providers["github-copilot"]?.models?.map((model) => model.id) ?? [];

        expect(modelIds).toEqual(["gpt-5.4"]);
      });
    });
  });

  it("prefers COPILOT_GITHUB_TOKEN over GH_TOKEN and GITHUB_TOKEN", async () => {
    await withTempHome(async () => {
      await withEnvAsync(
        {
          COPILOT_GITHUB_TOKEN: "copilot-token",
          GH_TOKEN: "gh-token",
          GITHUB_TOKEN: "github-token",
        },
        async () => {
          const fetchMock = mockCopilotTokenExchangeSuccess();

          await ensureOpenClawModelsJson({ models: { providers: {} } });

          const [, opts] = fetchMock.mock.calls[0] as [
            string,
            { headers?: Record<string, string> },
          ];
          expect(opts?.headers?.Authorization).toBe("Bearer copilot-token");
        },
      );
    });
  });
});
