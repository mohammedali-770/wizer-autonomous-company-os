import type { SupabaseClient } from "@supabase/supabase-js";
import { IntegrationGateway } from "../integrations.js";
import { MemoryFabric } from "../memory.js";
import { PersistentEventBus } from "../event-bus.js";
import type { Store } from "../domain.js";
import { DemoSiteBuilder, DemoSitePublisher, type SenderIdentity } from "../growth/demo-site.js";
import { OutreachComplianceGate, OptOutHandler } from "../growth/compliance.js";
import { OutreachComposer, OutreachSender } from "../growth/outreach.js";
import { ProspectDiscovery } from "../growth/discovery.js";
import { WebPresenceAssessor } from "../growth/presence.js";
import { WebsiteOutreachPipeline } from "../growth/pipeline.js";
import type { ApprovalGate, OutreachPolicy, SuppressionList } from "../growth/domain.js";
import { AnthropicReasoningModel } from "./model-anthropic.js";
import { AppleAppStoreDirectory } from "./app-directory.js";
import { DryRunOutreachChannel, ResendEmailChannel } from "./channel-email.js";
import { FixedApprovalGate, InMemoryStore, InMemorySuppressionList } from "./memory-store.js";
import { PoliteWebProbe } from "./http-probe.js";
import { LocalDirectorySiteHost, SupabaseStorageSiteHost } from "./site-host.js";
import { OpenStreetMapDirectory } from "./source-overpass.js";
import { SupabaseApprovalGate, SupabaseStore, SupabaseSuppressionList, createServiceClient } from "./supabase-store.js";
import type { WizerConfig } from "./config.js";

export const DEV_COMPANY_ID = "00000000-0000-4000-8000-000000000100";

export type RuntimeOptions = {companyId?: string; dryRun?: boolean; autoApprove?: boolean; countryCode: string; timezone?: string; takedownUrl?: string};

export type CampaignRuntime = {
  companyId: string; policy: OutreachPolicy; sender: SenderIdentity; store: Store; client: SupabaseClient | null;
  gateway: IntegrationGateway; publisher: DemoSitePublisher; suppression: SuppressionList; approvals: ApprovalGate;
  source: OpenStreetMapDirectory; pipeline: WebsiteOutreachPipeline; sender_channel: OutreachSender;
  gate: OutreachComplianceGate; optOut: OptOutHandler; notes: string[];
};

export const buildRuntime = (config: WizerConfig, options: RuntimeOptions): CampaignRuntime => {
  const {env, policy} = config, notes: string[] = [];
  const dryRun = options.dryRun ?? false;
  const supabaseReady = Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
  const companyId = options.companyId ?? env.WIZER_COMPANY_ID ?? (dryRun ? DEV_COMPANY_ID : "");
  if (!companyId) throw new Error("A company id is required: pass --company or set WIZER_COMPANY_ID");
  if (!supabaseReady && !dryRun) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required outside --dry-run: evidence, suppression and approvals must be durable");

  const client = supabaseReady ? createServiceClient(env.SUPABASE_URL!, env.SUPABASE_SECRET_KEY!) : null;
  const store: Store = client ? new SupabaseStore(client, companyId) : new InMemoryStore();
  if (!client) notes.push("No Supabase credentials: this run keeps evidence in memory only and forgets it on exit.");

  const suppression: SuppressionList = client ? new SupabaseSuppressionList(client) : new InMemorySuppressionList();
  const approvals: ApprovalGate = options.autoApprove ? new FixedApprovalGate("approved", "cli:auto-approve") : client ? new SupabaseApprovalGate(client) : new FixedApprovalGate("pending");
  if (options.autoApprove) notes.push("Approvals are auto-granted for this run; only valid with the dry-run channel.");

  const sender: SenderIdentity = {legalName: policy.senderIdentity.legalName, websiteUrl: policy.senderIdentity.websiteUrl, replyToEmail: policy.senderIdentity.replyToEmail, takedownUrl: options.takedownUrl ?? `${policy.senderIdentity.websiteUrl.replace(/\/$/, "")}/remove-preview`};

  const gateway = new IntegrationGateway(store);
  gateway.register("site_host", env.SITE_HOST === "supabase" && client ? new SupabaseStorageSiteHost(client, env.SITE_HOST_BUCKET) : new LocalDirectorySiteHost({directory: env.SITE_HOST_DIR, baseUrl: env.SITE_PUBLIC_BASE_URL}));
  if (env.SITE_HOST !== "supabase") notes.push(`Previews are written to ${env.SITE_HOST_DIR} and linked under ${env.SITE_PUBLIC_BASE_URL}; serve that directory at that URL before sending anything.`);
  gateway.register("outreach_channel", env.OUTREACH_CHANNEL === "resend"
    ? new ResendEmailChannel({apiKey: env.RESEND_API_KEY!, from: env.OUTREACH_FROM!, replyTo: policy.senderIdentity.replyToEmail, optOutMailto: `mailto:${policy.senderIdentity.replyToEmail}?subject=stop`})
    : new DryRunOutreachChannel({directory: env.OUTREACH_DIR}));
  if (env.OUTREACH_CHANNEL !== "resend") notes.push(`Outreach channel is dry-run: messages are written to ${env.OUTREACH_DIR} and never delivered.`);

  const model = new AnthropicReasoningModel({...(env.ANTHROPIC_API_KEY ? {apiKey: env.ANTHROPIC_API_KEY} : {}), model: env.LLM_MODEL, effort: env.LLM_EFFORT, maxTokens: env.LLM_MAX_TOKENS});
  const publisher = new DemoSitePublisher(gateway);
  const gate = new OutreachComplianceGate(policy, suppression);
  const outreachSender = new OutreachSender(gateway);
  const source = new OpenStreetMapDirectory({countryCode: options.countryCode, ...(options.timezone ? {timezone: options.timezone} : {}), endpoint: env.OVERPASS_ENDPOINT, userAgent: env.PROBE_USER_AGENT});

  const pipeline = new WebsiteOutreachPipeline({
    store, bus: new PersistentEventBus(store), memory: new MemoryFabric(store),
    discovery: new ProspectDiscovery(store),
    assessor: new WebPresenceAssessor(new PoliteWebProbe({userAgent: env.PROBE_USER_AGENT, timeoutMs: env.PROBE_TIMEOUT_MS, minHostIntervalMs: env.PROBE_MIN_HOST_INTERVAL_MS}), new AppleAppStoreDirectory()),
    builder: new DemoSiteBuilder(model, sender), publisher, composer: new OutreachComposer(model, policy),
    sender: outreachSender, gate, approvals
  });

  return {companyId, policy, sender, store, client, gateway, publisher, suppression, approvals, source, pipeline, sender_channel: outreachSender, gate, optOut: new OptOutHandler(suppression), notes};
};
