/**
 * Test Generator — turns discovered UserFlows into deterministic Playwright specs.
 * v1: LLM-powered generation (via agent.ts)
 * v0 fallback: template-based generation from flow steps.
 *
 * The determinism layer per WEBQA_AGENT_PLAN.md:
 * - role/label > testid > CSS selector strategy
 * - wait conditions before assertions
 * - no LLM calls inside generated specs
 */

import type { UserFlow, FlowStep } from "./types.js";

const SELECTOR_PRIORITY = [
  "getByRole",
  "getByLabel",
  "getByTestId",
  "getByText",
  "getByPlaceholder",
] as const;

/**
 * Generate a deterministic Playwright spec from a flow (no LLM).
 * This is the v0 template approach — v1 uses Claude for smarter generation.
 */
export function generateSpecFromFlow(flow: UserFlow): string {
  const lines: string[] = [];
  const testName = flow.name.replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 60);

  lines.push(`import { test, expect } from "@playwright/test";`);
  lines.push("");
  lines.push(`test("${testName}", async ({ page }) => {`);

  let lastUrl = "";

  for (const step of flow.steps) {
    const indent = "  ";

    switch (step.action) {
      case "navigate": {
        lines.push(`${indent}// Navigate to ${step.target}`);
        lines.push(`${indent}await page.goto("${step.target}");`);
        lines.push(
          `${indent}await page.waitForLoadState("domcontentloaded");`
        );
        if (step.target) {
          const expectedUrl = new URL(step.target);
          lines.push(
            `${indent}await expect(page).toHaveURL(/${expectedUrl.pathname.replace(/\//g, "\\/")}.*/);`
          );
        }
        lastUrl = step.target || "";
        break;
      }

      case "click": {
        const locator = selectorForStep(step);
        lines.push(`${indent}// Click: ${step.description}`);
        lines.push(`${indent}await ${locator}.click();`);
        lines.push(
          `${indent}await page.waitForLoadState("domcontentloaded");`
        );
        break;
      }

      case "fill": {
        const locator = selectorForStep(step);
        const escapedValue = (step.value || "test").replace(/"/g, '\\"');
        lines.push(`${indent}// Fill: ${step.description}`);
        lines.push(`${indent}await ${locator}.fill("${escapedValue}");`);
        break;
      }

      case "submit": {
        const locator = selectorForStep(step);
        lines.push(`${indent}// Submit form`);
        lines.push(`${indent}await ${locator}.press("Enter");`);
        lines.push(
          `${indent}await page.waitForLoadState("domcontentloaded");`
        );
        break;
      }

      case "wait": {
        lines.push(`${indent}// Wait for navigation: ${step.description}`);
        if (step.target && step.target !== lastUrl) {
          const targetUrl = new URL(step.target);
          lines.push(
            `${indent}await expect(page).toHaveURL(/${targetUrl.pathname.replace(/\//g, "\\/")}.*/, { timeout: 10_000 });`
          );
          lastUrl = step.target;
        } else {
          lines.push(`${indent}await page.waitForTimeout(1000);`);
        }
        break;
      }
    }
  }

  lines.push("});");
  lines.push("");

  return lines.join("\n");
}

/**
 * Pick the best Playwright locator for a step's target.
 * Follows the determinism strategy: role/label > testid > text > CSS.
 */
function selectorForStep(step: FlowStep): string {
  const target = step.target || "";

  // If target looks like a role-based descriptor
  if (target.startsWith("button")) {
    return `page.getByRole("button", { name: /${escapeRegex(target.replace("button", "").trim())}/i })`;
  }
  if (target.startsWith("link") || target.startsWith("a ")) {
    const name = target.replace(/^(link|a)\s*/i, "").trim();
    return `page.getByRole("link", { name: /${escapeRegex(name)}/i })`;
  }

  // data-testid
  if (target.includes("data-testid")) {
    const match = target.match(/data-testid="([^"]+)"/);
    if (match) return `page.getByTestId("${match[1]}")`;
  }

  // aria-label
  if (target.includes("aria-label")) {
    const match = target.match(/aria-label="([^"]+)"/);
    if (match) return `page.getByLabel("${match[1]}")`;
  }

  // ID selector
  if (target.startsWith("#")) {
    return `page.locator("${target}")`;
  }

  // Text content
  if (step.action === "click" && target) {
    return `page.getByText("${target.slice(0, 50)}")`;
  }

  // name attribute
  if (target.startsWith("[name=")) {
    const match = target.match(/\[name="([^"]+)"\]/);
    if (match) return `page.locator('[name="${match[1]}"]')`;
  }

  // Fallback: CSS selector
  return `page.locator("${target}")`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Batch-generate specs for all non-agentic flows.
 */
export function generateAllSpecs(flows: UserFlow[]): UserFlow[] {
  return flows.map((flow) => ({
    ...flow,
    generatedSpec: generateSpecFromFlow(flow),
  }));
}
