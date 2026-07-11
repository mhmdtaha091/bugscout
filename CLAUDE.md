# CLAUDE.md — BugScout (web-qa-agent)

Autonomous web QA agent: point it at a URL → it explores, finds bugs, and
generates deterministic Playwright regression suites. TypeScript end-to-end.
Plan: `_docs/plans/WEBQA_AGENT_PLAN.md`. Repo: https://github.com/mhmdtaha091/bugscout

## Commands

```bash
npm install
npm run dev -- <url> [flags]   # tsx src/cli.ts — run without building
npm run build                  # tsc → dist/
npm run lint                   # tsc --noEmit
npm test                       # playwright test (tests/)
node dist/cli.js <url>         # built CLI (bin: bugscout)
npx tsx src/mcp-server.ts      # MCP server (browser-as-tools)
```

Key flags: `--output <dir>` `--max-pages <n>` `--agentic` `--generate-tests`
`--no-headless`.

## Architecture (src/)

- `cli.ts` — commander entry point.
- `explorer.ts` — Playwright crawler; builds the flow map (pages → elements →
  transitions). Accessibility-tree-first snapshots, screenshots on ambiguity.
- `bug-detector.ts` — no-LLM detectors: console errors, 4xx/5xx, broken links,
  axe-core a11y, dead buttons, layout overflow.
- `agent.ts` — LLM-driven agentic exploration (v1); Claude API, pluggable.
- `test-generator.ts` — emits Playwright specs. **Generated specs must be
  deterministic**: selector priority role/label > testid > CSS, explicit waits,
  never an LLM call inside a generated spec.
- `mcp-server.ts` — exposes browser as MCP tools (navigate, snapshot, click,
  fill, evaluate, console_logs, network_errors, close).
- `reporter.ts` / `ci.ts` — markdown report; GitHub Action init + regression diff.

## Rules

- Only scan targets you own or have authorization for; keep the responsible-use
  framing in README and docs (same rule as PentestAI).
- `dist/` is gitignored; ship via npm prepack, not git.
- Real-world proof (v2/v3 campaigns): only file upstream issues for confirmed,
  reproducible bugs — quality over count; numbers in README must be real.
