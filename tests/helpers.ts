/**
 * Shared fixtures and Playwright stubs for BugScout's unit tests.
 *
 * Not a test file — Playwright only collects `*.spec.ts`.
 *
 * The stubs implement just enough of Playwright's `Page` / `BrowserContext`
 * surface for the Node-side classifier logic to run. No browser is launched
 * and no network is touched anywhere in the suite.
 */
import type { Page, BrowserContext } from "playwright";
import type {
  BugFinding,
  FlowMap,
  PageNode,
  ScanResult,
  ScanStats,
  UserFlow,
} from "../src/types.js";

// ─── Domain object factories ───

export function makePage(url: string, overrides: Partial<PageNode> = {}): PageNode {
  return { url, title: "Untitled", elements: [], links: [], forms: [], ...overrides };
}

export function makeFlowMap(
  baseUrl: string,
  pages: PageNode[] = [],
  overrides: Partial<Omit<FlowMap, "pages">> = {}
): FlowMap {
  return {
    baseUrl,
    pages: new Map(pages.map((p) => [p.url, p])),
    edges: [],
    flows: [],
    ...overrides,
  };
}

export function makeBug(overrides: Partial<BugFinding> = {}): BugFinding {
  return {
    id: "BUG-TEST0001",
    severity: "medium",
    category: "other",
    title: "Example finding",
    description: "Example description",
    url: "https://site.test/",
    ...overrides,
  };
}

export function makeStats(overrides: Partial<ScanStats> = {}): ScanStats {
  return {
    pagesCrawled: 0,
    bugsFound: 0,
    flowsDiscovered: 0,
    testsGenerated: 0,
    durationMs: 0,
    llmCalls: [],
    totalCost: 0,
    ...overrides,
  };
}

export function makeResult(overrides: Partial<ScanResult> = {}): ScanResult {
  const flowMap = overrides.flowMap ?? makeFlowMap("https://site.test");
  const bugs = overrides.bugs ?? [];
  return {
    flowMap,
    bugs,
    generatedTests: [],
    stats: makeStats({ pagesCrawled: flowMap.pages.size, bugsFound: bugs.length }),
    reportPath: "",
    ...overrides,
  };
}

export function makeFlow(overrides: Partial<UserFlow> = {}): UserFlow {
  return { name: "Example flow", steps: [], ...overrides };
}

// ─── Playwright stubs ───

type Handler = (arg: unknown) => void;

export interface StubPageOptions {
  /** Console messages emitted while `goto` runs. */
  consoleMessages?: Array<{ type: string; text: string; sourceUrl?: string }>;
  /** HTTP responses emitted while `goto` runs. */
  responses?: Array<{ status: number; url: string; method: string }>;
  /** Failed (no-response) requests emitted while `goto` runs. */
  failedRequests?: Array<{ url: string; method: string }>;
  /** When set, `goto` rejects with this message (after emitting events). */
  gotoError?: string;
  /** HEAD status per link URL. Missing → 200. `"throw"` → network error. */
  headStatuses?: Record<string, number | "throw">;
  /**
   * Canned `$$eval` results keyed by the exact selector string the code
   * under test uses. Each selector holds a queue consumed in call order
   * (the `"*"` selector is used twice: low-contrast check, then overflow).
   */
  evalResults?: Record<string, unknown[][]>;
  /** Result of `page.evaluate()` (document-level overflow probe). */
  evaluateResult?: unknown;
}

export interface StubPageHandle {
  page: Page;
  context: BrowserContext;
  /** Links passed to `page.request.head`, in call order. */
  headCalls: string[];
}

export function makeStubPage(options: StubPageOptions = {}): StubPageHandle {
  const handlers = new Map<string, Handler[]>();
  const headCalls: string[] = [];
  const evalQueues = new Map<string, unknown[][]>(
    Object.entries(options.evalResults ?? {}).map(([sel, queue]) => [sel, [...queue]])
  );

  const emit = (event: string, arg: unknown): void => {
    for (const h of handlers.get(event) ?? []) h(arg);
  };

  const page = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return page;
    },
    async goto(_url: string, _opts?: unknown) {
      for (const m of options.consoleMessages ?? []) {
        emit("console", {
          type: () => m.type,
          text: () => m.text,
          location: () => ({ url: m.sourceUrl ?? "" }),
        });
      }
      for (const r of options.responses ?? []) {
        emit("response", {
          status: () => r.status,
          url: () => r.url,
          request: () => ({ method: () => r.method }),
        });
      }
      for (const f of options.failedRequests ?? []) {
        emit("requestfailed", { url: () => f.url, method: () => f.method });
      }
      if (options.gotoError) throw new Error(options.gotoError);
      return null;
    },
    async $$eval(selector: string, _fn: unknown) {
      const queue = evalQueues.get(selector);
      return queue && queue.length > 0 ? queue.shift() : [];
    },
    async evaluate(_fn: unknown) {
      return options.evaluateResult ?? false;
    },
    request: {
      async head(link: string, _opts?: unknown) {
        headCalls.push(link);
        const status = options.headStatuses?.[link];
        if (status === "throw") throw new Error("connection refused");
        return { status: () => (typeof status === "number" ? status : 200) };
      },
    },
    async close() {
      /* no-op */
    },
  };

  const context = {
    async newPage() {
      return page as unknown as Page;
    },
  } as unknown as BrowserContext;

  return { page: page as unknown as Page, context, headCalls };
}

/** Minimal `Page` stub for `extractLinks`: real callback runs over fake anchors. */
export function pageWithAnchors(pageUrl: string, hrefs: Array<string | null>): Page {
  return {
    url: () => pageUrl,
    async $$eval(_selector: string, fn: (els: Array<{ getAttribute(name: string): string | null }>) => unknown) {
      return fn(hrefs.map((h) => ({ getAttribute: () => h })));
    },
  } as unknown as Page;
}
