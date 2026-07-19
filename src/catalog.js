// Tool catalog — the in-memory registry populated by the tool.definition hook.
// Each tool the LLM would normally see passes through this catalog first;
// entries flagged as "hidden" get a stub description sent to the model,
// while their full definition stays retrievable via the tool_search tool.

/**
 * @typedef {Object} CatalogEntry
 * @property {string} id            Tool id (e.g. "bash", "mcp__github_list_issues").
 * @property {string} description   Full description (as originally provided).
 * @property {any}    parameters    Parameter schema (JSON schema-like).
 * @property {string[]} tags        User-provided tags from catalog.json (may be empty).
 * @property {boolean} hidden       Whether this tool is currently collapsed in the prompt.
 * @property {boolean} activated    Whether this session has "unlocked" the tool.
 */

const STUB = (id) =>
  `[hidden — call tool_search("${id.replace(/[_.]+/g, " ")}") or a related keyword to reveal the full description and parameters]`;

export class Catalog {
  constructor({ hidePatterns = [], keepPatterns = [], userEntries = {} } = {}) {
    /** @type {Map<string, CatalogEntry>} */
    this.entries = new Map();
    this.hidePatterns = hidePatterns.map(compilePattern);
    this.keepPatterns = keepPatterns.map(compilePattern);
    this.userEntries = userEntries; // { toolId: { tags: [...], description?: "..." } }
    this.activated = new Set(); // per-session; caller owns lifecycle
    // Never hide our own search tool, or the model can't find anything.
    this.keepPatterns.unshift(compilePattern("tool_search"));
  }

  /**
   * Ingest / refresh a tool's canonical definition.
   * Called from the tool.definition hook on every request.
   *
   * @returns {CatalogEntry}
   */
  upsert(id, description, parameters) {
    const existing = this.entries.get(id);
    const userMeta = this.userEntries[id] || {};
    const finalDesc = userMeta.description || description || "";
    const tags = userMeta.tags || [];
    const hidden = this.shouldHide(id);
    const activated = existing?.activated || this.activated.has(id);
    const entry = {
      id,
      description: finalDesc,
      parameters,
      tags,
      hidden,
      activated,
    };
    this.entries.set(id, entry);
    return entry;
  }

  shouldHide(id) {
    // keep list wins over hide list.
    if (this.keepPatterns.some((re) => re.test(id))) return false;
    if (this.hidePatterns.some((re) => re.test(id))) return true;
    return false;
  }

  /** Mark a tool as activated for this session (full description restored). */
  activate(id) {
    this.activated.add(id);
    const e = this.entries.get(id);
    if (e) e.activated = true;
  }

  isActivated(id) {
    return this.activated.has(id);
  }

  /**
   * Whether the LLM should see the STUB description for this tool at this moment.
   */
  isCollapsed(id) {
    const e = this.entries.get(id);
    if (!e) return false;
    if (!e.hidden) return false;
    if (e.activated) return false;
    return true;
  }

  /**
   * The description string to actually send to the LLM.
   * If collapsed, we return a short stub; otherwise the real thing.
   */
  effectiveDescription(id) {
    const e = this.entries.get(id);
    if (!e) return null;
    if (this.isCollapsed(id)) return STUB(id);
    return e.description;
  }

  list() {
    return Array.from(this.entries.values());
  }

  get(id) {
    return this.entries.get(id) || null;
  }
}

/**
 * Compile a wildcard-ish pattern into a RegExp.
 * Supports "*" (any-run) and "?" (single char); anything else is literal.
 * Prefix "re:" to pass a raw regex.
 *
 * Malformed patterns (bad regex source, wrong type) must never crash plugin
 * init — we swallow the error, warn once, and return a never-match regex so
 * the rest of the rule set still applies.
 */
function compilePattern(p) {
  if (typeof p !== "string" || p.length === 0) return /^$/;
  try {
    if (p.startsWith("re:")) return new RegExp(p.slice(3));
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[opencode-tool-search] invalid pattern ${JSON.stringify(p)}: ${err.message}`,
    );
    return /(?!)/; // matches nothing
  }
}
