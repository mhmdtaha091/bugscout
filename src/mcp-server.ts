/**
 * MCP Server — exposes Playwright browser control as MCP tools.
 * This is the agent↔tools boundary per WEBQA_AGENT_PLAN.md architecture.
 *
 * Tools exposed:
 * - navigate: go to a URL
 * - snapshot: get accessibility tree + screenshot
 * - click: click an element
 * - fill: type into an input
 * - evaluate: run JS in the page
 * - console_logs: retrieve collected console errors
 * - network_errors: retrieve collected network failures
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, BrowserContext, Page } from "playwright";

// ─── Global browser state ───

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let consoleErrors: Array<{ text: string; source: string }> = [];
let networkErrors: Array<{ url: string; status: number; method: string }> = [];

// ─── Server setup ───

const server = new Server(
  {
    name: "bugscout-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Tool definitions ───

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "navigate",
      description:
        "Navigate the browser to a URL. Use this to start exploring a page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to navigate to" },
        },
        required: ["url"],
      },
    },
    {
      name: "snapshot",
      description:
        "Get the current page's accessibility tree and a screenshot. Returns a text summary of interactive elements and their roles/names.",
      inputSchema: {
        type: "object",
        properties: {
          maxDepth: {
            type: "number",
            description: "Max depth for accessibility tree (default 3)",
          },
        },
      },
    },
    {
      name: "click",
      description:
        "Click an element on the page. Prefer elements identified by role and accessible name.",
      inputSchema: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "CSS selector, or use role=button&name=Submit format for role-based selection",
          },
        },
        required: ["selector"],
      },
    },
    {
      name: "fill",
      description: "Type text into an input field.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the input" },
          value: { type: "string", description: "Text to type" },
        },
        required: ["selector", "value"],
      },
    },
    {
      name: "evaluate",
      description:
        "Execute JavaScript in the page context. Returns the result as JSON.",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", description: "JavaScript code to run" },
        },
        required: ["script"],
      },
    },
    {
      name: "console_logs",
      description:
        "Retrieve all console errors collected since the last navigation.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "network_errors",
      description:
        "Retrieve all network errors (4xx/5xx/failures) collected since the last navigation.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "close",
      description: "Close the browser and end the session.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// ─── Tool handler ───

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "navigate": {
        await ensureBrowser();
        const url = (args as { url: string }).url;
        consoleErrors = [];
        networkErrors = [];
        await page!.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return {
          content: [
            {
              type: "text",
              text: `Navigated to ${url}. Title: "${await page!.title()}"`,
            },
          ],
        };
      }

      case "snapshot": {
        if (!page) return { content: [{ type: "text", text: "No page loaded. Use navigate first." }] };
        const maxDepth = (args as { maxDepth?: number }).maxDepth ?? 3;
        const axTree = await (page as any).accessibility?.snapshot({ interestingOnly: true });
        const summary = summarizeAxTree(axTree, maxDepth);

        // Take a screenshot (base64)
        const screenshot = await page.screenshot({ type: "png", fullPage: false });
        const base64 = screenshot.toString("base64");

        return {
          content: [
            { type: "text", text: `URL: ${page.url()}\nTitle: ${await page.title()}\n\nAccessibility tree:\n${summary}` },
            {
              type: "image",
              data: base64,
              mimeType: "image/png",
            },
          ],
        };
      }

      case "click": {
        if (!page) return { content: [{ type: "text", text: "No page loaded." }] };
        const selector = (args as { selector: string }).selector;

        // Support role-based selectors: role=button&name=Submit
        if (selector.startsWith("role=")) {
          const params = new URLSearchParams(selector);
          const role = params.get("role") || "button";
          const name = params.get("name") || "";
          if (name) {
            await page.getByRole(role as any, { name }).click({ timeout: 5_000 });
          } else {
            await page.getByRole(role as any).first().click({ timeout: 5_000 });
          }
        } else {
          await page.click(selector, { timeout: 5_000 });
        }

        await page.waitForLoadState("domcontentloaded");
        return {
          content: [
            {
              type: "text",
              text: `Clicked "${selector}". Now at: ${page.url()}`,
            },
          ],
        };
      }

      case "fill": {
        if (!page) return { content: [{ type: "text", text: "No page loaded." }] };
        const { selector, value } = args as { selector: string; value: string };
        await page.fill(selector, value, { timeout: 5_000 });
        return {
          content: [
            {
              type: "text",
              text: `Filled "${selector}" with "${value}"`,
            },
          ],
        };
      }

      case "evaluate": {
        if (!page) return { content: [{ type: "text", text: "No page loaded." }] };
        const { script } = args as { script: string };
        const result = await page.evaluate(script);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "console_logs": {
        return {
          content: [
            {
              type: "text",
              text:
                consoleErrors.length > 0
                  ? consoleErrors.map((e) => `[ERROR] ${e.text} (${e.source})`).join("\n")
                  : "No console errors collected.",
            },
          ],
        };
      }

      case "network_errors": {
        return {
          content: [
            {
              type: "text",
              text:
                networkErrors.length > 0
                  ? networkErrors
                      .map((e) => `${e.method} ${e.url} → HTTP ${e.status || "FAILED"}`)
                      .join("\n")
                  : "No network errors collected.",
            },
          ],
        };
      }

      case "close": {
        await cleanup();
        return {
          content: [{ type: "text", text: "Browser closed. Session ended." }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// ─── Browser lifecycle ───

async function ensureBrowser(): Promise<void> {
  if (browser && context && page) return;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "BugScout-MCP/0.1.0",
  });
  page = await context.newPage();

  // Collect console errors
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push({
        text: msg.text(),
        source: msg.location().url || page?.url() || "",
      });
    }
  });

  // Collect network errors
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
}

async function cleanup(): Promise<void> {
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// ─── A11y tree summarizer ───

interface AxNode {
  role: string;
  name?: string;
  value?: string | number | boolean;
  description?: string;
  children?: AxNode[];
}

function summarizeAxTree(
  node: AxNode | null,
  maxDepth: number,
  depth = 0
): string {
  if (!node || depth > maxDepth) return "";
  const indent = "  ".repeat(depth);
  let result = `${indent}${node.role}`;
  if (node.name) result += ` "${node.name.slice(0, 80)}"`;
  if (node.description) result += ` (${node.description.slice(0, 60)})`;
  if (node.value !== undefined) result += ` = ${node.value}`;
  result += "\n";
  if (node.children) {
    for (const child of node.children) {
      result += summarizeAxTree(child, maxDepth, depth + 1);
    }
  }
  return result;
}

// ─── Entry point ───

export async function startMCPServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[bugscout-mcp] Server started on stdio");

  // Clean up on exit
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });
}

// Allow running directly: npx tsx src/mcp-server.ts
if (process.argv[1]?.includes("mcp-server")) {
  startMCPServer().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
