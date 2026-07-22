/**
 * Unit tests for the bug detectors' classification logic.
 *
 * `checkPage` is driven with a stubbed Playwright page (no browser, no
 * network): the stub replays console/network events and canned DOM-eval
 * results, and the tests assert how findings are classified — severity,
 * category, stable IDs, titles. The in-browser halves of the detectors
 * (the `$$eval` callbacks) need a real DOM and are not covered here, nor
 * is `detectBugs`, which launches Chromium itself.
 */
import { test, expect } from "@playwright/test";
import { checkPage, idFrom, deduplicate } from "../src/bug-detector.js";
import type { BugFinding } from "../src/types.js";
import { makeBug, makePage, makeStubPage } from "./helpers.js";

const CONFIG = { outputDir: "unused", pageTimeout: 1000, baseUrl: "https://s.io" };

// Selectors exactly as bug-detector.ts uses them (keys for canned $$eval results).
const SEL_DEAD_BUTTONS = "button, [role=button], input[type=submit], input[type=button]";
const SEL_IMGS_NO_ALT = "img:not([alt])";
const SEL_UNLABELLED_INPUTS =
  "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea";
const SEL_HEADINGS = "h1, h2, h3, h4, h5, h6";

// ─── idFrom ───

test.describe("idFrom", () => {
  test("is stable: same inputs always give the same ID", () => {
    const a = idFrom("https://a.example/", "console", "TypeError: x is not a function");
    const b = idFrom("https://a.example/", "console", "TypeError: x is not a function");
    expect(a).toBe(b);
  });

  test("pins the current hash values (IDs must stay stable across releases for CI diffing)", () => {
    expect(idFrom("https://a.example/", "console", "TypeError: x is not a function")).toBe("BUG-W6DGBI");
    expect(idFrom("https://a.example/", "network", "https://a.example/api")).toBe("BUG-VEY6J4");
    expect(idFrom("u", "page_load")).toBe("BUG-TR51KH");
  });

  test("matches the BUG-<base36> format", () => {
    expect(idFrom("anything", "at", "all")).toMatch(/^BUG-[0-9A-Z]{1,8}$/);
  });

  test("different inputs give different IDs", () => {
    expect(idFrom("https://a.example/", "console", "error one")).not.toBe(
      idFrom("https://a.example/", "console", "error two")
    );
  });
});

// ─── deduplicate ───

test.describe("deduplicate", () => {
  test("removes findings with the same title and URL, keeping the first", () => {
    const first = makeBug({ id: "BUG-1", title: "Dup", url: "https://s.io/a" });
    const second = makeBug({ id: "BUG-2", title: "Dup", url: "https://s.io/a" });
    const result = deduplicate([first, second]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first);
  });

  test("keeps findings with the same title on different URLs", () => {
    const result = deduplicate([
      makeBug({ title: "Same title", url: "https://s.io/a" }),
      makeBug({ title: "Same title", url: "https://s.io/b" }),
    ]);
    expect(result).toHaveLength(2);
  });

  test("passes an already-unique list through unchanged", () => {
    const bugs = [makeBug({ title: "A" }), makeBug({ title: "B" })];
    expect(deduplicate(bugs)).toEqual(bugs);
  });
});

// ─── checkPage: happy path ───

test("checkPage reports nothing for a clean page", async () => {
  const { context } = makeStubPage();
  const findings = await checkPage(makePage("https://s.io/clean"), context, CONFIG);
  expect(findings).toEqual([]);
});

// ─── checkPage: console errors ───

test.describe("checkPage — console errors", () => {
  test("classifies console errors as high-severity findings", async () => {
    const { context } = makeStubPage({
      consoleMessages: [
        { type: "error", text: "TypeError: boom", sourceUrl: "https://s.io/app.js" },
      ],
    });
    const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);

    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.severity).toBe("high");
    expect(f.category).toBe("console_error");
    expect(f.title).toBe("Console error: TypeError: boom");
    expect(f.url).toBe("https://s.io/");
    expect(f.location).toBe("https://s.io/app.js");
    expect(f.evidence).toBe("TypeError: boom");
    expect(f.id).toMatch(/^BUG-[0-9A-Z]{1,8}$/);
  });

  test("ignores non-error console messages", async () => {
    const { context } = makeStubPage({
      consoleMessages: [
        { type: "warning", text: "deprecation notice" },
        { type: "log", text: "hello" },
      ],
    });
    const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);
    expect(findings).toEqual([]);
  });
});

