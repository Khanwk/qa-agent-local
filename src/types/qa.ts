export type QaMode = "code" | "ui" | "full" | "supervisor";
export type Severity = "critical" | "high" | "medium" | "low";
export type FindingStatus = "pass" | "fail" | "needs_review";

export type LocatorSpec =
  | { by: "role"; role: string; name?: string; exact?: boolean }
  | { by: "text"; value: string; exact?: boolean }
  | { by: "label"; value: string; exact?: boolean }
  | { by: "placeholder"; value: string; exact?: boolean }
  | { by: "testId"; value: string }
  | { by: "css"; value: string };

export type BrowserStep =
  | { action: "goto"; path: string }
  | { action: "click"; locator?: LocatorSpec; selector?: string }
  | { action: "fill"; locator?: LocatorSpec; selector?: string; value: string }
  | { action: "expect-text"; locator?: LocatorSpec; selector?: string; text: string }
  | { action: "expect-url"; contains: string }
  | { action: "expect-visible"; locator?: LocatorSpec; selector?: string };

interface RequirementBase {
  id: string;
  title: string;
  severity?: Severity;
  source?: string;
  enabled?: boolean;
}

export type Requirement =
  | (RequirementBase & { type: "currency"; currency: string; symbol?: string; forbiddenTokens?: string[]; paths?: string[]; requirePresence?: boolean })
  | (RequirementBase & { type: "route"; path: string; expectText?: string })
  | (RequirementBase & { type: "forbidden-hook-dependency"; identifier: string })
  | (RequirementBase & { type: "text-search"; forbidden?: string[]; required?: string[]; requiredMode?: "all" | "any" })
  | (RequirementBase & { type: "browser-flow"; path?: string; steps: BrowserStep[] })
  | (RequirementBase & { type: "api"; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; expectedStatus?: number; body?: unknown; expectedText?: string })
  | (RequirementBase & { type: "visual"; path: string; fullPage?: boolean; expectText?: string; baselineName?: string; updateBaseline?: boolean })
  | (RequirementBase & { type: "accessibility"; path: string });

export interface QaConfig {
  projectName: string;
  projectPath: string;
  baseUrl?: string;
  mode?: QaMode;
  requirements: Requirement[];
  changedOnly?: boolean;
  gitBase?: string;
}

export interface QaFinding {
  requirementId: string;
  title: string;
  category: "code" | "ui" | "api" | "supervisor" | "visual" | "accessibility" | "system";
  status: FindingStatus;
  severity?: Severity;
  message: string;
  file?: string;
  line?: number;
  evidence?: string;
  screenshot?: string;
  trace?: string;
  baseline?: string;
  triage?: "product_bug" | "test_broken" | "environment" | "requirement_unclear" | "possible_regression";
}

export interface GitChangeSummary {
  base: string;
  files: string[];
  additions: number;
  deletions: number;
  committedFiles: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
}

export interface QaRunResult {
  projectName: string;
  mode: QaMode;
  startedAt: string;
  finishedAt: string;
  filesScanned: number;
  score: number;
  releaseStatus: "ready" | "review_required" | "not_ready";
  findings: QaFinding[];
  git?: GitChangeSummary;
  summary: { passed: number; failed: number; needsReview: number; total: number };
}
