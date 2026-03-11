import { describe, expect, it } from "vitest";
import {
  buildCopilotModelDefinition,
  discoverCopilotModelIds,
  getDefaultCopilotModelIds,
} from "./github-copilot-models.js";

describe("github-copilot-models", () => {
  describe("getDefaultCopilotModelIds", () => {
    it("includes claude-sonnet-4.6", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.6");
    });

    it("includes claude-sonnet-4.5", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.5");
    });

    it("returns a mutable copy", () => {
      const a = getDefaultCopilotModelIds();
      const b = getDefaultCopilotModelIds();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("buildCopilotModelDefinition", () => {
    it("uses openai-completions for claude models (no Responses API support)", () => {
      expect(buildCopilotModelDefinition("claude-sonnet-4.6").api).toBe("openai-completions");
      expect(buildCopilotModelDefinition("claude-opus-4.5").api).toBe("openai-completions");
      expect(buildCopilotModelDefinition("claude-haiku-4.5").api).toBe("openai-completions");
    });

    it("uses openai-completions for gemini models (no Responses API support)", () => {
      expect(buildCopilotModelDefinition("gemini-3.1-pro-preview").api).toBe("openai-completions");
      expect(buildCopilotModelDefinition("gemini-2.5-pro").api).toBe("openai-completions");
    });

    it("uses openai-responses for gpt models", () => {
      expect(buildCopilotModelDefinition("gpt-5.4").api).toBe("openai-responses");
      expect(buildCopilotModelDefinition("gpt-4o").api).toBe("openai-responses");
      expect(buildCopilotModelDefinition("gpt-5.3-codex").api).toBe("openai-responses");
    });

    it("builds a valid definition for claude-sonnet-4.6", () => {
      const def = buildCopilotModelDefinition("claude-sonnet-4.6");
      expect(def.id).toBe("claude-sonnet-4.6");
      expect(def.api).toBe("openai-completions");
      expect(def.headers).toMatchObject({
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      });
    });

    it("trims whitespace from model id", () => {
      const def = buildCopilotModelDefinition("  gpt-4o  ");
      expect(def.id).toBe("gpt-4o");
    });

    it("throws on empty model id", () => {
      expect(() => buildCopilotModelDefinition("")).toThrow("Model id required");
      expect(() => buildCopilotModelDefinition("  ")).toThrow("Model id required");
    });
  });

  describe("discoverCopilotModelIds", () => {
    it("returns enabled picker models from the Copilot models API", async () => {
      const fetchMock = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "claude-sonnet-4.6", model_picker_enabled: true, policy: { state: "enabled" } },
              { id: "gpt-5.4", model_picker_enabled: true, policy: { state: "enabled" } },
            ],
          }),
        }) as Response;

      await expect(
        discoverCopilotModelIds({
          token: "copilot-token",
          baseUrl: "https://api.individual.githubcopilot.com",
          fetchImpl: fetchMock as typeof fetch,
        }),
      ).resolves.toEqual(["claude-sonnet-4.6", "gpt-5.4"]);
    });

    it("filters out hidden or disabled models", async () => {
      const fetchMock = async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "gpt-5.4", model_picker_enabled: true, policy: { state: "enabled" } },
              {
                id: "claude-sonnet-4.6",
                model_picker_enabled: false,
                policy: { state: "enabled" },
              },
              { id: "gemini-2.5-pro", model_picker_enabled: true, policy: { state: "disabled" } },
            ],
          }),
        }) as Response;

      await expect(
        discoverCopilotModelIds({
          token: "copilot-token",
          baseUrl: "https://api.individual.githubcopilot.com",
          fetchImpl: fetchMock as typeof fetch,
        }),
      ).resolves.toEqual(["gpt-5.4"]);
    });
  });
});
