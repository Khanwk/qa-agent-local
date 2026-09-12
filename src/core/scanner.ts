import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ts from "typescript";
import type { QaConfig, QaFinding, QaRunResult, Requirement, Severity } from "../types/qa.js";
import { runBrowserRequirements } from "./browser.js";
import { runApiRequirement } from "./api.js";
import { getGitChanges } from "./git.js";

const SOURCE_PATTERNS = ["**/*.{ts,tsx,js,jsx,json,css,scss,html,mjs,cjs}"];
const IGNORE = ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**", "**/.git/**", "**/coverage/**", "**/.qa-agent/**"];
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalized = (value: string) => value.replaceAll("\\", "/");

type SourceEntry = { file: string; text: string };

function severity(req: Requirement): Severity { return req.severity ?? "medium"; }

async function readSources(root: string, files: string[]): Promise<SourceEntry[]> {
  return Promise.all(files.map(async (file) => ({ file, text: await fs.readFile(path.join(root, file), "utf8") })));
}

function scriptKind(file: string) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hookDependencyFinding(req: Extract<Requirement, { type: "forbidden-hook-dependency" }>, sources: SourceEntry[]): QaFinding | null {
  const hookNames = new Set(["useEffect", "useMemo", "useCallback", "useLayoutEffect"]);
  for (const source of sources) {
    if (!/\.(?:[jt]sx?|mjs|cjs)$/.test(source.file)) continue;
    const sf = ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true, scriptKind(source.file));
    let found: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
        if (hookNames.has(name) && node.arguments.length >= 2) {
          const deps = node.arguments[1];
          if (ts.isArrayLiteralExpression(deps)) {
            for (const item of deps.elements) {
              if (ts.isIdentifier(item) && item.text === req.identifier) { found = item; return; }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found) {
      const position = sf.getLineAndCharacterOfPosition(found.getStart(sf));
      return {
        requirementId: req.id,
        title: req.title,
        category: "code",
        status: "fail",
        severity: severity(req),
        message: `${req.identifier} found in a React hook dependency array.`,
        file: source.file,
        line: position.line + 1,
        evidence: source.text.split(/\r?\n/).slice(Math.max(0, position.line - 1), position.line + 2).join("\n")
      };
    }
  }
  return null;
}

function appRouteFromFile(file: string): string | null {
  const f = normalized(file);
  const marker = f.includes("/src/app/") ? "/src/app/" : f.startsWith("src/app/") ? "src/app/" : f.includes("/app/") ? "/app/" : f.startsWith("app/") ? "app/" : null;
  if (!marker) return null;
  const index = f.indexOf(marker);
  const rel = f.slice(index + marker.length).replace(/\/page\.(?:[jt]sx?|mjs|cjs)$/, "").replace(/^page\.(?:[jt]sx?|mjs|cjs)$/, "");
  if (rel === f || /\/route\.(?:[jt]sx?|mjs|cjs)$/.test(rel)) return null;
  const segments = rel.split("/").filter(Boolean).filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")) && !segment.startsWith("@"))
    .map((segment) => segment.replace(/^\(\.\.\.\)/, "").replace(/^\(\.\.\)/, "").replace(/^\(\.\)/, ""));
  return "/" + segments.join("/");
}

function pagesRouteFromFile(file: string): string | null {
  const f = normalized(file);
  const marker = f.includes("/src/pages/") ? "/src/pages/" : f.startsWith("src/pages/") ? "src/pages/" : f.includes("/pages/") ? "/pages/" : f.startsWith("pages/") ? "pages/" : null;
  if (!marker) return null;
  const index = f.indexOf(marker);
  let rel = f.slice(index + marker.length).replace(/\.(?:[jt]sx?|mjs|cjs)$/, "");
  if (!rel || rel.startsWith("api/") || rel.startsWith("_") || rel === "_app" || rel === "_document") return null;
  rel = rel.replace(/\/index$/, "").replace(/^index$/, "");
  return "/" + rel;
}

function routeMatches(pattern: string, requested: string) {
  const p = pattern.split("/").filter(Boolean);
  const r = requested.split("/").filter(Boolean);
  let pi = 0; let ri = 0;
  while (pi < p.length) {
    const segment = p[pi];
    if (/^\[\.\.\..+\]$/.test(segment) || /^\[\[\.\.\..+\]\]$/.test(segment)) return true;
    if (ri >= r.length) return /^\[\[\.\.\..+\]\]$/.test(segment);
    if (!/^\[.+\]$/.test(segment) && segment !== r[ri]) return false;
    pi++; ri++;
  }
  return ri === r.length;
}

function findRoute(req: Extract<Requirement, { type: "route" }>, files: string[]) {
  const requested = req.path === "/" ? "/" : `/${req.path.replace(/^\/+|\/+$/g, "")}`;
  for (const file of files) {
    const route = appRouteFromFile(file) ?? pagesRouteFromFile(file);
    if (route !== null && routeMatches(route, requested)) return file;
  }
  return null;
}

function tokenIndex(text: string, token: string): number {
  if (token === "$") {
    const standalone = /(["'`])\$\1/.exec(text);
    if (standalone?.index !== undefined) return standalone.index;
    const currency = /\$(?!\{)(?:\s*\d|\s*\$\{)/.exec(text);
    if (currency?.index !== undefined) return currency.index;
    const jsx = />\s*\$\s*</.exec(text);
    return jsx?.index ?? -1;
  }
  if (/^[A-Z]{3}$/i.test(token)) {
    const match = new RegExp(`\\b${escapeRegex(token)}\\b`, "i").exec(text);
    return match?.index ?? -1;
  }
  return text.indexOf(token);
}

function sourceTokenHits(sources: SourceEntry[], tokens: string[]) {
  const hits: { token: string; file: string; line: number }[] = [];
  for (const source of sources) {
    for (const token of tokens) {
      const index = tokenIndex(source.text, token);
      if (index >= 0) hits.push({ token, file: source.file, line: lineOf(source.text, index) });
    }
  }
  return hits;
}

async function codeCheck(req: Requirement, files: string[], sources: SourceEntry[]): Promise<QaFinding | null> {
  if (req.type === "browser-flow" || req.type === "api" || req.type === "visual" || req.type === "accessibility") return null;

  if (req.type === "route") {
    const file = findRoute(req, files);
    return file
      ? { requirementId: req.id, title: req.title, category: "code", status: "pass", severity: severity(req), message: `Route ${req.path} has an implementation file.`, file }
      : { requirementId: req.id, title: req.title, category: "code", status: "fail", severity: severity(req), message: `Could not find a Next.js page implementation for ${req.path}. Route groups and dynamic segments were checked.` };
  }

  if (req.type === "forbidden-hook-dependency") {
    const hit = hookDependencyFinding(req, sources);
    return hit ?? { requirementId: req.id, title: req.title, category: "code", status: "pass", severity: severity(req), message: `No forbidden ${req.identifier} hook dependency found by AST analysis.` };
  }

  if (req.type === "currency") {
    const hits = sourceTokenHits(sources, req.forbiddenTokens ?? []);
    if (hits.length) {
      const first = hits[0];
      return { requirementId: req.id, title: req.title, category: "code", status: "fail", severity: severity(req), message: `Forbidden currency token "${first.token}" found.`, file: first.file, line: first.line, evidence: hits.slice(0, 8).map((x) => `${x.token} @ ${x.file}:${x.line}`).join("\n") };
    }
    const signals = [req.currency, req.symbol].filter(Boolean) as string[];
    const hasExpectedSignal = sources.some((source) => signals.some((signal) => tokenIndex(source.text, signal) >= 0));
    return hasExpectedSignal
      ? { requirementId: req.id, title: req.title, category: "code", status: "pass", severity: severity(req), message: `No forbidden currency tokens found and ${req.currency} configuration was detected.` }
      : { requirementId: req.id, title: req.title, category: "code", status: "needs_review", severity: severity(req), message: `No forbidden currency token was found, but ${signals.join(" / ")} was not detected in source. Runtime verification is required.` };
  }

  const hits = sourceTokenHits(sources, req.forbidden ?? []);
  if (hits.length) {
    const first = hits[0];
    return { requirementId: req.id, title: req.title, category: "code", status: "fail", severity: severity(req), message: `Forbidden token "${first.token}" found.`, file: first.file, line: first.line, evidence: hits.slice(0, 8).map((x) => `${x.token} @ ${x.file}:${x.line}`).join("\n") };
  }

  const required = req.required ?? [];
  const seen = new Set(required.filter((token) => sources.some((source) => source.text.includes(token))));
  const requiredMode = req.requiredMode ?? "all";
  const requiredPass = required.length === 0 || (requiredMode === "all" ? seen.size === required.length : seen.size > 0);
  if (!requiredPass) {
    const missing = required.filter((token) => !seen.has(token));
    return { requirementId: req.id, title: req.title, category: "code", status: "fail", severity: severity(req), message: requiredMode === "all" ? `Missing required token(s): ${missing.join(", ")}.` : `None of the required tokens were found: ${required.join(", ")}.` };
  }
  return { requirementId: req.id, title: req.title, category: "code", status: "pass", severity: severity(req), message: "Requirement passed deterministic source checks." };
}

function addTriage(findings: QaFinding[]) {
  for (const finding of findings) {
    if (finding.status === "pass" || finding.triage) continue;
    if (finding.category === "system") finding.triage = "environment";
    else if (finding.status === "needs_review") finding.triage = "requirement_unclear";
    else if (finding.category === "visual") finding.triage = "possible_regression";
    else if (finding.category === "ui" && /selector|locator|timeout|not found/i.test(finding.message)) finding.triage = "possible_regression";
    else finding.triage = "product_bug";
  }
}

function releaseStatus(findings: QaFinding[]): QaRunResult["releaseStatus"] {
  if (!findings.length || findings.some((x) => x.status === "fail") || findings.some((x) => x.status === "needs_review" && x.severity === "critical")) return "not_ready";
  if (findings.some((x) => x.status === "needs_review")) return "review_required";
  return "ready";
}

export async function runQa(config: QaConfig): Promise<QaRunResult> {
  const startedAt = new Date().toISOString();
  const mode = config.mode ?? "full";
  const enabledRequirements = (config.requirements ?? []).filter((req) => req.enabled !== false);
  let git;
  let files = await fg(SOURCE_PATTERNS, { cwd: config.projectPath, ignore: IGNORE, onlyFiles: true, dot: false });
  files = files.map(normalized);

  if (mode === "supervisor" || config.changedOnly) {
    git = await getGitChanges(config.projectPath, config.gitBase || "HEAD~1");
    if (config.changedOnly && git.files.length) {
      const allowed = new Set(git.files.map(normalized));
      files = files.filter((file) => allowed.has(file));
    }
  }

  const sources = await readSources(config.projectPath, files);
  const findings: QaFinding[] = [];

  if (enabledRequirements.length === 0) {
    findings.push({ requirementId: "SYSTEM-REQUIREMENTS", title: "Requirements configured", category: "system", status: "needs_review", severity: "critical", message: "No enabled requirements are configured. QA cannot approve a release until at least one requirement is tested." });
  }
  if (files.length === 0 && (mode === "code" || mode === "full") && enabledRequirements.some((req) => !["api", "browser-flow", "visual", "accessibility"].includes(req.type))) {
    findings.push({ requirementId: "SYSTEM-SOURCE", title: "Project source files", category: "system", status: "needs_review", severity: "high", message: "No matching source files were available for deterministic code checks." });
  }

  if (mode === "code" || mode === "full" || mode === "supervisor") {
    for (const req of enabledRequirements) {
      const finding = await codeCheck(req, files, sources);
      if (finding) findings.push(finding);
    }
  }

  if (mode === "ui" || mode === "full" || mode === "supervisor") {
    const browserRequirements = enabledRequirements.filter((req) => ["route", "currency", "browser-flow", "visual", "accessibility"].includes(req.type));
    if (browserRequirements.length && !config.baseUrl) {
      findings.push({ requirementId: "SYSTEM-UI", title: "UI test target", category: "system", status: "needs_review", severity: "high", message: "Set a Base URL to run browser checks." });
    } else if (browserRequirements.length && config.baseUrl) {
      findings.push(...await runBrowserRequirements(browserRequirements, config.baseUrl, config.projectPath));
    } else if (mode === "ui") {
      findings.push({ requirementId: "SYSTEM-UI-RULES", title: "UI requirements", category: "system", status: "needs_review", severity: "medium", message: "No enabled UI/browser requirements are configured for UI QA." });
    }
  }

  if (mode === "full" || mode === "supervisor") {
    for (const req of enabledRequirements) {
      const finding = await runApiRequirement(req, config.baseUrl);
      if (finding) findings.push(finding);
    }
  }

  if (mode === "supervisor") {
    const changed = git?.files.length ?? 0;
    findings.unshift({
      requirementId: "SUPERVISOR",
      title: "Coding-agent change scope",
      category: "supervisor",
      status: changed ? "pass" : "needs_review",
      severity: "high",
      message: changed
        ? `Reviewed ${changed} changed file(s), including working-tree changes, +${git?.additions ?? 0}/-${git?.deletions ?? 0}.`
        : `No committed, staged, unstaged or untracked git changes were found against ${config.gitBase || "HEAD~1"}.`
    });
    if (git?.files.length) {
      const apiTouched = git.files.some((file) => /(api|route|controller|service|server)/i.test(file));
      const typesTouched = git.files.some((file) => /(type|interface|schema|dto)/i.test(file));
      if (apiTouched && !typesTouched) {
        findings.push({ requirementId: "SUPERVISOR-API-TYPES", title: "API/type synchronization", category: "supervisor", status: "needs_review", severity: "high", message: "API/server files changed but no obvious type/schema file changed. Verify frontend contracts were not left stale.", evidence: git.files.filter((file) => /(api|route|controller|service|server)/i.test(file)).slice(0, 8).join("\n") });
      }
    }
  }

  addTriage(findings);
  const passed = findings.filter((x) => x.status === "pass").length;
  const failed = findings.filter((x) => x.status === "fail").length;
  const needsReview = findings.filter((x) => x.status === "needs_review").length;
  const total = findings.length;
  const score = total ? Math.round((passed / total) * 100) : 0;

  return {
    projectName: config.projectName,
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    filesScanned: files.length,
    score,
    releaseStatus: releaseStatus(findings),
    findings,
    git,
    summary: { passed, failed, needsReview, total }
  };
}
