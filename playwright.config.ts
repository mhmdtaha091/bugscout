import { defineConfig } from "@playwright/test";

/**
 * Unit-test configuration.
 *
 * These tests exercise BugScout's pure logic — spec generation, bug
 * classifiers, link extraction, report/diff formatting. No browser is
 * launched and no network is touched, so `npx playwright install` is
 * not required to run them.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"]],
});
