/**
 * Unit tests for the deterministic (no-LLM) Playwright spec generator.
 *
 * The core contract per WEBQA_AGENT_PLAN.md: same flow in → byte-identical
 * spec out, selector priority role/label > testid > CSS, explicit waits,
 * and no LLM calls inside generated code.
 */
import { test, expect } from "@playwright/test";
import { generateSpecFromFlow, generateAllSpecs } from "../src/test-generator.js";
import type { UserFlow, FlowStep } from "../src/types.js";
import { makeFlow } from "./helpers.js";

function singleStepFlow(action: FlowStep["action"], target: string, value?: string): UserFlow {
  return makeFlow({
    name: "t",
    steps: [{ action, target, value, pageUrl: "https://s.io/", description: "d" }],
  });
}

/** The exact flow shape `discoverFlows` produces for a login form. */
function loginFlow(): UserFlow {
  return {
    name: "Form submission on Login — Acme! (staging)",
    steps: [
      {
        action: "navigate",
        target: "https://app.example.com/login",
        pageUrl: "https://app.example.com/login",
        description: "Navigate to https://app.example.com/login",
      },
      {
        action: "fill",
        target: "#email",
        value: "test@example.com",
        pageUrl: "https://app.example.com/login",
        description: "Fill Email field",
      },
      {
        action: "fill",
        target: '[name="password"]',
        value: 'pa"ss',
        pageUrl: "https://app.example.com/login",
        description: "Fill password field",
      },
      {
        action: "click",
        target: "button[type=submit], input[type=submit]",
        pageUrl: "https://app.example.com/login",
        description: "Submit the form",
      },
      {
        action: "wait",
        target: "https://app.example.com/dashboard",
        pageUrl: "https://app.example.com/dashboard",
        description: "Expect redirect to https://app.example.com/dashboard",
      },
    ],
  };
}

test.describe("generateSpecFromFlow — determinism", () => {
  test("same flow in → byte-identical spec out", () => {
    expect(generateSpecFromFlow(loginFlow())).toBe(generateSpecFromFlow(loginFlow()));
  });

  test("does not mutate the input flow", () => {
    const flow = loginFlow();
    const snapshot = JSON.parse(JSON.stringify(flow));
    generateSpecFromFlow(flow);
    expect(flow).toEqual(snapshot);
  });

  test("golden output for a full form-submission flow", () => {
    const expected = [
      'import { test, expect } from "@playwright/test";',
      "",
      'test("Form submission on Login  Acme staging", async ({ page }) => {',
      "  // Navigate to https://app.example.com/login",
      '  await page.goto("https://app.example.com/login");',
      '  await page.waitForLoadState("domcontentloaded");',
      "  await expect(page).toHaveURL(/\\/login.*/);",
      "  // Fill: Fill Email field",
      '  await page.locator("#email").fill("test@example.com");',
      "  // Fill: Fill password field",
      "  await page.locator('[name=\"password\"]').fill(\"pa\\\"ss\");",
      "  // Click: Submit the form",
      '  await page.getByRole("button", { name: /\\[type=submit\\], input\\[type=submit\\]/i }).click();',
      '  await page.waitForLoadState("domcontentloaded");',
      "  // Wait for navigation: Expect redirect to https://app.example.com/dashboard",
      "  await expect(page).toHaveURL(/\\/dashboard.*/, { timeout: 10_000 });",
      "});",
      "",
    ].join("\n");

    expect(generateSpecFromFlow(loginFlow())).toBe(expected);
  });

  test("generated specs never contain LLM calls or network fetches", () => {
    const spec = generateSpecFromFlow(loginFlow());
    for (const forbidden of ["fetch(", "anthropic", "openai", "api_key", "apiKey"]) {
      expect(spec).not.toContain(forbidden);
    }
  });
});

