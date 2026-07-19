// opencode-tool-search — dynamic tool loading for opencode.
//
// Design: opencode's plugin runtime doesn't expose the raw request tools[] array
// to plugins, so we can't do the Kimi API's "top-level tools[] holds only search_tools"
// verbatim. But we CAN achieve the same effect (bounded token cost + focused
// attention) by using two hooks:
//
//   1. tool.definition  — for every tool the LLM would see, rewrite the description
//                         to a short stub if the tool matches our "hide" patterns
//                         and hasn't been activated this session yet.
//   2. tool (custom)    — register tool_search, which looks up tools by keyword,
//                         returns their real definitions to the LLM, and activates
//                         them (so subsequent turns get the full description).
//
// Everything else (chat.system.transform, tool.execute.after) is bookkeeping.

import { tool } from "@opencode-ai/plugin/tool";
import { Catalog } from "./catalog.js";
import { rankTools } from "./match.js";
import { loadConfig } from "./config.js";

const z = tool.schema;

/** @type {import("@opencode-ai/plugin").Plugin} */
export const ToolSearchPlugin = async ({ client }, pluginOptions) => {
  const cfg = await loadConfig(pluginOptions);
  if (!cfg.enabled) {
    return {}; // No-op plugin when disabled.
  }

  const catalog = new Catalog({
    hidePatterns: cfg.hide || [],
    keepPatterns: cfg.keep || [],
    userEntries: cfg.tools || {},
  });

  const log = async (level, message, extra) => {
    try {
      await client.app.log({
        body: { service: "tool-search", level, message, extra: extra || {} },
      });
    } catch {
      /* best-effort — plugin log isn't always available at startup */
    }
  };

  await log("info", "plugin initialized", {
    hide: cfg.hide,
    keep: cfg.keep,
    topK: cfg.topK,
  });

  return {
    /**
     * Rewrite the description sent to the LLM for hidden-and-not-yet-activated tools.
     */
    "tool.definition": async (input, output) => {
      const entry = catalog.upsert(input.toolID, output.description, output.parameters);
      if (catalog.isCollapsed(entry.id)) {
        output.description = catalog.effectiveDescription(entry.id) || output.description;
        // We deliberately do NOT prune parameters — the model needs the schema
        // in case it decides to call the tool anyway. Stripping params here would
        // break tool_choice / retries.
      }
    },

    /**
     * Auto-activate tools that actually get called — future turns get the full
     * description without needing tool_search again.
     */
    "tool.execute.after": async (input) => {
      if (input.tool && input.tool !== "tool_search") {
        catalog.activate(input.tool);
      }
    },

    /**
     * Inject a short hint into the system prompt so the model knows tool_search exists
     * and is the way to discover collapsed tools.
     */
    "experimental.chat.system.transform": async (_input, output) => {
      if (!cfg.injectSystemHint) return;
      const collapsed = catalog.list().filter((e) => catalog.isCollapsed(e.id));
      if (collapsed.length === 0) return;
      output.system.push(
        [
          "## Dynamic Tool Loading",
          "",
          `${collapsed.length} tool(s) currently have collapsed descriptions to reduce prompt bloat.`,
          "When you need functionality that isn't obviously covered by the visible tools,",
          "call `tool_search({ query: \"<keywords>\" })` first. The returned descriptions",
          "will remain visible for the rest of this session.",
          "",
          "You can also list all collapsed tools by calling `tool_search({ query: \"*\" })`.",
        ].join("\n"),
      );
    },

    tool: {
      tool_search: tool({
        description:
          "Search for available tools by keyword. Returns full descriptions and parameter schemas " +
          "for matching tools that have been collapsed to save prompt tokens. Once revealed, a tool " +
          "stays visible for the rest of this session. Use this whenever you're not sure which tool " +
          "to call — do not guess. Pass query=\"*\" to list every collapsed tool.",
        args: {
          query: z
            .string()
            .describe(
              "Keywords to match against tool names, tags, and descriptions. Examples: 'github issue', 'read file', 'database query', or '*' to list all collapsed tools.",
            ),
          top_k: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe("Max number of tools to return (default 5)."),
        },
        async execute(args) {
          const topK = args.top_k || cfg.topK || 5;
          const all = catalog.list();

          let hits;
          if (args.query.trim() === "*") {
            // List all currently-collapsed tools.
            hits = all
              .filter((t) => catalog.isCollapsed(t.id))
              .slice(0, topK)
              .map((tool) => ({ tool, score: 1 }));
          } else {
            hits = rankTools(all, args.query, topK);
          }

          if (hits.length === 0) {
            return {
              title: `tool_search: no matches for "${args.query}"`,
              output: `No tools matched "${args.query}". Visible tools already cover common cases; if you're stuck, ask the user.`,
              metadata: { query: args.query, count: 0 },
            };
          }

          const activatedNow = [];
          const lines = [];
          lines.push(`Found ${hits.length} tool(s) for "${args.query}":`);
          lines.push("");
          for (const { tool, score } of hits) {
            if (!catalog.isActivated(tool.id)) {
              catalog.activate(tool.id);
              activatedNow.push(tool.id);
            }
            lines.push(`### ${tool.id}  (score ${score})`);
            const desc = truncate(tool.description || "(no description)", cfg.descriptionLimit || 600);
            lines.push(desc);
            if (tool.tags && tool.tags.length > 0) {
              lines.push(`_tags: ${tool.tags.join(", ")}_`);
            }
            lines.push("");
            lines.push("Parameters:");
            lines.push("```json");
            lines.push(JSON.stringify(tool.parameters, null, 2));
            lines.push("```");
            lines.push("");
          }
          lines.push(
            "These tools are now callable directly. You do NOT need to call tool_search again for them this session.",
          );

          await log("info", "tool_search executed", {
            query: args.query,
            hits: hits.map((h) => h.tool.id),
            activatedNow,
          });

          return {
            title: `tool_search: ${hits.length} match(es) for "${args.query}"`,
            output: lines.join("\n"),
            metadata: {
              query: args.query,
              count: hits.length,
              tools: hits.map((h) => h.tool.id),
              activated: activatedNow,
            },
          };
        },
      }),
    },
  };
};

function truncate(str, limit) {
  if (!str) return "";
  if (str.length <= limit) return str;
  return str.slice(0, limit - 1).trimEnd() + "…";
}

// Named + default export so both `plugin: ["opencode-tool-search"]` (default)
// and `import { ToolSearchPlugin } from "opencode-tool-search"` work.
export default ToolSearchPlugin;
