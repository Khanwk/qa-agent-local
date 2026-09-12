import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import axe from "axe-core";
import type { LocatorSpec, QaFinding, Requirement, Severity } from "../types/qa.js";

const safeName = (value: string) => value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const reqSeverity = (req: Requirement): Severity => req.severity ?? "medium";

function resolveLocator(page: any, locator?: LocatorSpec, legacySelector?: string): any {
  if (!locator) return legacySelector ? page.locator(legacySelector) : page.locator("body");
  if (locator.by === "role") return page.getByRole(locator.role, { name: locator.name, exact: locator.exact });
  if (locator.by === "text") return page.getByText(locator.value, { exact: locator.exact });
  if (locator.by === "label") return page.getByLabel(locator.value, { exact: locator.exact });
  if (locator.by === "placeholder") return page.getByPlaceholder(locator.value, { exact: locator.exact });
  if (locator.by === "testId") return page.getByTestId(locator.value);
  return page.locator(locator.value);
}

function renderedForbiddenIndex(body: string, token: string) {
  if (token === "$") return /\$\s*(?:\d|[0-9][0-9.,]*)/.test(body);
  if (/^[A-Z]{3}$/i.test(token)) return new RegExp(`\\b${token}\\b`, "i").test(body);
  return body.includes(token);
}

function createRuntimeMonitor(page: any, baseUrl: string) {
  const problems: string[] = [];
  const origin = new URL(baseUrl).origin;
  page.on("pageerror", (error: Error) => problems.push(`Page error: ${error.message}`));
  page.on("console", (message: any) => {
    if (message.type?.() === "error") problems.push(`Console error: ${message.text?.() ?? "Unknown console error"}`);
  });
  page.on("response", (response: any) => {
    try {
      if (response.url().startsWith(origin) && response.status() >= 500) problems.push(`HTTP ${response.status()}: ${response.url()}`);
    } catch {}
  });
  page.on("requestfailed", (request: any) => {
    try {
      if (request.url().startsWith(origin)) problems.push(`Request failed: ${request.url()} (${request.failure()?.errorText ?? "unknown error"})`);
    } catch {}
  });
  return problems;
}

async function accessibilityProblems(page: any): Promise<string[]> {
  await page.addScriptTag({ content: axe.source });
  const violations = await page.evaluate(async () => {
    const runner = (globalThis as any).axe;
    const results = await runner.run((globalThis as any).document, { resultTypes: ["violations"] });
    return results.violations.map((violation: any) => ({
      id: violation.id,
      impact: violation.impact || "unknown",
      help: violation.help,
      nodes: violation.nodes?.length || 0
    }));
  });
  return violations.map((violation: any) => `${violation.impact}: ${violation.id} — ${violation.help} (${violation.nodes} node${violation.nodes === 1 ? "" : "s"})`);
}

async function screenshotFailure(page: any, screenshot: string) {
  try { await page.screenshot({ path: screenshot, fullPage: true }); } catch {}
}

