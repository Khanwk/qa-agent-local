import { z } from "zod";
import type { QaConfig } from "../types/qa.js";

const Severity = z.enum(["critical", "high", "medium", "low"]);

const Base = {
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(240),
  severity: Severity.optional(),
  source: z.string().trim().max(80).optional(),
  enabled: z.boolean().optional(),
};

const Locator = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("role"),
    role: z.string().trim().min(1),
    name: z.string().optional(),
    exact: z.boolean().optional(),
  }),
  z.object({
    by: z.literal("text"),
    value: z.string().min(1),
    exact: z.boolean().optional(),
  }),
  z.object({
    by: z.literal("label"),
    value: z.string().min(1),
    exact: z.boolean().optional(),
  }),
  z.object({
    by: z.literal("placeholder"),
    value: z.string().min(1),
    exact: z.boolean().optional(),
  }),
  z.object({
    by: z.literal("testId"),
    value: z.string().min(1),
  }),
  z.object({
    by: z.literal("css"),
    value: z.string().min(1),
  }),
]);

const StepUnion = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goto"),
    path: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("click"),
    locator: Locator.optional(),
    selector: z.string().trim().min(1).optional(),
  }),
  z.object({
    action: z.literal("fill"),
    locator: Locator.optional(),
    selector: z.string().trim().min(1).optional(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("expect-text"),
    locator: Locator.optional(),
    selector: z.string().trim().min(1).optional(),
    text: z.string().min(1),
  }),
  z.object({
    action: z.literal("expect-url"),
    contains: z.string().min(1),
  }),
  z.object({
    action: z.literal("expect-visible"),
    locator: Locator.optional(),
    selector: z.string().trim().min(1).optional(),
  }),
]);

const Step = StepUnion.superRefine((value, ctx) => {
  if (
    value.action === "click" ||
    value.action === "fill" ||
    value.action === "expect-visible"
  ) {
    if (!value.locator && !value.selector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.action} needs a locator or selector`,
        path: ["locator"],
      });
    }
  }
});

const RequirementUnion = z.discriminatedUnion("type", [
  z.object({
    ...Base,
    type: z.literal("currency"),
    currency: z.string().trim().min(3).max(3),
    symbol: z.string().min(1).optional(),
    forbiddenTokens: z.array(z.string().min(1)).max(30).optional(),
    paths: z.array(z.string().min(1)).max(50).optional(),
    requirePresence: z.boolean().optional(),
  }),

  z.object({
    ...Base,
    type: z.literal("route"),
    path: z.string().trim().min(1),
    expectText: z.string().optional(),
  }),

  z.object({
    ...Base,
    type: z.literal("forbidden-hook-dependency"),
    identifier: z.string().trim().min(1).max(100),
  }),

  z.object({
    ...Base,
    type: z.literal("text-search"),
    forbidden: z.array(z.string().min(1)).max(100).optional(),
    required: z.array(z.string().min(1)).max(100).optional(),
    requiredMode: z.enum(["all", "any"]).optional(),
  }),

  z.object({
    ...Base,
    type: z.literal("browser-flow"),
    path: z.string().optional(),
    steps: z.array(Step).min(1).max(100),
  }),

  z.object({
    ...Base,
    type: z.literal("api"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
    url: z.string().trim().min(1),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    body: z.unknown().optional(),
    expectedText: z.string().optional(),
  }),

  z.object({
    ...Base,
    type: z.literal("visual"),
    path: z.string().trim().min(1),
    fullPage: z.boolean().optional(),
    expectText: z.string().optional(),
    baselineName: z.string().trim().min(1).max(120).optional(),
    updateBaseline: z.boolean().optional(),
  }),

  z.object({
    ...Base,
    type: z.literal("accessibility"),
    path: z.string().trim().min(1),
  }),
]);

const Requirement = RequirementUnion.superRefine((value, ctx) => {
  if (value.type === "text-search") {
    const hasForbidden = Boolean(value.forbidden?.length);
    const hasRequired = Boolean(value.required?.length);

    if (!hasForbidden && !hasRequired) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text-search needs required or forbidden tokens",
        path: ["required"],
      });
    }
  }
});

const QaConfigSchema = z.object({
  projectName: z.string().trim().min(1).max(160),

  projectPath: z.string().trim().min(1),

  baseUrl: z
    .string()
    .trim()
    .optional()
    .refine((value) => {
      if (!value) return true;

      try {
        const url = new URL(value);

        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    }, "baseUrl must be an http(s) URL"),

  mode: z.enum(["code", "ui", "full", "supervisor"]).optional(),

  requirements: z.array(Requirement).max(500),

  changedOnly: z.boolean().optional(),

  gitBase: z.string().trim().min(1).max(200).optional(),
});

export function parseQaConfig(input: unknown): QaConfig {
  const result = QaConfigSchema.safeParse(input);

  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid QA configuration: ${details}`);
  }

  return result.data as QaConfig;
}
