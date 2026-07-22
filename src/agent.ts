/**
 * Agentic explorer — LLM-driven page exploration.
 * Uses the accessibility tree + screenshots to decide what to interact with next.
 * v1 implementation per WEBQA_AGENT_PLAN.md.
 *
 * Provider-agnostic: supports Anthropic, OpenAI, and any OpenAI-compatible
 * endpoint (DeepSeek, Ollama, Groq, Gemini, etc.) — set via AGENT_PROVIDER
 * env or `provider` in AgentConfig.
 */

import type { Page, BrowserContext } from "playwright";
import type { PageNode, PageElement, UserFlow, FlowStep, LLMCall } from "./types.js";

export type LLMProvider = "anthropic" | "openai" | "openai-compatible" | "gemini";

export interface AgentConfig {
  /** LLM provider */
  provider?: LLMProvider;
  /** API key (falls back to env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) */
  apiKey?: string;
  /** Model to use */
  model?: string;
  /** Maximum exploration steps per page */
  maxSteps?: number;
  /** Base URL (for openai-compatible providers like DeepSeek, Ollama) */
  baseUrl?: string;
}

const DEFAULT_CONFIG: Required<Omit<AgentConfig, "apiKey" | "baseUrl">> & {
  apiKey: string;
  baseUrl: string;
} = {
  provider: (process.env["AGENT_PROVIDER"] as LLMProvider) || "openai-compatible",
  apiKey: "",
  model: process.env["AGENT_MODEL"] || "deepseek-chat",
  maxSteps: 20,
  baseUrl: process.env["AGENT_BASE_URL"] || "https://api.deepseek.com/v1",
};

// ─── Provider presets (cost-optimized) ───

const PROVIDER_PRESETS: Record<
  string,
  { baseUrl: string; model: string; apiKeyEnv: string }
> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5-20251001",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  "openai-compatible": {
    baseUrl: process.env["AGENT_BASE_URL"] || "https://api.deepseek.com/v1",
    model: process.env["AGENT_MODEL"] || "deepseek-chat",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  gemini: {
    baseUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: process.env["AGENT_MODEL"] || "gemini-2.0-flash",
    apiKeyEnv: "GEMINI_API_KEY",
  },
};

export interface AgentAction {
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
  const cfg = resolveConfig(config);
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
    const axTree = await (page as any).accessibility?.snapshot({
      interestingOnly: true,
    });
    const axSummary = summarizeAxTree(axTree, 3);

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

    const prompt = buildExplorerPrompt(
      currentUrl,
      axSummary,
      steps,
      i,
      cfg.maxSteps
    );
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
      name: `Agent-discovered flow on ${
        new URL(currentUrl).pathname || "/"
      }`,
      steps: [...steps],
    });
  }

  return { flows, calls };
}

/**
 * Generate Playwright test specs from agent-discovered flows.
 */
