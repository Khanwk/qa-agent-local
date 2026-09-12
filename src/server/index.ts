import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runQa } from "../core/scanner.js";
import { requirementsFromText } from "../ai/gemini.js";
import type { QaConfig } from "../types/qa.js";
import { pickProjectFolder } from "../core/picker.js";
import { getGitChanges } from "../core/git.js";
import { parseQaConfig } from "../core/validate.js";
import { authConfigured, ensureProjectEligible, requireEligible } from "./auth.js";

const app = express();
const port = Number(process.env.PORT || 4782);
const allowedArtifacts = new Set<string>();
const allowedProjectRoots = new Set<string>();

app.use(cors({ origin: ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:4782", "http://localhost:4782"] }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  version: "2.0.0",
  authConfigured: authConfigured(),
  geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
}));

app.get("/api/runtime-config", (_req, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "",
  webPortalUrl: process.env.WEB_PORTAL_URL || ""
}));

app.get("/api/auth/check", requireEligible, (req, res) => {
  const auth = (req as any).qaAuth;
  res.json({ ok: true, user: { id: auth?.user?.id, email: auth?.user?.email }, plan: auth?.profile });
});

app.post("/api/project/pick", requireEligible, async (_req, res) => {
  try {
    const projectPath = await pickProjectFolder();
    if (!projectPath) return res.status(400).json({ error: "No folder selected" });
    res.json({ projectPath });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Folder picker failed" });
  }
});

app.post("/api/project/inspect", requireEligible, async (req, res) => {
  try {
    const raw = String(req.body.projectPath || "").trim();
    if (!raw) return res.status(400).json({ error: "Project path is required" });
    const projectPath = path.resolve(raw);
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) return res.status(400).json({ error: "Project path is not a directory" });
    const entries = await fs.readdir(projectPath);
    return res.json({ ok: true, projectPath, entries: entries.slice(0, 80) });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Invalid project path" });
  }
});

app.post("/api/project/git", requireEligible, async (req, res) => {
  try {
    const projectPath = String(req.body.projectPath || "").trim();
    const projectName = String(req.body.projectName || path.basename(projectPath) || "Local project").trim();
    const gitBase = String(req.body.gitBase || "HEAD~1").trim();
    if (!projectPath) return res.status(400).json({ error: "Project path is required" });
    await ensureProjectEligible(req, projectPath, projectName);
    res.json(await getGitChanges(projectPath, gitBase));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Git status failed" });
  }
});

app.post("/api/project/probe", requireEligible, async (req, res) => {
  try {
    const baseUrl = String(req.body.baseUrl || "").trim();
    if (!baseUrl) return res.status(400).json({ error: "Base URL is required" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(baseUrl, { signal: controller.signal });
      return res.json({ ok: response.status < 500, status: response.status, url: response.url });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Application is not reachable" });
  }
});

app.post("/api/qa/run", requireEligible, async (req, res) => {
  try {
    const config = parseQaConfig(req.body);
    await ensureProjectEligible(req, config.projectPath, config.projectName);
    allowedProjectRoots.add(path.resolve(config.projectPath));
    const result = await runQa(config);
    for (const finding of result.findings) {
      for (const artifact of [finding.screenshot, finding.trace, finding.baseline]) if (artifact) allowedArtifacts.add(path.resolve(artifact));
    }
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "QA run failed";
    const status = /Invalid QA configuration/i.test(message) ? 400 : /limit reached|eligible|registered/i.test(message) ? 403 : 500;
    res.status(status).json({ error: message });
  }
});

app.post("/api/ai/requirements", requireEligible, async (req, res) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Requirement text is required" });
    if (text.length > 6000) return res.status(400).json({ error: "Requirement text is too long. Keep AI input focused and under 6,000 characters." });
    res.json({ requirements: await requirementsFromText(text) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "AI conversion failed" });
  }
});

app.get("/api/artifact", requireEligible, async (req, res) => {
  try {
    const requested = path.resolve(String(req.query.path || ""));
    const underRegisteredQaRoot = [...allowedProjectRoots].some((projectRoot) => {
      const qaRoot = path.join(projectRoot, ".qa-agent") + path.sep;
      return requested.startsWith(qaRoot);
    });
    if (!allowedArtifacts.has(requested) && !underRegisteredQaRoot) return res.status(403).json({ error: "Artifact path is not allowed" });
    await fs.access(requested);
    if (String(req.query.download || "") === "1") res.download(requested);
    else res.sendFile(requested);
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "Artifact not found" });
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, "../../ui");
app.use(express.static(uiDir));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(uiDir, "index.html"));
});

app.listen(port, "127.0.0.1", () => console.log(`QA Agent running at http://127.0.0.1:${port}`));
