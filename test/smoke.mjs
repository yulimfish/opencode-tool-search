// Minimal smoke test — no framework; run with `node test/smoke.mjs`.
// Verifies the pure logic (catalog + match) without needing the opencode runtime.

import assert from "node:assert/strict";
import { Catalog } from "../src/catalog.js";
import { rankTools, scoreTool } from "../src/match.js";

// ---- match ----
{
  const t = { id: "github_list_issues", description: "List issues in a repo", tags: ["github", "issue"] };
  assert.ok(scoreTool(t, "github issue") > scoreTool(t, "database"));
  assert.ok(scoreTool(t, "issue") > 0);
  assert.equal(scoreTool(t, ""), 0);
}

// ---- rank ----
{
  const tools = [
    { id: "bash", description: "Run shell commands" },
    { id: "read", description: "Read a file" },
    { id: "mcp__github_list_issues", description: "List issues in a GitHub repo", tags: ["github"] },
    { id: "mcp__github_get_issue", description: "Get a GitHub issue", tags: ["github"] },
    { id: "mcp__slack_send", description: "Send a Slack message", tags: ["slack"] },
  ];
  const hits = rankTools(tools, "github issue", 5);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].tool.id.includes("github"));
}

// ---- catalog: hide/keep ----
{
  const c = new Catalog({ hidePatterns: ["mcp_*"], keepPatterns: [] });
  c.upsert("mcp_foo", "Foo tool", {});
  c.upsert("bash", "Run commands", {});
  assert.equal(c.isCollapsed("mcp_foo"), true);
  assert.equal(c.isCollapsed("bash"), false);
  assert.match(c.effectiveDescription("mcp_foo"), /hidden/);
  assert.equal(c.effectiveDescription("bash"), "Run commands");
}

// ---- catalog: activation restores description ----
{
  const c = new Catalog({ hidePatterns: ["mcp_*"] });
  c.upsert("mcp_foo", "Foo tool full description here.", { type: "object" });
  assert.match(c.effectiveDescription("mcp_foo"), /hidden/);
  c.activate("mcp_foo");
  assert.equal(c.effectiveDescription("mcp_foo"), "Foo tool full description here.");
}

// ---- catalog: keep list overrides hide ----
{
  const c = new Catalog({ hidePatterns: ["mcp_*"], keepPatterns: ["mcp_critical"] });
  c.upsert("mcp_critical", "Critical", {});
  c.upsert("mcp_noise", "Noise", {});
  assert.equal(c.isCollapsed("mcp_critical"), false);
  assert.equal(c.isCollapsed("mcp_noise"), true);
}

// ---- catalog: user-provided tags & description override ----
{
  const c = new Catalog({
    hidePatterns: ["mcp_*"],
    userEntries: {
      mcp_foo: { tags: ["custom", "important"], description: "OVERRIDE" },
    },
  });
  const e = c.upsert("mcp_foo", "original description", {});
  assert.deepEqual(e.tags, ["custom", "important"]);
  assert.equal(e.description, "OVERRIDE");
}

// ---- pattern semantics ----
{
  const c = new Catalog({ hidePatterns: ["figma_*", "yuque_yuque_*"] });
  c.upsert("figma_get_metadata", "d", {});
  c.upsert("yuque_yuque_get_doc", "d", {});
  c.upsert("bash", "d", {});
  assert.equal(c.isCollapsed("figma_get_metadata"), true);
  assert.equal(c.isCollapsed("yuque_yuque_get_doc"), true);
  assert.equal(c.isCollapsed("bash"), false);
}

// ---- tool_search always kept ----
{
  const c = new Catalog({ hidePatterns: ["*"] });
  c.upsert("tool_search", "the search tool", {});
  assert.equal(c.isCollapsed("tool_search"), false);
}

// ---- malformed patterns do not crash init and are isolated ----
{
  // Silence expected console.warn for this block.
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const c = new Catalog({
      hidePatterns: ["re:[[", "mcp_*", "re:(unclosed"],
    });
    c.upsert("mcp_foo", "d", {});
    c.upsert("bash", "d", {});
    // The valid mcp_* pattern still hides mcp_foo despite two broken siblings.
    assert.equal(c.isCollapsed("mcp_foo"), true);
    assert.equal(c.isCollapsed("bash"), false);
    // We warned about each malformed pattern.
    assert.ok(warnings.length >= 2, `expected >=2 warnings, got ${warnings.length}`);
  } finally {
    console.warn = origWarn;
  }
}

console.log("smoke: all tests passed");
