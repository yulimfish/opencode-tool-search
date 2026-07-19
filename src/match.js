// Simple substring + token scoring for tool search.
// Intentionally dependency-free: opencode plugin runtime is Bun/Node ESM, we don't
// want to pull fuse.js or similar into every session.

/**
 * Score a candidate tool against a query. Higher = better.
 * Bag-of-words scoring across name + description + tags.
 *
 * @param {{id:string, description:string, tags?:string[]}} tool
 * @param {string} query
 * @returns {number}
 */
export function scoreTool(tool, query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return 0;

  const name = (tool.id || "").toLowerCase();
  const desc = (tool.description || "").toLowerCase();
  const tags = (tool.tags || []).join(" ").toLowerCase();

  // Split query into tokens; drop very short ones except when the whole query is short.
  const tokens = q.split(/\s+/).filter((t) => q.length <= 3 || t.length >= 2);
  if (tokens.length === 0) return 0;

  let score = 0;
  let matched = false;
  for (const t of tokens) {
    // Exact id match = huge boost.
    if (name === t) { score += 100; matched = true; }
    // Prefix match on id.
    else if (name.startsWith(t)) { score += 40; matched = true; }
    // Any occurrence in id.
    else if (name.includes(t)) { score += 20; matched = true; }

    if (tags.includes(t)) { score += 15; matched = true; }
    if (desc.includes(t)) { score += 5; matched = true; }
  }

  if (!matched) return 0;
  // Small bonus for user-curated entries with tags, only when they actually matched.
  if (tool.tags && tool.tags.length > 0) score += 2;

  return score;
}

/**
 * Rank tools by query. Returns the top N with score > 0.
 *
 * @param {Array<{id:string, description:string, tags?:string[]}>} tools
 * @param {string} query
 * @param {number} topK
 */
export function rankTools(tools, query, topK = 5) {
  const scored = tools
    .map((t) => ({ tool: t, score: scoreTool(t, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
