import fs from "node:fs";
import path from "node:path";
import type { BugFinding, FlowMap, ScanResult, ScanStats, UserFlow } from "./types.js";

/**
 * Generate a full markdown report from scan results.
 */
export function generateReport(result: ScanResult): string {
  const { flowMap, bugs, generatedTests, stats } = result;
  const lines: string[] = [];

  // ── Header ──
  lines.push(`# 🐛 BugScout Report — ${flowMap.baseUrl}`);
  lines.push("");
  lines.push(
    `> Generated ${new Date().toISOString()} · ${stats.pagesCrawled} pages · ${bugs.length} bugs · ${generatedTests.length} test flows`
  );
  if (stats.totalCost > 0) {
    lines.push(`> Total cost: $${stats.totalCost.toFixed(4)} · Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
  }
  lines.push("");

  // ── Summary ──
  lines.push("## 📊 Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| ------ | ----- |");
  lines.push(`| Target URL | ${flowMap.baseUrl} |`);
  lines.push(`| Pages crawled | ${stats.pagesCrawled} |`);
  lines.push(`| Bugs found | ${stats.bugsFound} |`);
  lines.push(`| Flows discovered | ${stats.flowsDiscovered} |`);
  lines.push(`| Tests generated | ${stats.testsGenerated} |`);
  lines.push(`| Duration | ${(stats.durationMs / 1000).toFixed(1)}s |`);
  if (stats.llmCalls.length > 0) {
    lines.push(`| LLM calls | ${stats.llmCalls.length} |`);
    lines.push(`| Total LLM cost | $${stats.totalCost.toFixed(4)} |`);
  }
  lines.push("");

  // ── Bug severity breakdown ──
  if (bugs.length > 0) {
    const bySeverity = groupBy(bugs, (b) => b.severity);
    lines.push("### Severity Breakdown");
    lines.push("");
    lines.push("| Severity | Count |");
    lines.push("| -------- | ----- |");
    for (const [sev, list] of Object.entries(bySeverity)) {
      const emoji =
        sev === "critical"
          ? "🔴"
          : sev === "high"
            ? "🟠"
            : sev === "medium"
              ? "🟡"
              : sev === "low"
                ? "🟢"
                : "ℹ️";
      lines.push(`| ${emoji} ${sev} | ${list.length} |`);
    }
    lines.push("");
  }

  // ── Flow map ──
  lines.push("## 🗺️ Site Map");
  lines.push("");
  lines.push(`Discovered **${flowMap.pages.size} pages** and **${flowMap.edges.length} links** between them.`);
  lines.push("");
  lines.push("| # | Page | Elements | Forms | Links |");
  lines.push("| - | ---- | -------- | ----- | ----- |");
  let i = 1;
  for (const [, page] of flowMap.pages) {
    const title = page.title.startsWith("[ERROR]") ? `⚠️ ${page.title}` : page.title || page.url;
    lines.push(
      `| ${i} | [${title}](${page.url}) | ${page.elements.length} | ${page.forms.length} | ${page.links.length} |`
    );
    i++;
  }
  lines.push("");

  // ── Discovered flows ──
  if (flowMap.flows.length > 0) {
    lines.push("## 🔄 Discovered User Flows");
    lines.push("");
    for (const flow of flowMap.flows) {
      lines.push(`### ${flow.name}`);
      lines.push("");
      for (let j = 0; j < flow.steps.length; j++) {
        const step = flow.steps[j];
        const actionEmoji =
          step.action === "navigate"
            ? "🧭"
            : step.action === "click"
              ? "👆"
              : step.action === "fill"
                ? "⌨️"
                : step.action === "submit"
                  ? "📤"
                  : "⏳";
        lines.push(`${j + 1}. ${actionEmoji} **${step.action}** — ${step.description}`);
      }
      if (flow.generatedSpec) {
        lines.push("");
        lines.push("<details>");
        lines.push("<summary>Generated Playwright spec</summary>");
        lines.push("");
        lines.push("```typescript");
        lines.push(flow.generatedSpec);
        lines.push("```");
        lines.push("</details>");
      }
      lines.push("");
    }
  }

  // ── Bug findings ──
  if (bugs.length > 0) {
    lines.push("## 🐞 Bug Findings");
    lines.push("");

    const sorted = [...bugs].sort(
      (a, b) => severityScore(b.severity) - severityScore(a.severity)
    );

    for (const bug of sorted) {
      const sevEmoji =
        bug.severity === "critical"
          ? "🔴"
          : bug.severity === "high"
            ? "🟠"
            : bug.severity === "medium"
              ? "🟡"
              : bug.severity === "low"
                ? "🟢"
                : "ℹ️";

      lines.push(`### ${sevEmoji} ${bug.id}: ${bug.title}`);
      lines.push("");
      lines.push(`- **Severity:** ${bug.severity}`);
      lines.push(`- **Category:** ${bug.category}`);
      lines.push(`- **URL:** ${bug.url}`);
      if (bug.location) lines.push(`- **Location:** \`${bug.location}\``);
      lines.push("");
      lines.push(bug.description);
      lines.push("");

      if (bug.evidence) {
        lines.push("<details>");
        lines.push("<summary>Evidence</summary>");
        lines.push("");
        lines.push("```");
        lines.push(bug.evidence);
        lines.push("```");
        lines.push("</details>");
        lines.push("");
      }

      if (bug.reproduction) {
        lines.push("**Reproduction steps:**");
        lines.push("");
        for (const step of bug.reproduction) {
          lines.push(`1. ${step}`);
        }
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    }
  } else {
    lines.push("## 🎉 No bugs detected!");
    lines.push("");
    lines.push(
      "BugScout didn't find any issues. This doesn't guarantee the site is bug-free — it means the automated detectors didn't catch anything. Run with `--agentic` for deeper exploration."
    );
    lines.push("");
  }

  // ── Generated tests ──
  if (generatedTests.length > 0) {
    lines.push("## 🧪 Generated Playwright Tests");
    lines.push("");
    for (const test of generatedTests) {
      lines.push(`### ${test.name}`);
      lines.push("");
      lines.push(`- **Status:** ${test.specPasses ? "✅ Passing" : "❌ Failing"}`);
      lines.push(`- **Steps:** ${test.steps.length}`);
      if (test.generatedSpec) {
        lines.push("");
        lines.push("<details>");
        lines.push("<summary>Test code</summary>");
        lines.push("");
        lines.push("```typescript");
        lines.push(test.generatedSpec);
        lines.push("```");
        lines.push("</details>");
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push(`*Report generated by [BugScout](https://github.com/mhmdtaha091/bugscout) v0.1.0*`);

  return lines.join("\n");
}

/**
 * Save the report and return the file path.
 */
export function saveReport(result: ScanResult, outputDir: string): string {
  const reportPath = path.join(outputDir, "report.md");
  const markdown = generateReport(result);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  if (!fs.existsSync(path.join(outputDir, "screenshots"))) {
    fs.mkdirSync(path.join(outputDir, "screenshots"), { recursive: true });
  }

  fs.writeFileSync(reportPath, markdown, "utf-8");
  return reportPath;
}

/**
 * Generate a compact summary for stdout.
 */
export function consoleSummary(result: ScanResult): string {
  const { stats, bugs } = result;
  const lines: string[] = [];
  lines.push("");
  lines.push("╔══════════════════════════════════════╗");
  lines.push("║       🐛 BugScout Scan Complete      ║");
  lines.push("╠══════════════════════════════════════╣");
  lines.push(`║  Pages crawled:   ${String(stats.pagesCrawled).padEnd(19)}║`);
  lines.push(`║  Bugs found:      ${String(stats.bugsFound).padEnd(19)}║`);
  lines.push(`║  Flows discovered: ${String(stats.flowsDiscovered).padEnd(18)}║`);
  lines.push(`║  Tests generated: ${String(stats.testsGenerated).padEnd(18)}║`);
  lines.push(`║  Duration:        ${(stats.durationMs / 1000).toFixed(1).padEnd(18)}s║`);
  if (stats.totalCost > 0) {
    lines.push(`║  Cost:            $${stats.totalCost.toFixed(4).padEnd(17)}║`);
  }
  lines.push("╠══════════════════════════════════════╣");

  const crit = bugs.filter((b) => b.severity === "critical").length;
  const high = bugs.filter((b) => b.severity === "high").length;
  const med = bugs.filter((b) => b.severity === "medium").length;
  const low = bugs.filter((b) => b.severity === "low").length;

  if (crit > 0) lines.push(`║  🔴 Critical: ${String(crit).padEnd(18)}║`);
  if (high > 0) lines.push(`║  🟠 High:     ${String(high).padEnd(18)}║`);
  if (med > 0) lines.push(`║  🟡 Medium:   ${String(med).padEnd(18)}║`);
  if (low > 0) lines.push(`║  🟢 Low:      ${String(low).padEnd(18)}║`);

  lines.push("╚══════════════════════════════════════╝");
  lines.push("");
  lines.push(`📄 Full report: ${result.reportPath}`);
  lines.push("");

  return lines.join("\n");
}

// ─── Helpers ───

function severityScore(s: string): number {
  const map: Record<string, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  return map[s] ?? 0;
}

function groupBy<T>(items: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = fn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}
