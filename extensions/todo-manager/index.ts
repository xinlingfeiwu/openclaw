import { Type } from "@sinclair/typebox";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";

type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  createdAt: number;
  updatedAt: number;
};

type TodoStore = {
  items: TodoItem[];
  nextId: number;
};

type TodoManagerConfig = {
  enabled?: boolean;
  /** Inject pending/in_progress todos into the system prompt context. Default: true */
  injectIntoContext?: boolean;
};

// Per-session todo stores (session-scoped, survives compaction via context injection)
const sessionStores = new Map<string, TodoStore>();

function getStore(sessionId: string): TodoStore {
  let store = sessionStores.get(sessionId);
  if (!store) {
    store = { items: [], nextId: 1 };
    sessionStores.set(sessionId, store);
  }
  return store;
}

function formatTodosForContext(items: TodoItem[]): string {
  const active = items.filter((t) => t.status === "pending" || t.status === "in_progress");
  if (active.length === 0) {
    return "";
  }
  const lines = active.map((t) => {
    const icon = t.status === "in_progress" ? "▶" : "○";
    // Escape HTML entities to prevent prompt injection via todo content
    const safeContent = t.content.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
    );
    return `${icon} [${t.id}] ${safeContent}`;
  });
  return `<active_todos>\n${lines.join("\n")}\n</active_todos>`;
}

export default definePluginEntry({
  id: "todo-manager",
  name: "Todo Manager",
  description:
    "In-session structured task list. The agent uses the 'todo' tool to plan and track tasks. Active todos are re-injected after context compaction.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as TodoManagerConfig;
    if (cfg.enabled === false) {
      return;
    }

    const injectIntoContext = cfg.injectIntoContext !== false;

    // Register the 'todo' tool
    api.registerTool(
      {
        name: "todo",
        label: "Todo Manager",
        description:
          "Manage a structured in-session task list. Use this to plan complex multi-step tasks, track progress, and ensure nothing is forgotten — especially useful before and during long operations.",
        parameters: Type.Object({
          action: Type.Unsafe<"add" | "update" | "list" | "clear_done">({
            type: "string",
            enum: ["add", "update", "list", "clear_done"],
            description:
              "Action: add (create new todo), update (change status), list (show all), clear_done (remove completed/cancelled)",
          }),
          content: Type.Optional(
            Type.String({
              description: "Task description — required for 'add' action",
            }),
          ),
          id: Type.Optional(
            Type.String({
              description: "Todo ID — required for 'update' action",
            }),
          ),
          status: Type.Optional(
            Type.Unsafe<TodoStatus>({
              type: "string",
              enum: ["pending", "in_progress", "done", "cancelled"],
              description: "New status — required for 'update' action",
            }),
          ),
        }),
        async execute(toolCallId, params, _signal) {
          // Use the toolCallId prefix as a per-session key (stable across compaction)
          const sessionId = toolCallId.split("-").slice(0, 3).join("-") || "default";
          const p = params as {
            action: "add" | "update" | "list" | "clear_done";
            content?: string;
            id?: string;
            status?: TodoStatus;
          };

          const store = getStore(sessionId);

          if (p.action === "add") {
            if (!p.content?.trim()) {
              return {
                details: null as unknown,
                content: [
                  { type: "text" as const, text: "Error: content is required for 'add' action" },
                ],
              };
            }
            const item: TodoItem = {
              id: `t${store.nextId++}`,
              content: p.content.trim(),
              status: "pending",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            store.items.push(item);
            return {
              details: null as unknown,
              content: [
                { type: "text" as const, text: `Added todo [${item.id}]: ${item.content}` },
              ],
            };
          }

          if (p.action === "update") {
            if (!p.id || !p.status) {
              return {
                details: null as unknown,
                content: [
                  {
                    type: "text" as const,
                    text: "Error: id and status are required for 'update' action",
                  },
                ],
              };
            }
            const item = store.items.find((t) => t.id === p.id);
            if (!item) {
              return {
                details: null as unknown,
                content: [{ type: "text" as const, text: `Error: todo '${p.id}' not found` }],
              };
            }
            const oldStatus = item.status;
            item.status = p.status;
            item.updatedAt = Date.now();
            return {
              details: null as unknown,
              content: [
                {
                  type: "text" as const,
                  text: `Updated [${item.id}]: ${oldStatus} → ${item.status}: ${item.content}`,
                },
              ],
            };
          }

          if (p.action === "list") {
            if (store.items.length === 0) {
              return {
                details: null as unknown,
                content: [{ type: "text" as const, text: "No todos." }],
              };
            }
            const icons: Record<TodoStatus, string> = {
              pending: "○",
              in_progress: "▶",
              done: "✓",
              cancelled: "✗",
            };
            const lines = store.items.map(
              (t) => `${icons[t.status]} [${t.id}] ${t.content} (${t.status})`,
            );
            return {
              details: null as unknown,
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          }

          if (p.action === "clear_done") {
            const before = store.items.length;
            store.items = store.items.filter(
              (t) => t.status !== "done" && t.status !== "cancelled",
            );
            const removed = before - store.items.length;
            return {
              details: null as unknown,
              content: [
                { type: "text" as const, text: `Cleared ${removed} completed/cancelled todos.` },
              ],
            };
          }

          return {
            details: null as unknown,
            content: [{ type: "text" as const, text: `Unknown action: ${String(p.action)}` }],
          };
        },
      },
      { name: "todo" },
    );

    // Re-inject active todos into every turn's system context (survives compaction)
    if (injectIntoContext) {
      api.on("before_prompt_build", (_event, ctx) => {
        const sessionId = ctx.sessionId ?? ctx.agentId ?? "default";
        const store = sessionStores.get(sessionId);
        if (!store || store.items.length === 0) {
          return undefined;
        }
        const contextText = formatTodosForContext(store.items);
        if (!contextText) {
          return undefined;
        }
        return { appendSystemContext: contextText };
      });
    }
  },
});
