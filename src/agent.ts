/**
 * Agentic explorer — LLM-driven page exploration.
 * Uses the accessibility tree + screenshots to decide what to interact with next.
 * v1 implementation per WEBQA_AGENT_PLAN.md.
 */

import type { Page, BrowserContext } from "playwright";
import type { PageNode, PageElement, UserFlow, FlowStep, LLMCall } from "./types.js";

export interface AgentConfig {
  /** Claude API key */
  apiKey: string;
  /** Model to use for decision-making */
  model: string;
  /** Maximum exploration steps per page */
  maxSteps: number;
  /** Base URL for Claude API */
  baseUrl?: string;
}

const DEFAULT_CONFIG: Partial<AgentConfig> = {
  model: "claude-sonnet-5",
  maxSteps: 20,
};

interface AgentAction {
  action: "click" | "fill" | "navigate" | "done" | "back";
  selector?: string;
  value?: string;
  url?: string;
  reasoning: string;
}

/**
 * Explore a page agentically — the LLM looks at the accessibility tree and decides
 * what to interact with to discover multi-step flows.
 */
export async function explorePageAgentically(
  page: Page,
  context: BrowserContext,
  config: AgentConfig
): Promise<{ flows: UserFlow[]; calls: LLMCall[] }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const calls: LLMCall[] = [];
  const flows: UserFlow[] = [];
  const steps: FlowStep[] = [];
  const visitedStates = new Set<string>();
  let currentUrl = page.url();

  steps.push({
    action: "navigate",
    target: currentUrl,
    pageUrl: currentUrl,
    description: `Start exploration at ${currentUrl}`,
  });

  for (let i = 0; i < cfg.maxSteps; i++) {
    // Get the accessibility tree snapshot
    const axTree = await (page as any).accessibility?.snapshot({ interestingOnly: true });
    const axSummary = summarizeAxTree(axTree, 3);

    // Hash the state to detect loops
    const stateHash = hashState(currentUrl, axSummary);
    if (visitedStates.has(stateHash)) {
      steps.push({
        action: "done",
        pageUrl: currentUrl,
        description: "Already visited this state — exploration complete",
      });
      break;
    }
    visitedStates.add(stateHash);

    // Ask the LLM what to do next
    const prompt = buildExplorerPrompt(currentUrl, axSummary, steps, i, cfg.maxSteps);
    const llmResponse = await callLLM(prompt, cfg);
    calls.push(llmResponse);

    const action = parseAction(llmResponse.response);
    if (!action || action.action === "done" || action.action === "back") {
      if (action?.action === "back") {
        steps.push({
          action: "click",
          target: "browser back",
          pageUrl: currentUrl,
          description: "Go back to previous page",
        });
        await page.goBack();
      }
      break;
    }

    // Execute the action
    try {
      const step = await executeAction(page, action, currentUrl);
      steps.push(step);
      currentUrl = page.url();
    } catch (err) {
      steps.push({
        action: "wait",
        pageUrl: currentUrl,
        description: `Action failed: ${(err as Error).message}. Skipping.`,
      });
    }
  }

  if (steps.length > 1) {
    flows.push({
      name: `Agent-discovered flow on ${new URL(currentUrl).pathname || "/"}`,
      steps: [...steps],
    });
  }

  return { flows, calls };
}

/**
 * Generate Playwright test specs from agent-discovered flows.
 * Uses Claude to emit deterministic Playwright code.
 */
export async function generateTestsFromFlows(
  flows: UserFlow[],
  config: AgentConfig
): Promise<{ flows: UserFlow[]; calls: LLMCall[] }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const calls: LLMCall[] = [];
  const updatedFlows: UserFlow[] = [];

  for (const flow of flows) {
    const prompt = buildTestGenPrompt(flow);
    const llmResponse = await callLLM(prompt, cfg);
    calls.push(llmResponse);

    const spec = extractCodeBlock(llmResponse.response, "typescript");
    updatedFlows.push({
      ...flow,
      generatedSpec: spec || llmResponse.response,
    });
  }

  return { flows: updatedFlows, calls };
}

// ─── LLM helpers ───

async function callLLM(prompt: string, config: AgentConfig): Promise<LLMCall> {
  const startTime = Date.now();
  const baseUrl = config.baseUrl || "https://api.anthropic.com/v1";

  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const latencyMs = Date.now() - startTime;
  const tokensIn = data.usage?.input_tokens || 0;
  const tokensOut = data.usage?.output_tokens || 0;
  const cost = estimateCost(config.model, tokensIn, tokensOut);

  return {
    model: config.model,
    prompt: prompt.slice(0, 500),
    response: data.content[0]?.text || "",
    tokensIn,
    tokensOut,
    cost,
    latencyMs,
  };
}

