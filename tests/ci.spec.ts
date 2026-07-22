/**
 * Unit tests for CI helpers: scan diffing (regression detection),
 * workflow generation, and PR comment formatting.
 */
import { test, expect } from "@playwright/test";
import {
  diffScans,
  generateGithubActionWorkflow,
  prCommentSummary,
  securityFuzzStub,
} from "../src/ci.js";
import { makeBug, makeResult, makeStats } from "./helpers.js";

// ─── diffScans ───

test.describe("diffScans", () => {
  const bugA = makeBug({ id: "BUG-A", severity: "medium", title: "Old medium bug" });
  const bugB = makeBug({ id: "BUG-B", severity: "low", title: "Persistent low bug" });
  const bugC = makeBug({ id: "BUG-C", severity: "critical", title: "New critical bug" });
  const bugD = makeBug({ id: "BUG-D", severity: "medium", title: "New medium bug" });

  const baseline = makeResult({
    bugs: [bugA, bugB],
    stats: makeStats({ pagesCrawled: 3, bugsFound: 2 }),
  });
  const current = makeResult({
    bugs: [bugB, bugC, bugD],
    stats: makeStats({ pagesCrawled: 5, bugsFound: 3 }),
  });

  test("splits findings into new, fixed, and regression buckets by ID", () => {
    const diff = diffScans(current, baseline);
    expect(diff.newBugs.map((b) => b.id)).toEqual(["BUG-C", "BUG-D"]);
    expect(diff.fixedBugs.map((b) => b.id)).toEqual(["BUG-A"]);
    // Only critical/high new findings count as regressions.
    expect(diff.regressions.map((b) => b.id)).toEqual(["BUG-C"]);
  });

  test("renders a markdown summary with signed deltas", () => {
    const { summary } = diffScans(current, baseline);
    expect(summary).toContain("## 🐛 BugScout CI — Scan Diff");
    expect(summary).toContain("| Pages | 3 | 5 | +2 |");
    expect(summary).toContain("| Bugs | 2 | 3 | +1 |");
    expect(summary).toContain("| New bugs | — | 2 | — |");
    expect(summary).toContain("| Fixed bugs | — | 1 | — |");
    expect(summary).toContain("| Regressions | — | 1 | — |");
  });

  test("negative and zero deltas are rendered without a plus sign", () => {
    const shrunk = makeResult({
      bugs: [bugA, bugB],
      stats: makeStats({ pagesCrawled: 2, bugsFound: 2 }),
    });
    const { summary } = diffScans(shrunk, baseline);
    expect(summary).toContain("| Pages | 3 | 2 | -1 |");
    expect(summary).toContain("| Bugs | 2 | 2 | 0 |");
  });

  test("identical scans produce no new, fixed, or regressed findings", () => {
    const diff = diffScans(baseline, baseline);
    expect(diff.newBugs).toEqual([]);
    expect(diff.fixedBugs).toEqual([]);
    expect(diff.regressions).toEqual([]);
  });
});

// ─── generateGithubActionWorkflow ───

test.describe("generateGithubActionWorkflow", () => {
  test("is deterministic", () => {
    expect(generateGithubActionWorkflow()).toBe(generateGithubActionWorkflow());
  });

  test("emits a complete workflow with the expected steps", () => {
    const yaml = generateGithubActionWorkflow();
    expect(yaml).toContain("name: BugScout QA Scan");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("runs-on: ubuntu-latest");
    expect(yaml).toContain("uses: actions/checkout@v4");
    expect(yaml).toContain("run: npm ci");
    expect(yaml).toContain("run: npx playwright install chromium --with-deps");
    expect(yaml).toContain("uses: actions/upload-artifact@v4");
    expect(yaml.endsWith("\n")).toBe(true);
  });
});

// ─── prCommentSummary ───

test.describe("prCommentSummary", () => {
  test("celebrates a clean scan", () => {
    const md = prCommentSummary(
      makeResult({ stats: makeStats({ pagesCrawled: 3, bugsFound: 0 }) })
    );
    expect(md).toContain("## 🐛 BugScout Scan Results");
    expect(md).toContain("Scanned **3 pages**");
    expect(md).toContain("✅ No bugs detected!");
    expect(md).not.toContain("### 🔴 Critical");
  });

  test("lists critical and high findings and counts medium ones", () => {
    const result = makeResult({
      bugs: [
        makeBug({ severity: "critical", title: "Crashes on load", url: "https://s.io/a" }),
        makeBug({ severity: "high", title: "Console error on submit" }),
        makeBug({ severity: "medium", title: "m1" }),
        makeBug({ severity: "medium", title: "m2" }),
      ],
    });
    const md = prCommentSummary(result);
    expect(md).toContain("- Crashes on load (https://s.io/a)");
    expect(md).toContain("- Console error on submit");
    expect(md).toContain("*+2 medium-severity issues — see full report for details.*");
  });

  test("prints None under empty severity sections", () => {
    const md = prCommentSummary(
      makeResult({ bugs: [makeBug({ severity: "high", title: "Only high" })] })
    );
    const criticalSection = md.slice(md.indexOf("### 🔴 Critical"), md.indexOf("### 🟠 High"));
    expect(criticalSection).toContain("- None");
  });

  test("links the CI run when CI_RUN_URL is set, and falls back to # otherwise", () => {
    const withBugs = makeResult({ bugs: [makeBug({})] });

    const original = process.env["CI_RUN_URL"];
    try {
      delete process.env["CI_RUN_URL"];
      expect(prCommentSummary(withBugs)).toContain("[CI run artifacts](#)");

      process.env["CI_RUN_URL"] = "https://ci.example/run/42";
      expect(prCommentSummary(withBugs)).toContain(
        "[CI run artifacts](https://ci.example/run/42)"
      );
    } finally {
      if (original === undefined) delete process.env["CI_RUN_URL"];
      else process.env["CI_RUN_URL"] = original;
    }
  });
});

// ─── securityFuzzStub ───

test("securityFuzzStub returns only the info-level placeholder finding", async () => {
  // Silence the stub's console warnings to keep test output clean.
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const findings = await securityFuzzStub(
      "https://authorized.example",
      {
        loginUrl: "https://authorized.example/login",
        credentials: { user: "placeholder", pass: "placeholder" },
        submitSelector: "#submit",
        successIndicator: ".dashboard",
      },
      ["flow-1", "flow-2"]
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("BUG-SEC-STUB");
    expect(findings[0].severity).toBe("info");
    expect(findings[0].title).toBe("Security fuzzing not yet executed");
    expect(findings[0].url).toBe("https://authorized.example");
  } finally {
    console.warn = originalWarn;
  }
});
