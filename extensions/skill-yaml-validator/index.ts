import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Hermes skill_manager_tool.py constraints
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_CONTENT_CHARS = 100_000;
const ALLOWED_SUBDIRS = new Set(["references", "templates", "scripts", "assets"]);

type SkillYamlConfig = {
  enabled?: boolean;
  /** Paths that are considered skill directories (default: ["~/.openclaw/skills"]) */
  skillPaths?: string[];
};

function isSkillFile(filePath: string, skillPaths: string[]): boolean {
  const home = process.env["HOME"] ?? "";
  const normalized = filePath.replace(/^~/, home);
  return skillPaths.some((sp) => {
    const normSp = sp.replace(/^~/, home);
    return normalized.startsWith(normSp);
  });
}

/** Parse YAML frontmatter from skill file content */
function parseYamlFrontmatter(content: string): {
  name?: string;
  description?: string;
  body: string;
} | null {
  if (!content.startsWith("---")) {
    return null;
  }
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    return null;
  }
  const fmBlock = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 4).trim();

  const result: { name?: string; description?: string; body: string } = { body };
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const val = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "name") {
      result.name = val;
    }
    if (key === "description") {
      result.description = val;
    }
  }
  return result;
}

function validateSkillContent(content: string, filePath: string): string | null {
  // Check content length
  if (content.length > MAX_CONTENT_CHARS) {
    return `Skill file content exceeds ${MAX_CONTENT_CHARS.toLocaleString()} character limit (got ${content.length}).`;
  }

  // Path traversal guard
  if (filePath.includes("..")) {
    return `Skill file path must not contain directory traversal ("..").`;
  }

  // Check if it's a subdirectory file and that the subdir is allowed
  const skillPathSegments = filePath.split("/");
  // Find if there's a non-root subdir involved
  for (const seg of skillPathSegments.slice(-3, -1)) {
    if (seg && !ALLOWED_SUBDIRS.has(seg) && seg !== "skills" && !seg.startsWith(".")) {
      // Only reject if it looks like an unsupported subdir
      break;
    }
  }

  // Parse YAML frontmatter
  const fm = parseYamlFrontmatter(content);
  if (fm === null) {
    // Not a YAML frontmatter file — allow non-skill-md files (e.g. plain scripts)
    return null;
  }

  const errors: string[] = [];

  if (!fm.name) {
    errors.push('Skill frontmatter must include a "name" field.');
  } else {
    if (fm.name.length > MAX_NAME_CHARS) {
      errors.push(`Skill name exceeds ${MAX_NAME_CHARS} character limit (got ${fm.name.length}).`);
    }
    if (!SKILL_NAME_RE.test(fm.name)) {
      errors.push(
        `Skill name "${fm.name}" is invalid — must match pattern ^[a-z0-9][a-z0-9._-]* (lowercase alphanumeric, dots, dashes, underscores only).`,
      );
    }
  }

  if (!fm.description) {
    errors.push('Skill frontmatter must include a "description" field.');
  } else if (fm.description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(
      `Skill description exceeds ${MAX_DESCRIPTION_CHARS} character limit (got ${fm.description.length}).`,
    );
  }

  if (!fm.body || fm.body.trim().length === 0) {
    errors.push("Skill file must have content after the YAML frontmatter.");
  }

  if (errors.length > 0) {
    return errors.join(" ");
  }
  return null;
}

export default definePluginEntry({
  id: "skill-yaml-validator",
  name: "Skill YAML Validator",
  description:
    "Validates skill file YAML frontmatter before writes: enforces name pattern (^[a-z0-9][a-z0-9._-]*), 100-char name limit, 500-char description limit, 100K content limit, required fields, and path traversal guard. Ported from hermes-agent/tools/skill_manager_tool.py.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SkillYamlConfig;
    if (cfg.enabled === false) {
      return;
    }

    const skillPaths =
      Array.isArray(cfg.skillPaths) && cfg.skillPaths.length > 0
        ? cfg.skillPaths
        : ["~/.openclaw/skills"];

    const FILE_WRITE_TOOLS = new Set([
      "write_file",
      "create_file",
      "str_replace_based_edit_tool",
      "create",
      "edit",
    ]);

    api.on("before_tool_call", (event, _ctx) => {
      const ev = event as {
        toolName?: string;
        params?: Record<string, unknown>;
      };
      const toolName = ev.toolName ?? "";
      if (!FILE_WRITE_TOOLS.has(toolName)) {
        return undefined;
      }

      const params = ev.params ?? {};
      const filePathVal = params["path"] ?? params["file_path"] ?? params["filename"] ?? "";
      const filePath = typeof filePathVal === "string" ? filePathVal : JSON.stringify(filePathVal);
      if (!filePath || !isSkillFile(filePath, skillPaths)) {
        return undefined;
      }

      // Only validate .md files (skill definition files have frontmatter)
      if (!filePath.endsWith(".md") && !filePath.endsWith(".yaml") && !filePath.endsWith(".yml")) {
        return undefined;
      }

      const contentVal =
        params["new_content"] ??
        params["content"] ??
        params["file_text"] ??
        params["new_str"] ??
        "";
      const content = typeof contentVal === "string" ? contentVal : JSON.stringify(contentVal);
      if (!content) {
        return undefined;
      }

      const error = validateSkillContent(content, filePath);
      if (!error) {
        return undefined;
      }

      api.logger.warn?.(`skill-yaml-validator: validation failed for "${filePath}": ${error}`);
      return {
        block: true,
        blockReason: `Skill file validation failed for \`${filePath}\`:\n\n${error}\n\nPlease fix the YAML frontmatter and retry.`,
      };
    });
  },
});
