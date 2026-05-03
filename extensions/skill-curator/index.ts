import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

const AGENT_SKILL_MARKER = "created_by_agent: true";
const DEFAULT_STALE_DAYS = 30;
const DEFAULT_ARCHIVE_DAYS = 90;
const DEFAULT_INTERVAL_DAYS = 7;
const DEFAULT_SKILLS_DIR = "~/.openclaw/skills";
const STATE_FILE_NAME = ".curator_state.json";
const ARCHIVE_SUBDIR = ".archive";
const MAX_SHOWN_SKILLS = 80;

type CuratorConfig = {
  enabled?: boolean;
  intervalDays?: number;
  staleAfterDays?: number;
  archiveAfterDays?: number;
  skillsDir?: string;
};

type CuratorState = {
  lastRunAt: number;
  runCount: number;
  paused: boolean;
  pinnedSkills: string[];
};

type SkillInfo = {
  filename: string;
  title: string;
  daysOld: number;
  daysSinceModified: number;
  isAgentCreated: boolean;
  isPinned: boolean;
  lifecycle: "active" | "stale" | "archive_candidate";
};

function expandPath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function resolveSkillsDir(cfg: CuratorConfig): string {
  const raw = typeof cfg.skillsDir === "string" ? cfg.skillsDir : DEFAULT_SKILLS_DIR;
  return resolve(expandPath(raw));
}

function readCuratorState(stateFile: string): CuratorState {
  try {
    if (existsSync(stateFile)) {
      return JSON.parse(readFileSync(stateFile, "utf8")) as CuratorState;
    }
  } catch {
    // Fall through to defaults
  }
  return { lastRunAt: 0, runCount: 0, paused: false, pinnedSkills: [] };
}

function writeCuratorState(stateFile: string, state: CuratorState): void {
  try {
    mkdirSync(resolve(stateFile, ".."), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // fail-safe
  }
}

function extractTitle(content: string, filename: string): string {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith("# ")) {
    return firstLine.slice(2).trim();
  }
  return basename(filename, ".md");
}

