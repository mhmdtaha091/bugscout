// ─── Shared types for BugScout (Web QA Agent) ───

/** A page discovered during crawling */
export interface PageNode {
  url: string;
  title: string;
  /** Interactive elements found on this page */
  elements: PageElement[];
  /** Outgoing links (same-origin only) */
  links: string[];
  /** Forms detected on this page */
  forms: FormInfo[];
  /** Screenshot path (relative to report dir) */
  screenshot?: string;
}

/** An interactive element on a page */
export interface PageElement {
  selector: string;
  tag: string;
  text: string;
  role: string;
  /** Whether this element triggers navigation */
  triggersNavigation: boolean;
}

/** A form detected on a page */
export interface FormInfo {
  selector: string;
  action: string;
  method: string;
  fields: FormField[];
  submitButton?: string;
}

export interface FormField {
  name: string;
  type: string;
  required: boolean;
  selector: string;
  label?: string;
}

/** A discovered user flow */
export interface UserFlow {
  name: string;
  steps: FlowStep[];
  /** The generated Playwright spec (v1+) */
  generatedSpec?: string;
  /** Whether the generated spec passes self-validation */
  specPasses?: boolean;
}

export interface FlowStep {
  action: "navigate" | "click" | "fill" | "submit" | "wait" | "done" | "back";
  target?: string;
  value?: string;
  pageUrl: string;
  description: string;
}

/** A bug finding */
export interface BugFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: "console_error" | "network_error" | "broken_link" | "a11y" | "layout" | "dead_button" | "form_validation" | "other";
  title: string;
  description: string;
  url: string;
  /** Selector or element reference */
  location?: string;
  /** Evidence: screenshot path, console log excerpt, network response */
  evidence?: string;
  /** Steps to reproduce */
  reproduction?: string[];
}

/** The complete flow map of a site */
export interface FlowMap {
  baseUrl: string;
  pages: Map<string, PageNode>;
  edges: Array<{ from: string; to: string; label: string }>;
  flows: UserFlow[];
}

/** Explorer configuration */
export interface ExplorerConfig {
  baseUrl: string;
  maxPages: number;
  maxDepth: number;
  sameOrigin: boolean;
  captureScreenshots: boolean;
  /** Output directory for reports and screenshots */
  outputDir: string;
  /** Timeout per page in ms */
  pageTimeout: number;
  /** Whether to run in headless mode */
  headless: boolean;
}

/** Options for the full scan pipeline */
export interface ScanOptions {
  url: string;
  output?: string;
  maxPages?: number;
  headless?: boolean;
  /** v1+ */
  agentic?: boolean;
  generateTests?: boolean;
  /** Timeout in seconds */
  timeout?: number;
}

/** LLM call record (for agentic mode, v1+) */
export interface LLMCall {
  model: string;
  prompt: string;
  response: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  latencyMs: number;
}

/** A complete scan result */
export interface ScanResult {
  flowMap: FlowMap;
  bugs: BugFinding[];
  generatedTests: UserFlow[];
  stats: ScanStats;
  reportPath: string;
}

export interface ScanStats {
  pagesCrawled: number;
  bugsFound: number;
  flowsDiscovered: number;
  testsGenerated: number;
  durationMs: number;
  llmCalls: LLMCall[];
  totalCost: number;
}