async function runOne(req: Requirement, browser: any, baseUrl: string, projectPath: string): Promise<QaFinding | null> {
  if (!["route", "currency", "browser-flow", "visual", "accessibility"].includes(req.type)) return null;

  const artifactRoot = path.join(projectPath, ".qa-agent");
  const screenshotDir = path.join(artifactRoot, "screenshots");
  const traceDir = path.join(artifactRoot, "traces");
  const baselineDir = path.join(artifactRoot, "baselines");
  await Promise.all([fs.mkdir(screenshotDir, { recursive: true }), fs.mkdir(traceDir, { recursive: true }), fs.mkdir(baselineDir, { recursive: true })]);

  const stem = safeName(req.id);
  const screenshot = path.join(screenshotDir, `${stem}.png`);
  const trace = path.join(traceDir, `${stem}.zip`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const runtimeProblems = createRuntimeMonitor(page, baseUrl);
  let failed = false;

  const finish = async (finding: QaFinding) => {
    if (finding.status === "pass" && runtimeProblems.length) {
      finding.status = "fail";
      finding.message = "The functional check passed, but runtime errors were detected.";
      finding.evidence = runtimeProblems.slice(0, 10).join("\n");
    }
    failed = finding.status === "fail";
    if (failed) {
      await screenshotFailure(page, screenshot);
      finding.screenshot = screenshot;
      try { await context.tracing.stop({ path: trace }); finding.trace = trace; } catch {}
    } else {
      try { await context.tracing.stop(); } catch {}
    }
    await context.close();
    return finding;
  };

  try {
    if (req.type === "route") {
      const response = await page.goto(new URL(req.path, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
      if (!response || response.status() >= 400) throw new Error(`Route returned ${response?.status() ?? "no response"}`);
      if (req.expectText) await page.getByText(req.expectText, { exact: false }).first().waitFor({ state: "visible", timeout: 6000 });
      return finish({ requirementId: req.id, title: req.title, category: "ui", status: "pass", severity: reqSeverity(req), message: `Route ${req.path} loaded successfully in Chromium.` });
    }

    if (req.type === "currency") {
      const paths = req.paths?.length ? req.paths : ["/"];
      const expectedSignals = [req.symbol, req.currency].filter(Boolean) as string[];
      let foundExpected = false;
      for (const targetPath of paths) {
        const response = await page.goto(new URL(targetPath, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
        if (!response || response.status() >= 400) throw new Error(`${targetPath} returned ${response?.status() ?? "no response"}`);
        const body = await page.locator("body").innerText();
        for (const token of req.forbiddenTokens ?? []) {
          if (renderedForbiddenIndex(body, token)) throw new Error(`Forbidden currency token "${token}" rendered on ${targetPath}`);
        }
        if (expectedSignals.some((signal) => body.includes(signal))) foundExpected = true;
      }
      if ((req.requirePresence ?? true) && !foundExpected) {
        return finish({ requirementId: req.id, title: req.title, category: "ui", status: "needs_review", severity: reqSeverity(req), message: `No forbidden currency was rendered, but ${expectedSignals.join(" / ")} was not visible on the configured page(s). Verify that the selected paths actually contain prices.` });
      }
      return finish({ requirementId: req.id, title: req.title, category: "ui", status: "pass", severity: reqSeverity(req), message: `Rendered currency verified on ${paths.length} page(s).` });
    }

    if (req.type === "browser-flow") {
      if (req.path) await page.goto(new URL(req.path, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
      for (const step of req.steps) {
        if (step.action === "goto") await page.goto(new URL(step.path, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
        if (step.action === "click") await resolveLocator(page, step.locator, step.selector).first().click({ timeout: 8000 });
        if (step.action === "fill") await resolveLocator(page, step.locator, step.selector).first().fill(step.value, { timeout: 8000 });
        if (step.action === "expect-text") {
          const target = step.locator || step.selector ? resolveLocator(page, step.locator, step.selector).first() : page.locator("body");
          const text = await target.innerText();
          if (!text.includes(step.text)) throw new Error(`Expected text "${step.text}" was not found.`);
        }
        if (step.action === "expect-url" && !page.url().includes(step.contains)) throw new Error(`Expected URL to contain "${step.contains}", got ${page.url()}`);
        if (step.action === "expect-visible") await resolveLocator(page, step.locator, step.selector).first().waitFor({ state: "visible", timeout: 8000 });
      }
      return finish({ requirementId: req.id, title: req.title, category: "ui", status: "pass", severity: reqSeverity(req), message: `Browser flow completed (${req.steps.length} steps).` });
    }

    if (req.type === "accessibility") {
      const response = await page.goto(new URL(req.path, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 15000 });
      if (!response || response.status() >= 400) throw new Error(`Route returned ${response?.status() ?? "no response"}`);
      const problems = await accessibilityProblems(page);
      return finish(problems.length
        ? { requirementId: req.id, title: req.title, category: "accessibility", status: "fail", severity: reqSeverity(req), message: `${problems.length} accessibility issue group(s) found.`, evidence: problems.join("\n") }
        : { requirementId: req.id, title: req.title, category: "accessibility", status: "pass", severity: reqSeverity(req), message: "axe-core accessibility scan passed with no violations." });
    }

    if (req.type === "visual") {
      const response = await page.goto(new URL(req.path, baseUrl).toString(), { waitUntil: "networkidle", timeout: 20000 });
      if (!response || response.status() >= 400) throw new Error(`Route returned ${response?.status() ?? "no response"}`);
      if (req.expectText) await page.getByText(req.expectText, { exact: false }).first().waitFor({ state: "visible", timeout: 6000 });
      const current = await page.screenshot({ fullPage: req.fullPage ?? true });
      const baseline = path.join(baselineDir, `${safeName(req.baselineName || req.id)}.png`);
      let existing: Buffer | null = null;
      try { existing = await fs.readFile(baseline); } catch {}
      if (!existing || req.updateBaseline) {
        await fs.writeFile(baseline, current);
        return finish({ requirementId: req.id, title: req.title, category: "visual", status: req.updateBaseline ? "pass" : "needs_review", severity: reqSeverity(req), message: req.updateBaseline ? "Visual baseline updated." : "No visual baseline existed. A baseline was created; approve it, then rerun to enforce regression checks.", baseline });
      }
      if (!existing.equals(current)) {
        await fs.writeFile(screenshot, current);
        const finding = await finish({ requirementId: req.id, title: req.title, category: "visual", status: "fail", severity: reqSeverity(req), message: "Rendered page differs from the approved visual baseline.", screenshot, baseline });
        return finding;
      }
      return finish({ requirementId: req.id, title: req.title, category: "visual", status: "pass", severity: reqSeverity(req), message: "Rendered page matches the approved visual baseline.", baseline });
    }

    return finish({ requirementId: req.id, title: req.title, category: "ui", status: "needs_review", severity: reqSeverity(req), message: "Unsupported browser requirement." });
  } catch (error) {
    return finish({ requirementId: req.id, title: req.title, category: req.type === "visual" ? "visual" : req.type === "accessibility" ? "accessibility" : "ui", status: "fail", severity: reqSeverity(req), message: error instanceof Error ? error.message : "Browser check failed" });
  }
}

export async function runBrowserRequirements(requirements: Requirement[], baseUrl: string, projectPath: string): Promise<QaFinding[]> {
  let browser: any;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return [{ requirementId: "SYSTEM-BROWSER", title: "Chromium availability", category: "system", status: "fail", severity: "critical", message: `Chromium could not start: ${error instanceof Error ? error.message : "unknown error"}. Run npm run install:browser and retry.` }];
  }

  const findings: QaFinding[] = [];
  try {
    for (const req of requirements) {
      const finding = await runOne(req, browser, baseUrl, projectPath);
      if (finding) findings.push(finding);
    }
  } finally {
    await browser.close();
  }
  return findings;
}
