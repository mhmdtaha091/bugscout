/**
 * Unit tests for the agent's pure helpers: LLM response parsing (action
 * JSON, code-block extraction) and cost estimation. The agentic loop
 * itself needs a live browser + LLM endpoint and is not covered here.
 */
import { test, expect } from "@playwright/test";
import { parseAction, extractCodeBlock, estimateCost } from "../src/agent.js";

// ─── parseAction ───

test.describe("parseAction", () => {
  test("parses a clean JSON action", () => {
    expect(parseAction('{"action":"click","selector":"#go","reasoning":"r"}')).toEqual({
      action: "click",
      selector: "#go",
      reasoning: "r",
    });
  });

  test("extracts the JSON object even when wrapped in prose", () => {
    const response = 'Sure! Here is my decision: {"action":"fill","selector":"#q","value":"cats","reasoning":"search"} Hope that helps.';
    expect(parseAction(response)).toEqual({
      action: "fill",
      selector: "#q",
      value: "cats",
      reasoning: "search",
    });
  });

  test("returns null when the response contains no JSON", () => {
    expect(parseAction("I would click the login button.")).toBeNull();
  });

  test("returns null when the JSON has no action field", () => {
    expect(parseAction('{"selector":"#x"}')).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseAction("{bad json}")).toBeNull();
  });

  test("KNOWN LIMITATION: two JSON objects in one response defeat the greedy match", () => {
    // The `{[\s\S]*}` regex spans from the first "{" to the last "}", so two
    // objects concatenate into invalid JSON and parsing bails to null. The
    // agentic loop then treats this as "done". Characterizes current behavior.
    expect(parseAction('{"action":"click"} and {"action":"fill"}')).toBeNull();
  });
});

// ─── extractCodeBlock ───

test.describe("extractCodeBlock", () => {
  test("extracts a fenced block of the requested language", () => {
    const text = "Here you go:\n```typescript\nconst a = 1;\n```\nEnjoy!";
    expect(extractCodeBlock(text, "typescript")).toBe("const a = 1;");
  });

  test("matches the language tag case-insensitively", () => {
    expect(extractCodeBlock("```TypeScript\nlet b;\n```", "typescript")).toBe("let b;");
  });

  test("returns the first block when several are present", () => {
    const text = "```typescript\nfirst();\n```\n\n```typescript\nsecond();\n```";
    expect(extractCodeBlock(text, "typescript")).toBe("first();");
  });

  test("returns null when no matching block exists", () => {
    expect(extractCodeBlock("no code here", "typescript")).toBeNull();
    expect(extractCodeBlock("```python\nprint(1)\n```", "typescript")).toBeNull();
  });
});

// ─── estimateCost ───

test.describe("estimateCost", () => {
  test("prices known models from the rate table", () => {
    // deepseek-chat: $0.14/M in, $0.28/M out
    expect(estimateCost("openai-compatible", "deepseek-chat", 1_000_000, 1_000_000)).toBeCloseTo(0.42, 10);
    // claude-haiku-4-5: $0.80/M in, $4.00/M out
    expect(estimateCost("anthropic", "claude-haiku-4-5", 100_000, 50_000)).toBeCloseTo(0.28, 10);
  });

  test("free-tier models cost zero", () => {
    expect(estimateCost("gemini", "gemini-2.0-flash", 5_000_000, 5_000_000)).toBe(0);
  });

  test("unknown models fall back to the cheapest tier instead of failing", () => {
    expect(estimateCost("openai", "mystery-model", 1_000_000, 1_000_000)).toBeCloseTo(0.42, 10);
  });

  test("zero tokens cost nothing", () => {
    expect(estimateCost("anthropic", "claude-haiku-4-5", 0, 0)).toBe(0);
  });
});
