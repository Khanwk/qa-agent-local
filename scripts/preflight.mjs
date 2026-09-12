import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import "dotenv/config";
import { chromium } from "playwright";

const checks = [];
const pass = (name, detail = "") => checks.push({ ok: true, name, detail });
const fail = (name, detail) => checks.push({ ok: false, name, detail });

const major = Number(process.versions.node.split(".")[0]);
major >= 20 ? pass("Node.js", process.version) : fail("Node.js", `Node 20+ required, found ${process.version}`);

try {
  await fs.access(path.resolve("dist/server/server/index.js"));
  await fs.access(path.resolve("dist/ui/index.html"));
  pass("Production build", "server and UI output found");
} catch {
  fail("Production build", "Run npm run build first");
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";
if (!supabaseUrl || !supabaseKey) {
  fail("Supabase configuration", "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required");
} else {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/settings`, {
      headers: { apikey: supabaseKey }, signal: controller.signal
    });
    clearTimeout(timer);
    response.ok ? pass("Supabase endpoint", `reachable (${response.status})`) : fail("Supabase endpoint", `returned HTTP ${response.status}`);
  } catch (error) {
    fail("Supabase endpoint", error instanceof Error ? error.message : "not reachable");
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent("<main><h1>QA Agent preflight</h1></main>");
  const text = await page.locator("h1").innerText();
  text === "QA Agent preflight" ? pass("Chromium", "Playwright browser launch passed") : fail("Chromium", "unexpected browser output");
  await context.close();
} catch (error) {
  fail("Chromium", error instanceof Error ? error.message : "browser launch failed");
} finally {
  await browser?.close();
}

if (process.env.GEMINI_API_KEY) pass("Gemini", `configured (${process.env.GEMINI_MODEL || "gemini-3.8-flash"})`);
else pass("Gemini", "optional — not configured");

console.log("\nQA Agent client-demo preflight\n");
for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
const failed = checks.filter((check) => !check.ok);
if (failed.length) {
  console.error(`\nPreflight failed: ${failed.length} check(s) need attention. Do not start the client demo yet.`);
  process.exit(1);
}
console.log("\nPreflight passed. This machine is ready for the client demo.");