function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  // Claude API pricing as of July 2026
  const rates: Record<string, { in: number; out: number }> = {
    "claude-haiku-4-5-20251001": { in: 0.80, out: 4.0 },
    "claude-sonnet-5": { in: 3.0, out: 15.0 },
    "claude-opus-4-8": { in: 15.0, out: 75.0 },
    "claude-fable-5": { in: 25.0, out: 100.0 },
  };
  const rate = rates[model] || { in: 3.0, out: 15.0 };
  return (tokensIn * rate.in + tokensOut * rate.out) / 1_000_000;
}

// ─── Prompt builders ───

function buildExplorerPrompt(
  url: string,
  axSummary: string,
  steps: FlowStep[],
  stepIndex: number,
  maxSteps: number
): string {
  const stepsDesc = steps
    .map((s, i) => `${i + 1}. ${s.action}: ${s.description}`)
    .join("\n");

  return `You are an autonomous web QA agent exploring a web application. Your goal is to discover user flows by interacting with the page.

Current URL: ${url}
Steps taken so far (${stepIndex + 1}/${maxSteps}):
${stepsDesc || "(none — starting exploration)"}

Accessibility tree of the current page:
\`\`\`
${axSummary.slice(0, 4000)}
\`\`\`

Decide the next action. Output a JSON object with:
- "action": one of "click", "fill", "navigate", "back", "done"
- "selector": CSS selector or accessibility label of the element to interact with (for click/fill)
- "value": value to type (for fill action only)
- "reasoning": brief explanation (one sentence)

Prefer interactive elements (buttons, links, form inputs) that navigate to new pages or reveal new UI. Avoid destructive actions (delete, logout, purchase). If you've explored all obvious interactions, use "done".

Respond with ONLY the JSON object, no markdown.`;
}

function buildTestGenPrompt(flow: UserFlow): string {
  const stepsDesc = flow.steps
    .map((s, i) => `${i + 1}. ${s.action}: ${s.description} (${s.target || ""})`)
    .join("\n");

  return `You are a Playwright test generator. Given a user flow, generate a deterministic, production-quality Playwright test in TypeScript.

Flow: "${flow.name}"
Steps:
${stepsDesc}

Requirements:
- Use @playwright/test syntax: test('...', async ({ page }) => { ... })
- Prefer role/label selectors: page.getByRole(), page.getByLabel(), page.getByText()
- Fall back to data-testid, then CSS selectors only if necessary
- Include waitForURL or waitForSelector for navigation assertions
- Add meaningful assertions (expect title, URL, element visibility, text content)
- The test must be self-contained — no LLM calls, no external state
- Handle potential loading states with waitForLoadState
- Use only one test() block unless the flow has clear sub-flows

Output ONLY the TypeScript code block, no explanation.`;
}

// ─── Action parsing and execution ───

function parseAction(response: string): AgentAction | null {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.action) return null;
    return parsed as AgentAction;
  } catch {
    return null;
  }
}

async function executeAction(
  page: Page,
  action: AgentAction,
  currentUrl: string
): Promise<FlowStep> {
  switch (action.action) {
    case "click": {
      const selector = action.selector || "a:visible";
      await page.click(selector, { timeout: 5_000 });
      return {
        action: "click",
        target: selector,
        pageUrl: currentUrl,
        description: action.reasoning || `Click ${selector}`,
      };
    }
    case "fill": {
      const selector = action.selector || "input:visible";
      await page.fill(selector, action.value || "test", { timeout: 5_000 });
      return {
        action: "fill",
        target: selector,
        value: action.value || "test",
        pageUrl: currentUrl,
        description: action.reasoning || `Fill ${selector} with "${action.value}"`,
      };
    }
    case "navigate": {
      if (action.url) {
        await page.goto(action.url, { waitUntil: "domcontentloaded" });
      }
      return {
        action: "navigate",
        target: action.url,
        pageUrl: action.url || currentUrl,
        description: action.reasoning || `Navigate to ${action.url}`,
      };
    }
    default:
      return {
        action: "wait",
        pageUrl: currentUrl,
        description: `Unknown action: ${action.action}`,
      };
  }
}

// ─── Utilities ───

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
  if (node.name) result += ` "${node.name.slice(0, 60)}"`;
  if (node.value !== undefined) result += ` = ${node.value}`;
  result += "\n";
  if (node.children) {
    for (const child of node.children) {
      result += summarizeAxTree(child, maxDepth, depth + 1);
    }
  }
  return result;
}

function hashState(url: string, axSummary: string): string {
  let hash = 0;
  const str = url + axSummary.slice(0, 200);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function extractCodeBlock(text: string, lang: string): string | null {
  const re = new RegExp(`\`\`\`${lang}\\n?([\\s\\S]*?)\`\`\``, "i");
  const match = text.match(re);
  return match ? match[1].trim() : null;
}