export async function generateTestsFromFlows(
  flows: UserFlow[],
  config: AgentConfig
): Promise<{ flows: UserFlow[]; calls: LLMCall[] }> {
  const cfg = resolveConfig(config);
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

// ─── Config resolution ───

function resolveConfig(config: AgentConfig): Required<AgentConfig> {
  const provider = config.provider || DEFAULT_CONFIG.provider;
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS["openai-compatible"];
  return {
    provider: provider as LLMProvider,
    apiKey:
      config.apiKey ||
      process.env[preset.apiKeyEnv] ||
      DEFAULT_CONFIG.apiKey,
    model: config.model || preset.model,
    maxSteps: config.maxSteps ?? DEFAULT_CONFIG.maxSteps,
    baseUrl: config.baseUrl || preset.baseUrl,
  };
}

// ─── LLM helpers (provider-agnostic) ───

async function callLLM(
  prompt: string,
  config: Required<AgentConfig>
): Promise<LLMCall> {
  const startTime = Date.now();

  if (config.provider === "anthropic") {
    return callAnthropic(prompt, config, startTime);
  }
  // openai, openai-compatible, gemini all use the chat/completions format
  return callOpenAICompatible(prompt, config, startTime);
}

async function callAnthropic(
  prompt: string,
  config: Required<AgentConfig>,
  startTime: number
): Promise<LLMCall> {
  const response = await fetch(`${config.baseUrl}/messages`, {
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
    throw new Error(
      `LLM API error ${response.status} (${config.provider}): ${errText.slice(0, 300)}`
    );
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const latencyMs = Date.now() - startTime;
  const tokensIn = data.usage?.input_tokens || 0;
  const tokensOut = data.usage?.output_tokens || 0;
  const cost = estimateCost(config.provider, config.model, tokensIn, tokensOut);

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

async function callOpenAICompatible(
  prompt: string,
  config: Required<AgentConfig>,
  startTime: number
): Promise<LLMCall> {
  let url: string;
  let headers: Record<string, string>;

  if (config.provider === "gemini") {
    // Gemini has its own OpenAI-compatible endpoint
    url = `${config.baseUrl}`;
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
  } else {
    url = `${config.baseUrl}/chat/completions`;
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      max_tokens: 2048,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "You are an autonomous web QA agent. Output ONLY the requested JSON — no markdown, no explanation.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `LLM API error ${response.status} (${config.provider}): ${errText.slice(0, 300)}`
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const latencyMs = Date.now() - startTime;
  const tokensIn = data.usage?.prompt_tokens || 0;
  const tokensOut = data.usage?.completion_tokens || 0;
  const cost = estimateCost(config.provider, config.model, tokensIn, tokensOut);

  return {
    model: config.model,
    prompt: prompt.slice(0, 500),
    response: data.choices[0]?.message?.content || "",
    tokensIn,
    tokensOut,
    cost,
    latencyMs,
  };
}

/** Estimate LLM call cost in USD from token counts. (Exported for unit tests.) */
export function estimateCost(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  // Pricing per 1M tokens (input, output). Updated July 2026.
  const rates: Record<string, { in: number; out: number }> = {
    // Anthropic
    "claude-haiku-4-5-20251001": { in: 0.8, out: 4.0 },
    "claude-haiku-4-5": { in: 0.8, out: 4.0 },
    "claude-sonnet-5": { in: 3.0, out: 15.0 },
    "claude-opus-4-8": { in: 15.0, out: 75.0 },
    "claude-fable-5": { in: 25.0, out: 100.0 },
    // OpenAI
    "gpt-4o-mini": { in: 0.15, out: 0.6 },
    "gpt-4o": { in: 2.5, out: 10.0 },
    // DeepSeek
    "deepseek-chat": { in: 0.14, out: 0.28 },
    "deepseek-reasoner": { in: 0.55, out: 2.19 },
    // Gemini (free tier available)
    "gemini-2.0-flash": { in: 0.0, out: 0.0 },
    "gemini-2.0-flash-lite": { in: 0.0, out: 0.0 },
    // Ollama (local — free)
    "llama3.2": { in: 0.0, out: 0.0 },
  };

  const rate = rates[model];
  if (!rate) {
    // Unknown model — assume cheapest tier
    return (tokensIn * 0.14 + tokensOut * 0.28) / 1_000_000;
  }
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
    .map(
      (s, i) =>
        `${i + 1}. ${s.action}: ${s.description} (${s.target || ""})`
    )
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

/** Parse the LLM's JSON action from a raw response. (Exported for unit tests.) */
export function parseAction(response: string): AgentAction | null {
  try {
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
        description:
          action.reasoning || `Fill ${selector} with "${action.value}"`,
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

/** Extract a fenced code block of the given language. (Exported for unit tests.) */
export function extractCodeBlock(text: string, lang: string): string | null {
  const re = new RegExp(
    `\`\`\`${lang}\\n?([\\s\\S]*?)\`\`\``,
    "i"
  );
  const match = text.match(re);
  return match ? match[1].trim() : null;
}
