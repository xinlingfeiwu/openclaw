const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
const COPILOT_GITHUB_API_VERSION = "2025-04-01";

export function buildCopilotIdeHeaders(): Record<string, string> {
  return {
    "Editor-Version": COPILOT_EDITOR_VERSION,
    "User-Agent": COPILOT_USER_AGENT,
    "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION,
  };
}
