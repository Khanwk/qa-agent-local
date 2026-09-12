import type { QaFinding, Requirement } from "../types/qa.js";

export async function runApiRequirement(req: Requirement, baseUrl?: string): Promise<QaFinding | null> {
  if (req.type !== "api") return null;
  try {
    if (!/^https?:\/\//i.test(req.url) && !baseUrl) throw new Error("A Base URL is required for relative API URLs");
    const url = /^https?:\/\//i.test(req.url) ? req.url : new URL(req.url, baseUrl).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: req.method ?? "GET",
        headers: req.body ? { "content-type": "application/json" } : undefined,
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    const expectedStatus = req.expectedStatus ?? 200;
    if (response.status !== expectedStatus) throw new Error(`Expected HTTP ${expectedStatus}, received ${response.status}`);
    if (req.expectedText && !text.includes(req.expectedText)) throw new Error(`Response did not contain expected text: ${req.expectedText}`);
    return { requirementId: req.id, title: req.title, category: "api", status: "pass", severity: req.severity ?? "medium", message: `${req.method ?? "GET"} ${req.url} returned the expected response.` };
  } catch (error) {
    return { requirementId: req.id, title: req.title, category: "api", status: "fail", severity: req.severity ?? "medium", message: error instanceof Error ? error.message : "API check failed" };
  }
}
