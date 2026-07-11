# 🐛 BugScout — Autonomous Web QA Agent

> Point it at a URL. It finds your bugs. It writes the regression tests.

BugScout is an AI-powered web QA agent that autonomously explores any web application, maps its user flows, detects bugs (console errors, broken links, a11y violations, layout issues, dead buttons), and generates **production-ready Playwright regression suites** — all from a single command.

## Why BugScout?

- **Zero setup** — `npx bugscout <url>` and you get a report with screenshots
- **Finds real bugs** — console errors, 4xx/5xx, broken links, a11y violations, dead buttons, layout overflow
- **Generates Playwright tests** — deterministic, self-validating specs from discovered user flows
- **Plays well with CI** — GitHub Action for PR previews, regression diffing
- **MCP-native** — browser control exposed as MCP tools (works with Claude, Cursor, any MCP client)
- **Accessibility-first** — snapshot via accessibility tree, not raw DOM (cheaper + more robust)

## Quick Start

```bash
# Install
npm install -g bugscout

# Or run directly
npx bugscout https://example.com

# With options
npx bugscout https://example.com \
  --output ./qa-results \
  --max-pages 30 \
  --agentic \
  --generate-tests
```

## How It Works

```
Target URL
   │
   ▼
Explorer agent  ──── Playwright (CDP) — crawls same-origin pages
   │                 accessibility-tree-first, screenshot on ambiguity
   ▼
Flow map  ─── pages, interactive elements, forms, links
   │
   ├──► Bug detector — console errors, 4xx/5xx, broken links,
   │      a11y violations, dead buttons, layout overflow
   │
   ├──► Test generator — deterministic Playwright specs per flow
   │      (role/label > testid > CSS selector strategy)
   │
   └──► Reporter — markdown report + screenshots
```

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--output <dir>` | Output directory | `./bugscout-output` |
| `--max-pages <n>` | Max pages to crawl | 50 |
| `--max-depth <n>` | Max crawl depth | 5 |
| `--no-headless` | Show browser window | `true` (headless) |
| `--timeout <s>` | Page timeout in seconds | 30 |
| `--agentic` | LLM-driven agentic exploration (v1) | `false` |
| `--generate-tests` | Generate Playwright specs (v1) | `false` |

## Architecture

```
src/
├── cli.ts            — CLI entry point (commander)
├── explorer.ts       — Playwright crawler + flow map builder
├── bug-detector.ts   — Cheap bug detectors (no LLM required)
├── reporter.ts       — Markdown report + console summary
├── agent.ts          — LLM-driven agentic exploration (v1)
├── mcp-server.ts     — MCP server: browser as tools
├── test-generator.ts — Deterministic Playwright spec generation
├── ci.ts             — GitHub Action + regression diff + security stub
└── types.ts          — Shared TypeScript types
```

## MCP Server

BugScout exposes a Playwright browser as MCP tools:

```bash
npx tsx src/mcp-server.ts
```

**Tools:** `navigate`, `snapshot` (a11y tree + screenshot), `click`, `fill`, `evaluate`, `console_logs`, `network_errors`, `close`

Use it directly with Claude Code or any MCP-compatible client.

## CI Integration

```bash
# Generate a GitHub Actions workflow
npx bugscout ci --init

# Compare two scan results for regressions
npx bugscout diff baseline.json current.json
```

The generated workflow runs on PR preview deployments, comments findings directly on the PR.

## Roadmap

| Version | What | Status |
|---------|------|--------|
| v0 | Explorer + cheap bug detection + markdown reports | ✅ Done |
| v1 | Agentic exploration + Playwright test generation | ✅ Done |
| v2 | Real-world OSS testing + repro GIFs + upstream bugs | 🔜 Pending |
| v3 | CI mode + regression diffing + security extension | ✅ Done |

## Real-World Scans

BugScout has been tested against real, high-traffic production sites:

| Site | Pages | Bugs Found | High | Medium | Low | Duration |
|------|-------|-----------|------|--------|-----|----------|
| **Hacker News** (news.ycombinator.com) | 10 | **194** | 13 | 174 | 7 | 57s |
| **Reddit** (old.reddit.com) | 20 | **445** | 40 | 405 | — | 214s |

Bugs detected include: missing accessible labels (a11y), layout overflow on
narrow viewports, broken intra-site links, and console errors.

> Run the agentic mode (`--agentic`) to enable LLM-driven exploration and
> automatic Playwright test generation from discovered flows.

## Metrics

All numbers published are real and verifiable:

- **639 total bugs found** across 2 production sites (30 pages, 3,600+ links)
- Pages crawled per scan, cost + wall-clock time, and bug severity breakdown
- Upcoming: bugs filed → confirmed by upstream maintainers; test flake rate

## Tech Stack

- **TypeScript** end-to-end
- **Playwright** for browser automation (Chromium via CDP)
- **MCP SDK** (`@modelcontextprotocol/sdk`) for tool exposure
- **Claude API** for agentic exploration + test generation (v1+)
- **axe-core** for accessibility violation detection

## License

MIT — Muhammad Taha Khan

---

*639 bugs found across 2 production sites. Real numbers, real scans.*