function scanSkills(
  skillsDir: string,
  pinnedSkills: string[],
  staleDays: number,
  archiveDays: number,
): SkillInfo[] {
  if (!existsSync(skillsDir)) {
    return [];
  }
  let files: string[] = [];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
  } catch {
    return [];
  }

  const now = Date.now();
  const results: SkillInfo[] = [];

  for (const file of files) {
    const filePath = join(skillsDir, file);
    try {
      const stat = statSync(filePath);
      const content = readFileSync(filePath, "utf8");
      const isAgentCreated = content.includes(AGENT_SKILL_MARKER);
      const daysSinceModified = (now - stat.mtimeMs) / 86_400_000;
      const daysOld = (now - stat.birthtimeMs) / 86_400_000;
      const isPinned = pinnedSkills.includes(file) || pinnedSkills.includes(basename(file, ".md"));
      const title = extractTitle(content, file);

      let lifecycle: SkillInfo["lifecycle"] = "active";
      if (!isPinned && isAgentCreated) {
        if (daysSinceModified >= archiveDays) {
          lifecycle = "archive_candidate";
        } else if (daysSinceModified >= staleDays) {
          lifecycle = "stale";
        }
      }

      results.push({
        filename: file,
        title,
        daysOld,
        daysSinceModified,
        isAgentCreated,
        isPinned,
        lifecycle,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

function buildAuditPrompt(skillsDir: string, skills: SkillInfo[], archiveDays: number): string {
  const archiveCandidates = skills.filter((s) => s.lifecycle === "archive_candidate");
  const staleSkills = skills.filter((s) => s.lifecycle === "stale");
  const archiveDir = join(skillsDir, ARCHIVE_SUBDIR);

  const lines: string[] = [
    `[Skill Curator] Scheduled skill audit triggered. Please review the agent-managed skills in \`${skillsDir}\`.`,
    ``,
    `Skills are classified as:`,
    `  - **active**: modified within the last ${archiveDays / 3} days — keep as-is`,
    `  - **stale**: not modified recently — consider updating or consolidating`,
    `  - **archive candidate**: not modified in ${archiveDays}+ days — please move to \`${archiveDir}/\``,
  ];

  if (archiveCandidates.length > 0) {
    lines.push(``, `**Archive candidates** (move to \`${archiveDir}/\`):`);
    for (const s of archiveCandidates.slice(0, MAX_SHOWN_SKILLS)) {
      lines.push(
        `  - \`${s.filename}\` (${Math.floor(s.daysSinceModified)}d since last use): ${s.title}`,
      );
    }
  }

  if (staleSkills.length > 0) {
    lines.push(``, `**Stale skills** (review and update if still relevant):`);
    for (const s of staleSkills.slice(0, MAX_SHOWN_SKILLS)) {
      lines.push(
        `  - \`${s.filename}\` (${Math.floor(s.daysSinceModified)}d since last use): ${s.title}`,
      );
    }
  }

  if (archiveCandidates.length === 0 && staleSkills.length === 0) {
    lines.push(``, `All agent-created skills appear to be actively used. No action needed.`);
  } else {
    lines.push(
      ``,
      `To archive: \`mkdir -p ${archiveDir} && mv ${skillsDir}/<filename> ${archiveDir}/\``,
      `Skills are never auto-deleted — archive is fully reversible.`,
      `To pin a skill (exempt from curation), add its filename to \`pinnedSkills\` in \`${join(skillsDir, STATE_FILE_NAME)}\`.`,
    );
  }

  return lines.join("\n");
}

// Gateway-level flag: whether the curator needs to run this gateway session.
let curatorRunNeeded = false;
let curatorSkillsDirForRun = "";
let curatorConfigSnapshot: CuratorConfig = {};

export default definePluginEntry({
  id: "skill-curator",
  name: "Skill Curator",
  description:
    "Autonomous skill library lifecycle management: identifies stale/archive-candidate agent-created skills, injects audit guidance. Never auto-deletes. Ported from hermes-agent/agent/curator.py.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as CuratorConfig;
    if (cfg.enabled === false) {
      return;
    }

    const intervalDays =
      typeof cfg.intervalDays === "number" && cfg.intervalDays > 0
        ? cfg.intervalDays
        : DEFAULT_INTERVAL_DAYS;

    curatorConfigSnapshot = cfg;

    api.on("gateway_start", (_event, _ctx) => {
      const skillsDir = resolveSkillsDir(cfg);
      const stateFile = join(skillsDir, STATE_FILE_NAME);
      const state = readCuratorState(stateFile);

      if (state.paused) {
        return;
      }

      const now = Date.now();
      const daysSinceLast = (now - state.lastRunAt) / 86_400_000;

      if (state.lastRunAt === 0 || daysSinceLast >= intervalDays) {
        curatorRunNeeded = true;
        curatorSkillsDirForRun = skillsDir;
        api.logger.info?.(
          `skill-curator: audit due (last run: ${state.lastRunAt === 0 ? "never" : `${Math.floor(daysSinceLast)}d ago`})`,
        );
      }
    });

    api.on("before_prompt_build", (_event, _ctx) => {
      if (!curatorRunNeeded) {
        return undefined;
      }
      curatorRunNeeded = false;

      try {
        const skillsDir = curatorSkillsDirForRun;
        const stateFile = join(skillsDir, STATE_FILE_NAME);
        const state = readCuratorState(stateFile);

        const staleDays =
          typeof curatorConfigSnapshot.staleAfterDays === "number"
            ? curatorConfigSnapshot.staleAfterDays
            : DEFAULT_STALE_DAYS;
        const archiveDays =
          typeof curatorConfigSnapshot.archiveAfterDays === "number"
            ? curatorConfigSnapshot.archiveAfterDays
            : DEFAULT_ARCHIVE_DAYS;

        const skills = scanSkills(skillsDir, state.pinnedSkills, staleDays, archiveDays);
        const auditText = buildAuditPrompt(skillsDir, skills, archiveDays);

        // Update last run timestamp
        writeCuratorState(stateFile, {
          ...state,
          lastRunAt: Date.now(),
          runCount: state.runCount + 1,
        });

        return { appendContext: `\n\n${auditText}\n` };
      } catch (e) {
        api.logger.error?.(`skill-curator: failed to build audit prompt: ${String(e)}`);
        return undefined;
      }
    });

    // No per-session state cleanup needed — curator state is file-backed, not memory.
    api.on("agent_end", async (_event, _ctx) => {
      // Curator state is file-backed — no in-memory cleanup needed.
    });
  },
});