test.describe("generateSpecFromFlow — step emission", () => {
  test("navigate emits goto + explicit wait + URL assertion", () => {
    const spec = generateSpecFromFlow(singleStepFlow("navigate", "https://s.io/pricing"));
    expect(spec).toContain('await page.goto("https://s.io/pricing");');
    expect(spec).toContain('await page.waitForLoadState("domcontentloaded");');
    expect(spec).toContain("await expect(page).toHaveURL(/\\/pricing.*/);");
  });

  test("click waits for the load state after clicking", () => {
    const spec = generateSpecFromFlow(singleStepFlow("click", "#go"));
    const clickIdx = spec.indexOf('await page.locator("#go").click();');
    const waitIdx = spec.indexOf('await page.waitForLoadState("domcontentloaded");');
    expect(clickIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(clickIdx);
  });

  test("fill escapes double quotes in the value", () => {
    const spec = generateSpecFromFlow(singleStepFlow("fill", "#name", 'Bob "The Builder"'));
    expect(spec).toContain('.fill("Bob \\"The Builder\\"");');
  });

  test("fill defaults to a test value when none is provided", () => {
    const spec = generateSpecFromFlow(singleStepFlow("fill", "input.qty"));
    expect(spec).toContain('await page.locator("input.qty").fill("test");');
  });

  test("submit presses Enter on the target", () => {
    const spec = generateSpecFromFlow(singleStepFlow("submit", "#f"));
    expect(spec).toContain('await page.locator("#f").press("Enter");');
  });

  test("wait asserts the new URL with a timeout when the target differs", () => {
    const spec = generateSpecFromFlow(
      makeFlow({
        steps: [
          { action: "navigate", target: "https://x.dev/a", pageUrl: "https://x.dev/a", description: "n" },
          { action: "wait", target: "https://x.dev/b", pageUrl: "https://x.dev/b", description: "w" },
        ],
      })
    );
    expect(spec).toContain("await expect(page).toHaveURL(/\\/b.*/, { timeout: 10_000 });");
    expect(spec).not.toContain("waitForTimeout");
  });

  test("wait falls back to a fixed pause when the URL does not change", () => {
    const spec = generateSpecFromFlow(
      makeFlow({
        steps: [
          { action: "navigate", target: "https://x.dev/a", pageUrl: "https://x.dev/a", description: "n" },
          { action: "wait", target: "https://x.dev/a", pageUrl: "https://x.dev/a", description: "same" },
        ],
      })
    );
    expect(spec).toContain("await page.waitForTimeout(1000);");
  });

  test("strips special characters from the test name and caps it at 60 chars", () => {
    const flow = makeFlow({ name: "Sign-up! flow // with $pecial chars & a very long name ".repeat(3), steps: [] });
    const spec = generateSpecFromFlow(flow);
    const match = spec.match(/^test\("([^"]*)"/m);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeLessThanOrEqual(60);
    expect(match![1]).toMatch(/^[a-zA-Z0-9 ]*$/);
  });
});

test.describe("generateSpecFromFlow — selector strategy (role/label > testid > CSS)", () => {
  const cases: Array<{ target: string; locator: string }> = [
    {
      target: '[data-testid="save-btn"]',
      locator: 'page.getByTestId("save-btn")',
    },
    {
      target: '[aria-label="Close dialog"]',
      locator: 'page.getByLabel("Close dialog")',
    },
    {
      target: "link Home page",
      locator: 'page.getByRole("link", { name: /Home page/i })',
    },
    {
      target: "#submit",
      locator: 'page.locator("#submit")',
    },
    {
      target: "Sign up now", // bare text on a click step → text locator
      locator: 'page.getByText("Sign up now")',
    },
  ];

  for (const { target, locator } of cases) {
    test(`click target ${JSON.stringify(target)} → ${locator}`, () => {
      const spec = generateSpecFromFlow(singleStepFlow("click", target));
      expect(spec).toContain(`await ${locator}.click();`);
    });
  }

  test('fill target [name="qty"] → attribute locator', () => {
    const spec = generateSpecFromFlow(singleStepFlow("fill", '[name="qty"]'));
    expect(spec).toContain("await page.locator('[name=\"qty\"]').fill(\"test\");");
  });

  test("KNOWN QUIRK: the explorer's CSS submit-button selector becomes a role name regex", () => {
    // discoverFlows emits `button[type=submit], input[type=submit]` as the click
    // target. Because it starts with "button", the generator treats the CSS text
    // as an accessible name — producing a locator that can't match a real button.
    // This characterizes today's behavior; fixing it means teaching selectorForStep
    // to recognize CSS selector unions before the role heuristic.
    const spec = generateSpecFromFlow(
      singleStepFlow("click", "button[type=submit], input[type=submit]")
    );
    expect(spec).toContain(
      'await page.getByRole("button", { name: /\\[type=submit\\], input\\[type=submit\\]/i }).click();'
    );
  });
});

test.describe("generateAllSpecs", () => {
  test("attaches a spec to every flow without mutating the originals", () => {
    const flows = [loginFlow(), singleStepFlow("click", "#a")];
    const result = generateAllSpecs(flows);

    expect(result).toHaveLength(2);
    expect(result[0].generatedSpec).toBe(generateSpecFromFlow(flows[0]));
    expect(result[1].generatedSpec).toBe(generateSpecFromFlow(flows[1]));
    // Original flow objects are left untouched.
    expect(flows[0].generatedSpec).toBeUndefined();
    expect(flows[1].generatedSpec).toBeUndefined();
    // Non-spec fields are preserved.
    expect(result[0].name).toBe(flows[0].name);
    expect(result[0].steps).toEqual(flows[0].steps);
  });

  test("is deterministic across invocations", () => {
    const specsA = generateAllSpecs([loginFlow()]).map((f) => f.generatedSpec);
    const specsB = generateAllSpecs([loginFlow()]).map((f) => f.generatedSpec);
    expect(specsA).toEqual(specsB);
  });
});
