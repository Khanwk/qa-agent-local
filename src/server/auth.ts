import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

type QaAuthContext = {
  supabase: any;
  user: { id: string; email?: string };
  profile: { agent_access: boolean; status: string; max_devices: number; max_projects: number };
};

function configured() {
  return {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
    key: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || ""
  };
}

export function authConfigured() {
  const { url, key } = configured();
  return Boolean(url && key);
}

export function getQaAuth(req: Request): QaAuthContext | undefined {
  return (req as any).qaAuth as QaAuthContext | undefined;
}

export async function requireEligible(req: Request, res: Response, next: NextFunction) {
  const { url, key } = configured();
  if (!url || !key) return res.status(503).json({ error: "QA Agent authentication is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to .env." });

  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Authentication required" });

    const supabase = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid or expired session" });

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("agent_access,status,max_devices,max_projects")
      .eq("id", user.id)
      .single();
    if (profileError || !profile?.agent_access || profile.status !== "active") return res.status(403).json({ error: "This account is not eligible to use QA Agent" });

    const deviceId = String(req.headers["x-qa-device"] || "").trim();
    if (!deviceId) return res.status(401).json({ error: "Device identity is required" });
    const deviceName = String(req.headers["x-qa-device-name"] || "QA Agent device").slice(0, 160);
    const { error: deviceError } = await supabase.rpc("register_qa_device", { p_device_id: deviceId, p_device_name: deviceName });
    if (deviceError) {
      const message = String(deviceError.message || "");
      if (/device limit/i.test(message)) return res.status(403).json({ error: "Device limit reached for this account" });
      return res.status(403).json({ error: "This device could not be registered for the account" });
    }

    (req as any).qaAuth = { supabase, user, profile } satisfies QaAuthContext;
    next();
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "Authentication failed" });
  }
}

export async function ensureProjectEligible(req: Request, projectPath: string, projectName: string) {
  const auth = getQaAuth(req);
  if (!auth) throw new Error("Authentication context is unavailable");
  const projectHash = crypto.createHash("sha256").update(projectPath.trim().toLowerCase()).digest("hex");
  const { error } = await auth.supabase.rpc("register_qa_project", { p_project_hash: projectHash, p_project_name: projectName.slice(0, 160) });
  if (error) {
    const message = String(error.message || "");
    if (/project limit/i.test(message)) throw new Error("Project limit reached for this account");
    throw new Error("This project could not be registered for the account");
  }
}
