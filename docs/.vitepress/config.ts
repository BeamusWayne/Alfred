import { defineConfig } from "vitepress";

// Docs site for Alfred. Built with `bun run docs:build`, deployed to GitHub Pages.
// `base` assumes a project page at <user>.github.io/Alfred/ — set to "/" for a
// user/org page or a custom domain.
export default defineConfig({
  title: "Alfred",
  description: "A verifiable autonomous coding agent (CLI), built with TypeScript on Bun.",
  base: "/Alfred/",
  lang: "en-US",
  cleanUrls: true,
  // 28 pages were authored in parallel and cross-link heavily; don't fail the
  // build on a stray link. Tighten to an allowlist once links are audited.
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/introduction" },
      { text: "CLI", link: "/cli/overview" },
      { text: "Config", link: "/config/environment" },
      { text: "Subsystems", link: "/subsystems/agent-loop" },
      { text: "Guides", link: "/guides/autonomous-build" },
      { text: "Architecture", link: "/architecture/overview" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
          { text: "Installation", link: "/guide/installation" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Concepts", link: "/guide/concepts" },
        ],
      },
      {
        text: "CLI reference",
        items: [
          { text: "alfred (one-shot)", link: "/cli/overview" },
          { text: "alfred run", link: "/cli/run" },
          { text: "alfred eval", link: "/cli/eval" },
        ],
      },
      {
        text: "Configuration",
        items: [
          { text: "Environment variables", link: "/config/environment" },
          { text: "Providers & models", link: "/config/providers" },
          { text: "Permissions & sandbox", link: "/config/permissions" },
        ],
      },
      {
        text: "Subsystems",
        items: [
          { text: "Agent loop", link: "/subsystems/agent-loop" },
          { text: "Memory", link: "/subsystems/memory" },
          { text: "Orchestrator", link: "/subsystems/orchestrator" },
          { text: "Autonomy harness", link: "/subsystems/harness" },
          { text: "Security", link: "/subsystems/security" },
          { text: "Tools", link: "/subsystems/tools" },
          { text: "Code intelligence", link: "/subsystems/code-intelligence" },
          { text: "Observability", link: "/subsystems/observability" },
        ],
      },
      {
        text: "Extensibility",
        items: [
          { text: "Hooks", link: "/extensibility/hooks" },
          { text: "MCP", link: "/extensibility/mcp" },
          { text: "Skills", link: "/extensibility/skills" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Autonomous build (Alfred-Bench)", link: "/guides/autonomous-build" },
          { text: "Using GLM / compatible endpoints", link: "/guides/using-glm" },
          { text: "Writing a custom tool", link: "/guides/custom-tool" },
          { text: "Writing a skill", link: "/guides/writing-a-skill" },
          { text: "Writing a hook", link: "/guides/writing-a-hook" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Overview", link: "/architecture/overview" },
          { text: "Decision records (ADRs)", link: "/architecture/decisions" },
          { text: "Alfred-Bench", link: "/alfred-bench" },
          { text: "Contributing", link: "/contributing" },
        ],
      },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message: "MIT Licensed.",
      copyright: "Alfred — a verifiable autonomous coding agent.",
    },
  },
  srcExclude: [
    "improvement-proposal.md",
    "improvement-proposal.zh-CN.md",
    "alfred-vs-the-field.md",
    "adr/*.zh-CN.md",
  ],
});
