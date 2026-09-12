import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const Locator = z.discriminatedUnion("by", [
  z.object({ by: z.literal("role"), role: z.string(), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ by: z.literal("text"), value: z.string(), exact: z.boolean().optional() }),
  z.object({ by: z.literal("label"), value: z.string(), exact: z.boolean().optional() }),
  z.object({ by: z.literal("placeholder"), value: z.string(), exact: z.boolean().optional() }),
  z.object({ by: z.literal("testId"), value: z.string() }),
  z.object({ by: z.literal("css"), value: z.string() })
]);

const Step = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: z.string() }),
  z.object({ action: z.literal("click"), locator: Locator.optional(), selector: z.string().optional() }),
  z.object({ action: z.literal("fill"), locator: Locator.optional(), selector: z.string().optional(), value: z.string() }),
  z.object({ action: z.literal("expect-text"), locator: Locator.optional(), selector: z.string().optional(), text: z.string() }),
  z.object({ action: z.literal("expect-url"), contains: z.string() }),
  z.object({ action: z.literal("expect-visible"), locator: Locator.optional(), selector: z.string().optional() })
]);

const Rule = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  source: z.string().optional(),
  enabled: z.boolean().optional(),
  type: z.enum(["currency", "route", "forbidden-hook-dependency", "text-search", "browser-flow", "api", "visual", "accessibility"]),
  currency: z.string().optional(),
  symbol: z.string().optional(),
  forbiddenTokens: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  requirePresence: z.boolean().optional(),
  path: z.string().optional(),
  expectText: z.string().optional(),
  identifier: z.string().optional(),
  forbidden: z.array(z.string()).optional(),
  required: z.array(z.string()).optional(),
  requiredMode: z.enum(["all", "any"]).optional(),
  steps: z.array(Step).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  url: z.string().optional(),
  expectedStatus: z.number().optional(),
  body: z.unknown().optional(),
  expectedText: z.string().optional(),
  fullPage: z.boolean().optional(),
  baselineName: z.string().optional()
});

const Rules = z.array(Rule).min(1).max(12);

export async function requirementsFromText(text: string) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const prompt = `Convert the software requirement below into one or more ATOMIC QA rules. Split combined requirements so every independently pass/fail-able behavior becomes its own rule. Prefer deterministic rules over browser rules when possible.

Supported types: currency, route, forbidden-hook-dependency, text-search, browser-flow, api, visual, accessibility.
For browser-flow locators prefer role, label, text, placeholder or testId. Use CSS only as a last resort.
Never invent credentials, payment details, private data, API endpoints or selectors that the requirement does not justify. If browser detail is insufficient, create a route/text-search rule rather than guessing.
Return ONLY a JSON array. Each rule must have a short unique id like REQ-001, a clear title, severity, source:"gemini", enabled:true, type, and only fields relevant to that type.

Requirement:\n${text}`;
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || "gemini-3.8-flash", contents: prompt });
  const raw = (response.text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(raw);
  const candidates = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.requirements) ? parsed.requirements : [parsed];
  return Rules.parse(candidates);
}
