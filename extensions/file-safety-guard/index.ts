import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

// Ported from hermes tools/file_operations.py — WRITE_DENIED_PATHS and WRITE_DENIED_PREFIXES.
// Exact paths that should never be overwritten by an AI agent.
const WRITE_DENIED_EXACT = new Set<string>(
  [
    // SSH credentials
    "~/.ssh/authorized_keys",
    "~/.ssh/id_rsa",
    "~/.ssh/id_ed25519",
    "~/.ssh/id_ecdsa",
    "~/.ssh/config",
    // Environment and secrets
    "~/.openclaw/.env",
    "~/.hermes/.env",
    "~/.env",
    // Shell configuration
    "~/.bashrc",
    "~/.zshrc",
    "~/.profile",
    "~/.bash_profile",
    "~/.zprofile",
    "~/.bash_logout",
    // Credential files
    "~/.netrc",
    "~/.pgpass",
    "~/.npmrc",
    "~/.pypirc",
    // System files
    "/etc/sudoers",
    "/etc/passwd",
    "/etc/shadow",
    "/etc/hosts",
    "/etc/crontab",
  ].map(expandHome),
);

// Path prefixes whose entire subtree is write-protected
const WRITE_DENIED_PREFIXES: string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.kube",
  "/etc/sudoers.d",
  "/etc/systemd",
  "~/.docker",
  "~/.azure",
  "~/.config/gh",
  "~/.config/gcloud",
  "~/.config/op", // 1Password CLI
  "~/.password-store",
  "~/.gnupg",
].map(expandHome);

// Device files that hang on read/write — from hermes file_tools.py
const BLOCKED_DEVICE_PATHS = new Set<string>([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
]);

// File write tool names across different agent frameworks
const FILE_WRITE_TOOLS = new Set<string>([
  "write_file",
  "create_file",
  "str_replace_based_edit_tool",
  "create",
  "edit",
  "patch",
  "apply_patch",
  "overwrite_file",
  "save_file",
]);

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

function isWriteDenied(rawPath: string): { denied: boolean; reason: string } {
  const expanded = expandHome(rawPath);
  let resolved: string;
  try {
    // Use realpathSync for existing paths so symlinks can't bypass the blocklist.
    // Fall back to resolve() for non-existent paths (files being created for the first time).
    if (existsSync(expanded)) {
      resolved = realpathSync(expanded);
    } else {
      // File doesn't exist yet — realpath the parent dir to catch symlinked ancestors.
      const parent = dirname(resolve(expanded));
      if (existsSync(parent)) {
        resolved = join(realpathSync(parent), basename(resolve(expanded)));
      } else {
        resolved = resolve(expanded);
      }
    }
  } catch {
    resolved = resolve(expanded);
  }

  // Device path check — blocks infinite reads/writes
  if (BLOCKED_DEVICE_PATHS.has(resolved)) {
    return { denied: true, reason: `device path "${resolved}" cannot be written` };
  }

  // Exact path denial
  if (WRITE_DENIED_EXACT.has(resolved)) {
    return {
      denied: true,
      reason: `path "${resolved}" is in the write-denied list (credential/config file)`,
    };
  }

  // Prefix denial
  for (const prefix of WRITE_DENIED_PREFIXES) {
    if (resolved.startsWith(prefix + "/") || resolved === prefix) {
      return {
        denied: true,
        reason: `path "${resolved}" is under protected directory "${prefix}"`,
      };
    }
  }

  return { denied: false, reason: "" };
}

type FileSafetyConfig = {
  enabled?: boolean;
  /** Additional exact paths to deny (expanded at startup) */
  additionalDeniedPaths?: string[];
  /** Additional path prefixes to deny */
  additionalDeniedPrefixes?: string[];
  /** Allow overriding the built-in list (use with caution) */
  allowBuiltinOverride?: boolean;
};

export default definePluginEntry({
  id: "file-safety-guard",
  name: "File Safety Guard",
  description:
    "Blocks AI agent writes to sensitive files: SSH credentials, shell configs (.bashrc/.zshrc), cloud credentials (.aws, .kube, .gnupg), system files (/etc/sudoers, /etc/passwd), and device paths. Ported from hermes tools/file_operations.py WRITE_DENIED_PATHS.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as FileSafetyConfig;
    if (cfg.enabled === false) {
      return;
    }

    // Extend the deny list with user-configured paths
    if (Array.isArray(cfg.additionalDeniedPaths)) {
      for (const p of cfg.additionalDeniedPaths) {
        WRITE_DENIED_EXACT.add(expandHome(p));
      }
    }
    if (Array.isArray(cfg.additionalDeniedPrefixes)) {
      for (const p of cfg.additionalDeniedPrefixes) {
        WRITE_DENIED_PREFIXES.push(expandHome(p));
      }
    }

    api.on("before_tool_call", (event, _ctx) => {
      const ev = event as { toolName?: string; params?: Record<string, unknown> };
      const toolName = ev.toolName ?? "";

      if (!FILE_WRITE_TOOLS.has(toolName)) {
        return undefined;
      }

      const params = ev.params ?? {};
      const rawPathVal =
        params["path"] ?? params["file_path"] ?? params["filename"] ?? params["target"] ?? "";
      const rawPath = typeof rawPathVal === "string" ? rawPathVal : JSON.stringify(rawPathVal);
      if (!rawPath) {
        return undefined;
      }

      const { denied, reason } = isWriteDenied(rawPath);
      if (!denied) {
        return undefined;
      }

      return {
        block: true,
        blockReason: `File Safety Guard: ${reason}. This path is protected to prevent accidental credential or configuration damage.`,
      };
    });
  },
});
