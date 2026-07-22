/**
 * Unit tests for the explorer's pure logic: URL origin normalization,
 * same-origin link extraction, flow discovery, and filename sanitization.
 * The crawler loop itself (`explore`) needs a real browser and is not
 * covered here.
 */
import { test, expect } from "@playwright/test";
import {
  originOf,
  extractLinks,
  discoverFlows,
  sanitizeFilename,
} from "../src/explorer.js";
import type { FormInfo } from "../src/types.js";
import { makeFlowMap, makePage, pageWithAnchors } from "./helpers.js";

// ─── originOf ───

test.describe("originOf", () => {
  test("extracts protocol + host, dropping path and query", () => {
    expect(originOf("https://example.com/a/b?c=1")).toBe("https://example.com");
  });

  test("keeps explicit ports", () => {
    expect(originOf("https://example.com:8443/x")).toBe("https://example.com:8443");
    expect(originOf("http://localhost:3000")).toBe("http://localhost:3000");
  });

  test("drops credentials and lowercases scheme and host", () => {
    expect(originOf("https://user:pw@example.com/p")).toBe("https://example.com");
    expect(originOf("HTTPS://EXAMPLE.com/x")).toBe("https://example.com");
  });

  test("returns empty string for unparseable input", () => {
    expect(originOf("not a url")).toBe("");
    expect(originOf("")).toBe("");
  });

  test("non-http schemes never equal an http(s) origin", () => {
    expect(originOf("mailto:hi@x.com")).toBe("mailto://");
  });
});

// ─── sanitizeFilename ───

test.describe("sanitizeFilename", () => {
  test("strips the protocol and replaces non-alphanumerics with underscores", () => {
    expect(sanitizeFilename("https://example.com/path/to page?q=1&r=2")).toBe(
      "example_com_path_to_page_q_1_r_2"
    );
  });

  test("caps the result at 100 characters", () => {
    const long = "https://example.com/" + "a".repeat(300);
    expect(sanitizeFilename(long)).toHaveLength(100);
  });

  test("is deterministic", () => {
    const url = "https://example.com/x/y";
    expect(sanitizeFilename(url)).toBe(sanitizeFilename(url));
  });
});

// ─── extractLinks ───

test.describe("extractLinks", () => {
  const ORIGIN = "https://example.com";

  test("resolves relative links against the current page URL", async () => {
    const page = pageWithAnchors("https://example.com/dir/page", [
      "about.html",
      "/pricing",
    ]);
    expect(await extractLinks(page, ORIGIN)).toEqual([
      "https://example.com/dir/about.html",
      "https://example.com/pricing",
    ]);
  });

  test("keeps absolute same-origin links and drops cross-origin ones", async () => {
    const page = pageWithAnchors("https://example.com/", [
      "https://example.com/docs",
      "https://other.example.net/elsewhere",
      "http://example.com/insecure", // different protocol → different origin
    ]);
    expect(await extractLinks(page, ORIGIN)).toEqual(["https://example.com/docs"]);
  });

  test("drops mailto: and other non-http schemes", async () => {
    const page = pageWithAnchors("https://example.com/", [
      "mailto:someone@example.com",
      "tel:+123456789",
      "/contact",
    ]);
    expect(await extractLinks(page, ORIGIN)).toEqual(["https://example.com/contact"]);
  });

  test("strips fragments and deduplicates the result", async () => {
    const page = pageWithAnchors("https://example.com/", [
      "/docs#install",
      "/docs#usage",
      "/docs",
      "/docs",
    ]);
    expect(await extractLinks(page, ORIGIN)).toEqual(["https://example.com/docs"]);
  });

  test("ignores empty and missing hrefs", async () => {
    const page = pageWithAnchors("https://example.com/", ["", null, "/ok"]);
    expect(await extractLinks(page, ORIGIN)).toEqual(["https://example.com/ok"]);
  });

  test("returns an empty list when the page has no anchors", async () => {
    const page = pageWithAnchors("https://example.com/", []);
    expect(await extractLinks(page, ORIGIN)).toEqual([]);
  });
});