// ─── checkPage: network errors ───

test.describe("checkPage — network error severity mapping", () => {
  test("5xx → critical, 404 → medium, other 4xx → high, connection failure → high", async () => {
    const { context } = makeStubPage({
      responses: [
        { status: 500, url: "https://s.io/api/a", method: "GET" },
        { status: 404, url: "https://s.io/missing.png", method: "GET" },
        { status: 403, url: "https://s.io/api/admin", method: "POST" },
      ],
      failedRequests: [{ url: "https://cdn.s.io/lib.js", method: "GET" }],
    });
    const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);
    expect(findings).toHaveLength(4);

    const byTitle = new Map(findings.map((f) => [f.title, f]));
    expect(byTitle.get("500 GET https://s.io/api/a")?.severity).toBe("critical");
    expect(byTitle.get("404 GET https://s.io/missing.png")?.severity).toBe("medium");
    expect(byTitle.get("403 POST https://s.io/api/admin")?.severity).toBe("high");

    const failed = byTitle.get("Failed GET https://cdn.s.io/lib.js");
    expect(failed?.severity).toBe("high");
    expect(failed?.description).toBe("HTTP request failed on GET https://cdn.s.io/lib.js");

    for (const f of findings) expect(f.category).toBe("network_error");
  });
});

// ─── checkPage: page load failure ───

test("checkPage returns a single critical finding when the page fails to load", async () => {
  const { context } = makeStubPage({
    gotoError: "net::ERR_CONNECTION_REFUSED",
    // Even with detector data queued, the early return must win:
    evalResults: { [SEL_DEAD_BUTTONS]: [[{ text: "x", selector: "#x" }]] },
  });
  const findings = await checkPage(makePage("https://down.test/"), context, CONFIG);

  expect(findings).toHaveLength(1);
  expect(findings[0].severity).toBe("critical");
  expect(findings[0].category).toBe("network_error");
  expect(findings[0].title).toBe("Page failed to load: https://down.test/");
  expect(findings[0].description).toContain("net::ERR_CONNECTION_REFUSED");
  expect(findings[0].evidence).toBe("Navigation timeout or error after 1000ms");
});

// ─── checkPage: broken links ───

test.describe("checkPage — broken links", () => {
  test("flags links that 4xx or fail entirely, and leaves healthy ones alone", async () => {
    const pageNode = makePage("https://s.io/", {
      links: ["https://s.io/ok", "https://s.io/missing", "https://s.io/down"],
    });
    const { context } = makeStubPage({
      headStatuses: { "https://s.io/missing": 404, "https://s.io/down": "throw" },
    });
    const findings = await checkPage(pageNode, context, CONFIG);

    expect(findings).toHaveLength(2);
    const titles = findings.map((f) => f.title).sort();
    expect(titles).toEqual([
      "Broken link: https://s.io/down",
      "Broken link: https://s.io/missing (HTTP 404)",
    ]);
    for (const f of findings) {
      expect(f.severity).toBe("medium");
      expect(f.category).toBe("broken_link");
    }
    const missing = findings.find((f) => f.title.includes("missing"))!;
    expect(missing.location).toBe('a[href*="/missing (HTTP 404)"]');
  });

  test("samples at most 20 links per page", async () => {
    const links = Array.from({ length: 25 }, (_, i) => `https://s.io/page-${i}`);
    const { context, headCalls } = makeStubPage();
    await checkPage(makePage("https://s.io/", { links }), context, CONFIG);
    expect(headCalls).toHaveLength(20);
    expect(headCalls[0]).toBe("https://s.io/page-0");
    expect(headCalls[19]).toBe("https://s.io/page-19");
  });
});

