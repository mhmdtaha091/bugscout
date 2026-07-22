import { chromium, Browser, Page } from "playwright";
import type {
  ExplorerConfig,
  PageNode,
  PageElement,
  FormInfo,
  FormField,
  FlowMap,
  UserFlow,
} from "./types.js";

const DEFAULT_CONFIG: Partial<ExplorerConfig> = {
  maxPages: 50,
  maxDepth: 5,
  sameOrigin: true,
  captureScreenshots: true,
  outputDir: "./bugscout-output",
  pageTimeout: 30_000,
  headless: true,
};

/**
 * Parse and normalize a URL for same-origin comparison.
 * (Exported for unit tests.)
 */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`;
  } catch {
    return "";
  }
}

/**
 * Extract interactive elements from a page: links, buttons, inputs.
 */
async function extractElements(page: Page): Promise<PageElement[]> {
  return page.$$eval(
    "a, button, input, select, textarea, [role=button], [role=link], [onclick]",
    (els) =>
      els.map((el) => {
        const tag = el.tagName.toLowerCase();
        const text =
          (el as HTMLElement).innerText?.trim().slice(0, 100) ||
          (el as HTMLInputElement).value ||
          (el as HTMLInputElement).placeholder ||
          "";
        const role =
          el.getAttribute("role") ||
          (tag === "a" ? "link" : tag === "button" ? "button" : "input");
        // Build a deterministic-ish selector
        const id = el.id ? `#${el.id}` : "";
        const testId = el.getAttribute("data-testid")
          ? `[data-testid="${el.getAttribute("data-testid")}"]`
          : "";
        const ariaLabel = el.getAttribute("aria-label")
          ? `[aria-label="${el.getAttribute("aria-label")}"]`
          : "";
        const selector = testId || ariaLabel || id || `${tag}:has-text("${text.slice(0, 30)}")`;

        return {
          selector,
          tag,
          text,
          role,
          triggersNavigation: tag === "a" && !!el.getAttribute("href"),
        };
      })
  );
}

/**
 * Extract forms from a page with their fields.
 */
async function extractForms(page: Page): Promise<FormInfo[]> {
  return page.$$eval("form", (forms) =>
    forms.map((form) => {
      const fields: FormField[] = [];
      form
        .querySelectorAll("input, select, textarea")
        .forEach((field) => {
          const el = field as HTMLInputElement;
          if (
            el.type === "hidden" ||
            el.type === "submit" ||
            el.type === "button"
          )
            return;
          fields.push({
            name: el.name || el.id || "",
            type: el.type || el.tagName.toLowerCase(),
            required: el.required,
            selector: el.id
              ? `#${el.id}`
              : el.name
                ? `[name="${el.name}"]`
                : el.tagName.toLowerCase(),
            label:
              el.labels?.[0]?.textContent?.trim() ||
              el.getAttribute("aria-label") ||
              undefined,
          });
        });
      return {
        selector: form.id
          ? `#${form.id}`
          : `form[action="${form.action}"]`,
        action: form.action || window.location.href,
        method: (form.method || "get").toLowerCase(),
        fields,
        submitButton: form.querySelector(
          'button[type=submit], input[type=submit]'
        )
          ? 'button[type=submit], input[type=submit]'
          : undefined,
      };
    })
  );
}

/**
 * Extract all same-origin links from a page.
 * (Exported for unit tests.)
 */
export async function extractLinks(page: Page, baseOrigin: string): Promise<string[]> {
  const hrefs = await page.$$eval("a[href]", (links) =>
    links.map((a) => a.getAttribute("href") || "").filter(Boolean)
  );

  const resolved = hrefs
    .map((h) => {
      try {
        return new URL(h, page.url()).href;
      } catch {
        return "";
      }
    })
    .filter((u) => u && originOf(u) === baseOrigin)
    // Deduplicate and remove fragments
    .map((u) => u.split("#")[0]);

  return [...new Set(resolved)];
}

/**
 * Detect simple multi-step flows from the flow map.
 * Looks for: page with form → success/redirect page.
 * (Exported for unit tests.)
 */
