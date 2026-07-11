#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import process from "node:process";
import { explore } from "./explorer.js";
import { detectBugs } from "./bug-detector.js";
import { saveReport, consoleSummary } from "./reporter.js";
import type { ScanResult, ScanStats, ExplorerConfig, BugFinding } from "./types.js";

const program = new Command();

program
  .name("bugscout")
  .description("🐛 Autonomous web QA agent — point it at a URL, it finds bugs")
  .version("0.1.0")
  .argument("<url>", "Target URL to scan")
  .option("-o, --output <dir>", "Output directory", "./bugscout-output")
  .option("--max-pages <n>", "Maximum pages to crawl", "50")
  .option("--max-depth <n>", "Maximum crawl depth", "5")
  .option("--no-headless", "Show browser window during scan")
  .option("--timeout <ms>", "Page timeout in seconds", "30")
  .option("--agentic", "Enable LLM-driven agentic exploration (v1)")
  .option("--generate-tests", "Generate Playwright test specs (requires --agentic)")
  .option("--provider <name>", "LLM provider: anthropic, openai, openai-compatible, gemini", "openai-compatible")
  .option("--model <name>", "LLM model (default: deepseek-chat)")
  .option("--base-url <url>", "API base URL for openai-compatible providers")
  .option("--api-key <key>", "API key (or set OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY)")
  .action(async (url: string, options) => {
    console.log(chalk.cyan(`\n🐛 BugScout v0.1.0 — Scanning ${url}\n`));

    const startTime = Date.now();

    // Validate URL
    const parsed = (() => {
      try { return new URL(url); } catch { return null; }
    })();
    if (!parsed) {
      console.error(chalk.red(`Invalid URL: ${url}`));
      process.exit(1);
    }
    const targetUrl = parsed.href;

    const maxPages = parseInt(options.maxPages, 10);
    const maxDepth = parseInt(options.maxDepth, 10);
    const pageTimeout = parseInt(options.timeout, 10) * 1000;
    const outputDir = options.output;
    const headless = options.headless !== false;

    const spinner = ora();

    // Phase 1: Explore
    spinner.start("Exploring site structure...");
    const explorerConfig: ExplorerConfig = {
      baseUrl: targetUrl,
      maxPages,
      maxDepth,
      sameOrigin: true,
      captureScreenshots: true,
      outputDir,
      pageTimeout,
      headless,
    };

    let flowMap;
    try {
      flowMap = await explore(explorerConfig);
      spinner.succeed(
        `Explored ${flowMap.pages.size} pages, found ${flowMap.edges.length} links, ${flowMap.flows.length} flows`
      );
    } catch (err) {
      spinner.fail(`Exploration failed: ${(err as Error).message}`);
      process.exit(1);
    }
    // TypeScript narrowing — flowMap is definitely assigned after the try/catch
    // because process.exit(1) terminates. But TS doesn't know that, so we assert.
    const siteMap = flowMap!;

    // Phase 2: Detect bugs
    spinner.start("Detecting bugs...");
    let bugs: BugFinding[];
    try {
      bugs = await detectBugs(siteMap, {
        baseUrl: targetUrl,
        outputDir,
        pageTimeout,
        headless,
      });
      spinner.succeed(`Found ${bugs.length} potential bugs`);
    } catch (err) {
      spinner.warn(`Bug detection partially failed: ${(err as Error).message}`);
      bugs = [];
    }

    // Phase 3: Generate report
    spinner.start("Generating report...");
    const durationMs = Date.now() - startTime;

    const stats: ScanStats = {
      pagesCrawled: siteMap.pages.size,
      bugsFound: bugs.length,
      flowsDiscovered: siteMap.flows.length,
      testsGenerated: 0,
      durationMs,
      llmCalls: [],
      totalCost: 0,
    };

    const result: ScanResult = {
      flowMap: siteMap,
      bugs,
      generatedTests: [],
      stats,
      reportPath: "",
    };

    result.reportPath = saveReport(result, outputDir);
    spinner.succeed("Report generated");

    // Phase 4: Agentic exploration (v1 — requires API key)
    if (options.agentic) {
      spinner.start("Agentic exploration (LLM-driven)...");
      try {
        const { explorePageAgentically, generateTestsFromFlows } = await import("./agent.js");
        const { chromium } = await import("playwright");

        // Set provider env vars from CLI flags
        if (options.provider) process.env["AGENT_PROVIDER"] = options.provider;
        if (options.model) process.env["AGENT_MODEL"] = options.model;
        if (options.baseUrl) process.env["AGENT_BASE_URL"] = options.baseUrl;

        const agentConfig = {
          provider: options.provider as any,
          model: options.model,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
        };

        // Launch a fresh browser for agentic exploration
        const browser = await chromium.launch({ headless: headless });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

        const { flows, calls } = await explorePageAgentically(page, context, agentConfig);
        stats.llmCalls = calls;
        stats.totalCost = calls.reduce((sum, c) => sum + (c.cost || 0), 0);

        // Add discovered flows to the site map
        if (flows.length > 0) {
          siteMap.flows.push(...flows);
          stats.flowsDiscovered += flows.length;
        }

        if (options.generateTests && flows.length > 0) {
          spinner.text = "Generating Playwright test specs...";
          const { flows: testFlows, calls: testCalls } = await generateTestsFromFlows(flows, agentConfig);
          stats.llmCalls.push(...testCalls);
          stats.totalCost += testCalls.reduce((sum, c) => sum + (c.cost || 0), 0);
          result.generatedTests = testFlows.filter((f) => f.generatedSpec);
          stats.testsGenerated = result.generatedTests.length;
        }

        await browser.close();
        spinner.succeed(
          `Agentic exploration complete — ${flows.length} flows discovered, ${stats.testsGenerated} tests generated, $${stats.totalCost.toFixed(4)} cost`
        );
      } catch (err) {
        spinner.warn(
          `Agentic mode skipped: ${(err as Error).message}\n  Hint: set --api-key or OPENAI_API_KEY env var. Use --provider for non-Anthropic (deepseek-chat is default, ~$0.14/M tokens).`
        );
      }
    }

    // Print summary
    console.log(consoleSummary(result));

    if (bugs.length === 0) {
      console.log(chalk.green("✅ No bugs found! The site looks clean.\n"));
      process.exit(0);
    }

    const critCount = bugs.filter((b) => b.severity === "critical").length;
    const highCount = bugs.filter((b) => b.severity === "high").length;

    if (critCount > 0) {
      console.log(
        chalk.red(`🔴 ${critCount} critical issue(s) found — review immediately.\n`)
      );
      process.exit(2);
    } else if (highCount > 0) {
      console.log(
        chalk.yellow(`🟠 ${highCount} high-severity issue(s) found.\n`)
      );
      process.exit(1);
    }

    process.exit(0);
  });

program.parse();
