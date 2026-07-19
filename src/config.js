// Config loader — reads plugin config from opencode's plugin-options mechanism
// AND a stand-alone JSON file at ~/.config/opencode/tool-search.json (optional).
//
// The stand-alone file is friendlier for large tag catalogs than jamming everything
// into opencode.json.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * @typedef {Object} ToolSearchConfig
 * @property {boolean}  enabled       Master switch (default true).
 * @property {string[]} hide          Wildcard patterns for tools to collapse (default ["mcp_*", "mcp__*"]).
 * @property {string[]} keep          Wildcard patterns to force-keep visible (default []).
 * @property {number}   topK          Search result count (default 5).
 * @property {number}   descriptionLimit  Chars per description before truncation (default 600).
 * @property {Record<string, {tags?: string[], description?: string}>} tools  Per-tool overrides.
 * @property {boolean}  injectSystemHint  Whether to inject a system-prompt hint (default true).
 */

/** @type {ToolSearchConfig} */
const DEFAULTS = {
  enabled: true,
  hide: ["mcp_*", "mcp__*"],
  keep: [],
  topK: 5,
  descriptionLimit: 600,
  tools: {},
  injectSystemHint: true,
};

/**
 * Merge plugin-passed options with the user's tool-search.json file.
 * @param {Record<string, unknown> | undefined} pluginOptions
 * @param {string} [configHome]  Override ~/.config/opencode for tests.
 * @returns {Promise<ToolSearchConfig>}
 */
export async function loadConfig(pluginOptions, configHome) {
  const merged = { ...DEFAULTS, ...(pluginOptions || {}) };
  const cfgDir = configHome || process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
  const cfgPath = join(cfgDir, "tool-search.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw);
    Object.assign(merged, parsed);
    // Merge tools separately so we don't clobber inline plugin overrides.
    if (parsed.tools) {
      merged.tools = { ...(pluginOptions?.tools || {}), ...parsed.tools };
    }
  } catch (err) {
    if (err && /** @type {any} */ (err).code !== "ENOENT") {
      // Corrupt config shouldn't kill the plugin; warn via console.
      console.warn(`[opencode-tool-search] failed to read ${cfgPath}: ${err.message}`);
    }
  }
  return merged;
}