// ─── checkPage: dead buttons ───

test("checkPage classifies handler-less buttons as low-severity dead buttons", async () => {
  const { context } = makeStubPage({
    evalResults: {
      [SEL_DEAD_BUTTONS]: [
        [
          { text: "Do nothing", selector: "#noop" },
          { text: "", selector: ".ghost" },
        ],
      ],
    },
  });
  const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);

  expect(findings).toHaveLength(2);
  expect(findings[0].severity).toBe("low");
  expect(findings[0].category).toBe("dead_button");
  expect(findings[0].title).toBe('Potentially dead button: "Do nothing"');
  expect(findings[0].location).toBe("#noop");
  // Falls back to the selector when the button has no text.
  expect(findings[1].title).toBe('Potentially dead button: ".ghost"');
});

// ─── checkPage: a11y ───

test.describe("checkPage — a11y classification", () => {
  test("image without alt text → medium", async () => {
    const { context } = makeStubPage({
      evalResults: {
        [SEL_IMGS_NO_ALT]: [
          [{ selector: 'img[src="hero.png"]', src: "https://s.io/img/hero.png" }],
        ],
      },
    });
    const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].category).toBe("a11y");
    expect(findings[0].title).toBe("Image missing alt text: hero.png");
    expect(findings[0].description).toContain("Add a descriptive alt attribute");
  });

  test("unlabelled form input → high", async () => {
    const { context } = makeStubPage({
      evalResults: {
        [SEL_UNLABELLED_INPUTS]: [[{ selector: "#email", tag: "input" }]],
      },
    });
    const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].category).toBe("a11y");
    expect(findings[0].title).toBe("input input missing accessible label");
    expect(findings[0].location).toBe("#email");
  });

  test("low-contrast text → medium, empty heading → low", async () => {
    const { context } = makeStubPage({
      evalResults: {
        // "*" is queried twice: first the contrast heuristic, then overflow.
        "*": [[{ selector: ".hint", color: "rgb(204, 204, 204)" }], []],
        [SEL_HEADINGS]: [[{ selector: "h2", tag: "H2" }]],
      },
    });
    const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);

    expect(findings).toHaveLength(2);
    const contrast = findings.find((f) => f.title.startsWith("Potentially low contrast"))!;
    expect(contrast.severity).toBe("medium");
    expect(contrast.title).toBe("Potentially low contrast text (color: rgb(204, 204, 204))");
    const heading = findings.find((f) => f.title.startsWith("Empty heading"))!;
    expect(heading.severity).toBe("low");
    expect(heading.title).toBe("Empty heading tag <H2>");
    expect(heading.category).toBe("a11y");
  });
});

// ─── checkPage: layout overflow ───

test("checkPage classifies overflowing elements as low-severity layout findings", async () => {
  const { context } = makeStubPage({
    evalResults: {
      // First "*" call (contrast) → clean; second (overflow) → one wide element.
      "*": [[], [{ tag: "div", selector: "#wide" }]],
    },
  });
  const findings = await checkPage(makePage("https://s.io/"), context, CONFIG);

  expect(findings).toHaveLength(1);
  expect(findings[0].severity).toBe("low");
  expect(findings[0].category).toBe("layout");
  expect(findings[0].title).toBe("Potential overflow on div#wide");
  expect(findings[0].location).toBe("#wide");
});

// ─── checkPage: IDs are stable across runs ───

test("checkPage produces identical finding IDs for identical inputs (regression-diff contract)", async () => {
  const options = {
    consoleMessages: [{ type: "error", text: "ReferenceError: nope" }],
    responses: [{ status: 500, url: "https://s.io/api", method: "GET" as const }],
  };
  const run = async (): Promise<BugFinding[]> => {
    const { context } = makeStubPage(options);
    return checkPage(makePage("https://s.io/"), context, CONFIG);
  };
  const [first, second] = [await run(), await run()];
  expect(first.map((f) => f.id)).toEqual(second.map((f) => f.id));
});