export function discoverFlows(flowMap: FlowMap): UserFlow[] {
  const flows: UserFlow[] = [];
  const visited = new Set<string>();

  for (const [, page] of flowMap.pages) {
    for (const form of page.forms) {
      if (visited.has(page.url + form.selector)) continue;
      visited.add(page.url + form.selector);

      const flow: UserFlow = {
        name: `Form submission on ${page.title || page.url}`,
        steps: [
          {
            action: "navigate",
            target: page.url,
            pageUrl: page.url,
            description: `Navigate to ${page.url}`,
          },
        ],
      };

      // Add fill steps for each visible form field
      for (const field of form.fields) {
        if (field.type === "hidden") continue;
        flow.steps.push({
          action: "fill",
          target: field.selector,
          value: field.type === "email" ? "test@example.com" : "test-value",
          pageUrl: page.url,
          description: `Fill ${field.label || field.name || field.type} field`,
        });
      }

      if (form.submitButton) {
        flow.steps.push({
          action: "click",
          target: form.submitButton,
          pageUrl: page.url,
          description: "Submit the form",
        });
      }

      // Look for a redirect after form submission
      const actionUrl = form.action
        ? new URL(form.action, page.url).href.split("#")[0]
        : "";
      if (actionUrl && actionUrl !== page.url && flowMap.pages.has(actionUrl)) {
        flow.steps.push({
          action: "wait",
          target: actionUrl,
          pageUrl: actionUrl,
          description: `Expect redirect to ${actionUrl}`,
        });
      }

      flows.push(flow);
    }
  }

  return flows;
}

/**
 * Main explorer: crawls a site, builds the flow map, discovers flows.
 */
export async function explore(
  config: ExplorerConfig
): Promise<FlowMap> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const baseOrigin = originOf(cfg.baseUrl);

  const browser: Browser = await chromium.launch({ headless: cfg.headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "BugScout/1.0 (autonomous QA agent; +https://github.com/mhmdtaha091/bugscout)",
  });

  const pages = new Map<string, PageNode>();
  const edges: Array<{ from: string; to: string; label: string }> = [];
  const queue: Array<{ url: string; depth: number }> = [
    { url: cfg.baseUrl, depth: 0 },
  ];
  const visited = new Set<string>();

  try {
    while (queue.length > 0 && pages.size < cfg.maxPages) {
      const { url, depth } = queue.shift()!;
      const normalizedUrl = url.split("#")[0];

      if (visited.has(normalizedUrl)) continue;
      if (depth > cfg.maxDepth) continue;
      if (cfg.sameOrigin && originOf(normalizedUrl) !== baseOrigin) continue;
      // Skip non-HTML resources
      if (/\.(png|jpg|jpeg|gif|svg|css|js|woff|woff2|ico|pdf|zip)$/i.test(normalizedUrl))
        continue;

      visited.add(normalizedUrl);
      console.log(`[explorer] Crawling (depth ${depth}): ${normalizedUrl}`);

      let pageNode: PageNode;
      try {
        const page: Page = await context.newPage();
        await page.goto(normalizedUrl, {
          waitUntil: "domcontentloaded",
          timeout: cfg.pageTimeout,
        });

        const title = await page.title();
        const elements = await extractElements(page);
        const forms = await extractForms(page);
        const links = await extractLinks(page, baseOrigin);

        let screenshot: string | undefined;
        if (cfg.captureScreenshots) {
          screenshot = `screenshots/${sanitizeFilename(normalizedUrl)}.png`;
          await page.screenshot({
            path: `${cfg.outputDir}/${screenshot}`,
            fullPage: false,
          });
        }

        pageNode = {
          url: normalizedUrl,
          title,
          elements,
          links,
          forms,
          screenshot,
        };

        // Enqueue new same-origin links
        for (const link of links) {
          const normalized = link.split("#")[0];
          if (!visited.has(normalized)) {
            queue.push({ url: normalized, depth: depth + 1 });
            edges.push({
              from: normalizedUrl,
              to: normalized,
              label: "link",
            });
          }
        }

        await page.close();
      } catch (err) {
        console.warn(`[explorer] Failed to crawl ${normalizedUrl}:`, (err as Error).message);
        // Add a minimal error node so the flow map isn't silent about failures
        pageNode = {
          url: normalizedUrl,
          title: `[ERROR] ${(err as Error).message}`,
          elements: [],
          links: [],
          forms: [],
        };
      }

      pages.set(normalizedUrl, pageNode);
    }
  } finally {
    await browser.close();
  }

  const flowMap: FlowMap = {
    baseUrl: cfg.baseUrl,
    pages,
    edges,
    flows: [],
  };

  flowMap.flows = discoverFlows(flowMap);

  return flowMap;
}

/** Sanitize a URL for use as a filename. (Exported for unit tests.) */
export function sanitizeFilename(url: string): string {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .slice(0, 100);
}