// ─── discoverFlows ───

function contactForm(overrides: Partial<FormInfo> = {}): FormInfo {
  return {
    selector: "#contact-form",
    action: "https://s.io/thanks",
    method: "post",
    fields: [
      { name: "email", type: "email", required: true, selector: "#email", label: "Email" },
      { name: "msg", type: "textarea", required: false, selector: "#msg" },
      { name: "csrf", type: "hidden", required: false, selector: '[name="csrf"]' },
    ],
    submitButton: "button[type=submit], input[type=submit]",
    ...overrides,
  };
}

test.describe("discoverFlows", () => {
  test("builds a navigate → fill → submit → redirect flow from a form", () => {
    const flowMap = makeFlowMap("https://s.io", [
      makePage("https://s.io/contact", { title: "Contact Us", forms: [contactForm()] }),
      makePage("https://s.io/thanks", { title: "Thanks" }),
    ]);

    const flows = discoverFlows(flowMap);
    expect(flows).toHaveLength(1);
    expect(flows[0].name).toBe("Form submission on Contact Us");
    expect(flows[0].steps).toEqual([
      {
        action: "navigate",
        target: "https://s.io/contact",
        pageUrl: "https://s.io/contact",
        description: "Navigate to https://s.io/contact",
      },
      {
        action: "fill",
        target: "#email",
        value: "test@example.com", // email fields get an email-shaped value
        pageUrl: "https://s.io/contact",
        description: "Fill Email field",
      },
      {
        action: "fill",
        target: "#msg",
        value: "test-value",
        pageUrl: "https://s.io/contact",
        description: "Fill msg field",
      },
      {
        action: "click",
        target: "button[type=submit], input[type=submit]",
        pageUrl: "https://s.io/contact",
        description: "Submit the form",
      },
      {
        action: "wait",
        target: "https://s.io/thanks",
        pageUrl: "https://s.io/thanks",
        description: "Expect redirect to https://s.io/thanks",
      },
    ]);
  });

  test("skips hidden fields", () => {
    const flowMap = makeFlowMap("https://s.io", [
      makePage("https://s.io/contact", { forms: [contactForm()] }),
    ]);
    const targets = discoverFlows(flowMap)[0].steps.map((s) => s.target);
    expect(targets).not.toContain('[name="csrf"]');
  });

  test("omits the redirect step when the form posts back to the same page", () => {
    const flowMap = makeFlowMap("https://s.io", [
      makePage("https://s.io/contact", {
        forms: [contactForm({ action: "https://s.io/contact" })],
      }),
    ]);
    const actions = discoverFlows(flowMap)[0].steps.map((s) => s.action);
    expect(actions).not.toContain("wait");
  });

  test("omits the redirect step when the action URL was not crawled", () => {
    const flowMap = makeFlowMap("https://s.io", [
      makePage("https://s.io/contact", {
        forms: [contactForm({ action: "https://s.io/never-crawled" })],
      }),
    ]);
    const actions = discoverFlows(flowMap)[0].steps.map((s) => s.action);
    expect(actions).not.toContain("wait");
  });

  test("omits the click step when the form has no submit button", () => {
    const flowMap = makeFlowMap("https://s.io", [
      makePage("https://s.io/contact", {
        forms: [contactForm({ submitButton: undefined })],
      }),
    ]);
    const actions = discoverFlows(flowMap)[0].steps.map((s) => s.action);
    expect(actions).not.toContain("click");
  });

  test("deduplicates forms with the same selector on the same page", () => {
    const flowMap = makeFlowMap("https://s.io", [
      makePage("https://s.io/contact", { forms: [contactForm(), contactForm()] }),
    ]);
    expect(discoverFlows(flowMap)).toHaveLength(1);
  });

  test("returns no flows for pages without forms", () => {
    const flowMap = makeFlowMap("https://s.io", [
      makePage("https://s.io/"),
      makePage("https://s.io/about"),
    ]);
    expect(discoverFlows(flowMap)).toEqual([]);
  });
});
