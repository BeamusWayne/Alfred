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
  // Head hrefs are NOT base-prefixed by VitePress — keep "/Alfred/" explicit,
  // and og:image must be an absolute URL for scrapers.
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/Alfred/favicon.svg" }],
    ["link", { rel: "icon", type: "image/png", sizes: "32x32", href: "/Alfred/favicon-32.png" }],
    ["link", { rel: "apple-touch-icon", sizes: "180x180", href: "/Alfred/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#16161a" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:url", content: "https://beamuswayne.github.io/Alfred/" }],
    ["meta", { property: "og:title", content: "Alfred — a verifiable autonomous coding agent" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "“Done” is a machine-enforced verify gate, memory is agent-curated but inspectable, and every hands-off run leaves a signed, replayable ledger. TypeScript on Bun.",
      },
    ],
    ["meta", { property: "og:image", content: "https://beamuswayne.github.io/Alfred/og.png" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  themeConfig: {
    logo: "/favicon.svg",
    // Nav = four Diátaxis-shaped doors (tutorial / how-to / reference /
    // explanation). The old six-item nav had "Guide" AND "Guides" — a
    // four-letter distinction carrying real meaning nobody can see. Labels
    // only; every URL is unchanged.
    nav: [
      { text: "Get started", link: "/guide/introduction" },
      { text: "How-to", link: "/guides/autonomous-build" },
      { text: "Reference", link: "/cli/overview" },
      { text: "Internals", link: "/architecture/overview" },
    ],
    sidebar: [
      {
        text: "Get started",
        items: [
          { text: "Introduction", link: "/guide/introduction" },
          { text: "Installation", link: "/guide/installation" },
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Use cases", link: "/guide/use-cases" },
          { text: "Concepts", link: "/guide/concepts" },
        ],
      },
      {
        text: "How-to guides",
        items: [
          { text: "Autonomous build (Alfred-Bench)", link: "/guides/autonomous-build" },
          { text: "Using GLM / compatible endpoints", link: "/guides/using-glm" },
          { text: "Writing a custom tool", link: "/guides/custom-tool" },
          { text: "Writing a skill", link: "/guides/writing-a-skill" },
          { text: "Writing a hook", link: "/guides/writing-a-hook" },
        ],
      },
      {
        text: "CLI reference",
        items: [
          { text: "alfred (one-shot)", link: "/cli/overview" },
          { text: "alfred run", link: "/cli/run" },
          { text: "alfred watch", link: "/cli/watch" },
          { text: "alfred eval", link: "/cli/eval" },
          { text: "alfred ledger", link: "/cli/ledger" },
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
        text: "Extensibility",
        items: [
          { text: "Hooks", link: "/extensibility/hooks" },
          { text: "MCP", link: "/extensibility/mcp" },
          { text: "Skills", link: "/extensibility/skills" },
        ],
      },
      // Explanation-tier groups start collapsed (VitePress auto-expands the
      // one containing the active page) so the sidebar isn't a 28-link wall.
      {
        text: "Subsystems",
        collapsed: true,
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
        text: "Architecture",
        collapsed: true,
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
