import { chromium, Browser, Page, BrowserContext } from "playwright";
import type { BugFinding, FlowMap, PageNode } from "./types.js";

export interface DetectorConfig {
  baseUrl: string;
  outputDir: string;
  pageTimeout: number;
  headless: boolean;
}

/**
 * Run all cheap (non-LLM) detectors against every page in the flow map.
 * Returns deduplicated findings sorted by severity.
 */
export async function detectBugs(
  flowMap: FlowMap,
  config: DetectorConfig
): Promise<BugFinding[]> {
  const allFindings: BugFinding[] = [];
  const { headless, pageTimeout, outputDir, baseUrl } = config;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  try {
    for (const [, pageNode] of flowMap.pages) {
      if (pageNode.title.startsWith("[ERROR]")) continue;

      const findings = await checkPage(pageNode, context, {
        outputDir,
        pageTimeout,
        baseUrl,
      });
      allFindings.push(...findings);
    }
  } finally {
    await browser.close();
  }

  // Deduplicate by title+url
  return deduplicate(allFindings);
}

async function checkPage(
  pageNode: PageNode,
  context: BrowserContext,
  config: { outputDir: string; pageTimeout: number; baseUrl: string }
): Promise<BugFinding[]> {
  const findings: BugFinding[] = [];
  const page: Page = await context.newPage();

  // Collect console errors
  const consoleErrors: Array<{ text: string; source: string }> = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push({ text: msg.text(), source: msg.location().url || pageNode.url });
    }
  });

  // Collect failed network requests
  const networkErrors: Array<{ url: string; status: number; method: string }> = [];
  page.on("response", (resp) => {
    if (resp.status() >= 400) {
      networkErrors.push({
        url: resp.url(),
        status: resp.status(),
        method: resp.request().method(),
      });
    }
  });
  page.on("requestfailed", (req) => {
    networkErrors.push({
      url: req.url(),
      status: 0,
      method: req.method(),
    });
  });

  try {
    await page.goto(pageNode.url, {
      waitUntil: "networkidle",
      timeout: config.pageTimeout,
    });
  } catch (err) {
    findings.push({
      id: idFrom(pageNode.url, "page_load"),
      severity: "critical",
      category: "network_error",
      title: `Page failed to load: ${pageNode.url}`,
      description: (err as Error).message,
      url: pageNode.url,
      evidence: `Navigation timeout or error after ${config.pageTimeout}ms`,
    });
    await page.close();
    return findings;
  }

  // 1. Console errors → findings
  for (const ce of consoleErrors) {
    findings.push({
      id: idFrom(pageNode.url, "console", ce.text.slice(0, 50)),
      severity: "high",
      category: "console_error",
      title: `Console error: ${ce.text.slice(0, 120)}`,
      description: ce.text,
      url: pageNode.url,
      location: ce.source,
      evidence: ce.text,
    });
  }

  // 2. Network errors → findings
  for (const ne of networkErrors) {
    const sev = ne.status >= 500 ? "critical" : ne.status === 404 ? "medium" : "high";
    findings.push({
      id: idFrom(pageNode.url, "network", ne.url),
      severity: sev,
      category: "network_error",
      title: `${ne.status || "Failed"} ${ne.method} ${ne.url}`,
      description: `HTTP ${ne.status || "request failed"} on ${ne.method} ${ne.url}`,
      url: pageNode.url,
      evidence: `Status: ${ne.status}, Method: ${ne.method}`,
    });
  }

  // 3. Broken links — check each same-origin link on the page
  const brokenLinks = await detectBrokenLinks(page, pageNode.links, config.pageTimeout);
  for (const bl of brokenLinks) {
    findings.push({
      id: idFrom(pageNode.url, "broken_link", bl),
      severity: "medium",
      category: "broken_link",
      title: `Broken link: ${bl}`,
      description: `Link on ${pageNode.url} points to ${bl} which is unreachable or returns an error.`,
      url: pageNode.url,
      location: `a[href*="${bl.replace(config.baseUrl, "")}"]`,
      evidence: bl,
    });
  }

  // 4. Dead buttons — buttons with no event handlers and no form association
  try {
    const deadButtons = await page.$$eval(
      "button, [role=button], input[type=submit], input[type=button]",
      (els) =>
        els
          .filter((el) => {
            const hasHandler =
              (el as HTMLElement).onclick !== null ||
              el.getAttribute("onclick") ||
              el.closest("form") !== null ||
              el.getAttribute("type") === "submit";
            return !hasHandler;
          })
          .map((el) => ({
            text: (el as HTMLElement).innerText?.trim() || el.getAttribute("value") || "",
            selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(" ")[0]}` : el.tagName,
          }))
    );
    for (const db of deadButtons) {
      findings.push({
        id: idFrom(pageNode.url, "dead_button", db.selector),
        severity: "low",
        category: "dead_button",
        title: `Potentially dead button: "${db.text || db.selector}"`,
        description: `Button "${db.text}" on ${pageNode.url} has no click handler or form association.`,
        url: pageNode.url,
        location: db.selector,
      });
    }
  } catch {
    // Ignore eval errors on complex pages
  }

  // 5. a11y checks — basic accessibility violations
  try {
    const a11yIssues = await detectA11yIssues(page);
    findings.push(...a11yIssues.map((a) => ({
      id: idFrom(pageNode.url, "a11y", a.selector || a.description.slice(0, 30)),
      severity: a.severity,
      category: "a11y" as const,
      title: a.description,
      description: `${a.description}\nElement: ${a.selector}\nFix: ${a.fix}`,
      url: pageNode.url,
      location: a.selector,
    })));
  } catch {
    // a11y checks are best-effort
  }

  // 6. Layout overflow detection
  try {
    const hasOverflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth > doc.clientWidth || doc.scrollHeight > doc.clientHeight;
    });
    // Check individual elements for overflow
    const overflowEls = await page.$$eval("*", (els) => {
      const results: Array<{ tag: string; selector: string }> = [];
      for (const el of els) {
        if (
          el.scrollWidth > el.clientWidth + 5 ||
          el.scrollHeight > el.clientHeight + 5
        ) {
          const htmlEl = el as HTMLElement;
          if (htmlEl.offsetWidth > 500) {
            // Only report on substantial elements
            results.push({
              tag: el.tagName.toLowerCase(),
              selector: el.id ? `#${el.id}` : `.${(el.className as string)?.split?.(" ")?.[0] || el.tagName}`,
            });
          }
        }
      }
      return results.slice(0, 5); // top 5
    });
    for (const oe of overflowEls) {
      findings.push({
        id: idFrom(pageNode.url, "overflow", oe.selector),
        severity: "low",
        category: "layout",
        title: `Potential overflow on ${oe.tag}${oe.selector}`,
        description: `Element ${oe.tag}${oe.selector} has content exceeding its bounds.`,
        url: pageNode.url,
        location: oe.selector,
      });
    }
  } catch {
    // best-effort
  }

  await page.close();
  return findings;
}

