import { readFileSync } from "node:fs";
import { z } from "zod";
import { OutreachPolicy } from "../growth/domain.js";

export const WizerEnv = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().default("claude-opus-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  WIZER_COMPANY_ID: z.string().uuid().optional(),
  OUTREACH_POLICY_FILE: z.string().default("outreach.policy.json"),
  SITE_HOST: z.enum(["supabase", "local"]).default("local"),
  SITE_HOST_BUCKET: z.string().default("demo-previews"),
  SITE_HOST_DIR: z.string().default(".wizer/previews"),
  SITE_PUBLIC_BASE_URL: z.string().url().default("https://previews.example"),
  OUTREACH_CHANNEL: z.enum(["resend", "dry_run"]).default("dry_run"),
  OUTREACH_DIR: z.string().default(".wizer/outbox"),
  RESEND_API_KEY: z.string().min(1).optional(),
  OUTREACH_FROM: z.string().min(3).optional(),
  OVERPASS_ENDPOINT: z.string().url().default("https://overpass-api.de/api/interpreter"),
  PROBE_USER_AGENT: z.string().default("WizerPresenceBot/0.1 (+https://example.com/bot)"),
  PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  PROBE_MIN_HOST_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1500)
});
export type WizerEnv = z.infer<typeof WizerEnv>;

export type WizerConfig = {env: WizerEnv; policy: OutreachPolicy};

export const loadPolicy = (path: string): OutreachPolicy => {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { throw new Error(`Outreach policy not found at ${path}. Copy outreach.policy.example.json, fill in your legal sender identity and per-country rules, and point OUTREACH_POLICY_FILE at it.`); }
  const parsed = OutreachPolicy.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Outreach policy at ${path} is invalid: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  if (!Object.keys(parsed.data.jurisdictions).length) throw new Error(`Outreach policy at ${path} configures no jurisdictions, so no business could lawfully be contacted.`);
  return parsed.data;
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): WizerConfig => {
  const parsed = WizerEnv.safeParse(source);
  if (!parsed.success) throw new Error(`Environment is invalid: ${parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const env = parsed.data;
  const missing: string[] = [];
  if (!env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY (or an `ant auth login` profile) is required to generate previews and outreach copy");
  if (env.SITE_HOST === "supabase" && !(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY)) missing.push("SITE_HOST=supabase requires SUPABASE_URL and SUPABASE_SECRET_KEY");
  if (env.OUTREACH_CHANNEL === "resend" && !(env.RESEND_API_KEY && env.OUTREACH_FROM)) missing.push("OUTREACH_CHANNEL=resend requires RESEND_API_KEY and OUTREACH_FROM");
  if (missing.length) throw new Error(missing.join("\n"));
  return {env, policy: loadPolicy(env.OUTREACH_POLICY_FILE)};
};