/**
 * Check each link by making a HEAD/GET request.
 */
async function detectBrokenLinks(
  page: Page,
  links: string[],
  timeout: number
): Promise<string[]> {
  const broken: string[] = [];
  for (const link of links.slice(0, 20)) {
    // sample at most 20 links per page to stay fast
    try {
      const resp = await page.request.head(link, {
        timeout: Math.min(timeout, 10_000),
      });
      if (resp.status() >= 400) {
        broken.push(`${link} (HTTP ${resp.status()})`);
      }
    } catch {
      broken.push(link);
    }
  }
  return broken;
}

/**
 * Basic a11y checks without requiring axe-core injection.
 * For deeper checks, inject axe-core in a separate pass.
 */
async function detectA11yIssues(
  page: Page
): Promise<Array<{ description: string; selector: string; severity: BugFinding["severity"]; fix: string }>> {
  const issues: Array<{ description: string; selector: string; severity: BugFinding["severity"]; fix: string }> = [];

  try {
    // Check images without alt text
    const imgsWithoutAlt = await page.$$eval("img:not([alt])", (els) =>
      els.map((el) => ({
        selector: `img[src="${(el as HTMLImageElement).src?.split("/").pop()}"]`,
        src: (el as HTMLImageElement).src,
      }))
    );
    for (const img of imgsWithoutAlt) {
      issues.push({
        description: `Image missing alt text: ${img.src.split("/").pop()}`,
        selector: img.selector,
        severity: "medium",
        fix: "Add a descriptive alt attribute to the <img> element.",
      });
    }

    // Check form inputs without labels
    const inputsWithoutLabels = await page.$$eval(
      "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea",
      (els) =>
        els
          .filter((el) => {
            const id = el.id;
            if (id && document.querySelector(`label[for="${id}"]`)) return false;
            if (el.closest("label")) return false;
            if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))
              return false;
            return true;
          })
          .map((el) => ({
            selector: el.id
              ? `#${el.id}`
              : `[name="${(el as HTMLInputElement).name}"]`,
            tag: el.tagName.toLowerCase(),
          }))
    );
    for (const inp of inputsWithoutLabels) {
      issues.push({
        description: `${inp.tag} input missing accessible label`,
        selector: inp.selector,
        severity: "high",
        fix: "Add a <label> element with for attribute, or use aria-label / aria-labelledby.",
      });
    }

    // Check for low contrast text (heuristic — very light text)
    const lowContrast = await page.$$eval("*", (els) => {
      const results: Array<{ selector: string; color: string }> = [];
      for (const el of els.slice(0, 200)) {
        const style = window.getComputedStyle(el);
        const color = style.color;
        const bg = style.backgroundColor;
        // Very rough: #ccc or lighter on white-ish bg
        if (
          (color.includes("204") || color.includes("211") || color.includes("221")) &&
          (bg.includes("255") || bg.includes("white"))
        ) {
          const htmlEl = el as HTMLElement;
          results.push({
            selector: htmlEl.id
              ? `#${htmlEl.id}`
              : htmlEl.className
                ? `.${htmlEl.className.split(" ")[0]}`
                : htmlEl.tagName.toLowerCase(),
            color,
          });
        }
      }
      return results.slice(0, 3);
    });
    for (const lc of lowContrast) {
      issues.push({
        description: `Potentially low contrast text (color: ${lc.color})`,
        selector: lc.selector,
        severity: "medium",
        fix: "Ensure contrast ratio meets WCAG AA minimum (4.5:1 for normal text).",
      });
    }

    // Check for empty headings
    const emptyHeadings = await page.$$eval("h1, h2, h3, h4, h5, h6", (els) =>
      els
        .filter((el) => !(el as HTMLElement).innerText?.trim())
        .map((el) => ({
          selector: el.tagName.toLowerCase(),
          tag: el.tagName,
        }))
    );
    for (const eh of emptyHeadings) {
      issues.push({
        description: `Empty heading tag <${eh.tag}>`,
        selector: eh.selector,
        severity: "low",
        fix: "Add content to the heading or remove the empty element.",
      });
    }
  } catch {
    // best-effort
  }

  return issues;
}

function idFrom(...parts: string[]): string {
  const hash = parts
    .join("|")
    .split("")
    .reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
  return `BUG-${Math.abs(hash).toString(36).slice(0, 8).toUpperCase()}`;
}

function deduplicate(findings: BugFinding[]): BugFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.title}|${f.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
