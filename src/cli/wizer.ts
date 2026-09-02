import { randomUUID } from "node:crypto";
import { APPROVED_AGENTS } from "../agents.js";
import type { OutreachTouch } from "../growth/domain.js";
import { renderOutreachMessage } from "../growth/outreach.js";
import { buildRuntime, loadConfig, InMemoryStore, SupabaseApprovalGate, type CampaignRuntime } from "../adapters/index.js";

type Flags = Record<string, string | boolean>;

const parseArgs = (argv: string[]) => {
  const positional: string[] = [], flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const [name, inline] = token.slice(2).split("=");
    const next = argv[index + 1];
    if (inline !== undefined) flags[name!] = inline;
    else if (next && !next.startsWith("--")) { flags[name!] = next; index += 1; }
    else flags[name!] = true;
  }
  return {positional, flags};
};
const text = (flags: Flags, name: string, fallback?: string) => {
  const value = flags[name];
  if (typeof value === "string" && value.length) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
};
const bool = (flags: Flags, name: string) => flags[name] === true || flags[name] === "true";

const USAGE = `wizer <command>

  campaign        Find businesses with no working website, build previews, queue outreach for approval
                  --query <shop=bakery|bakery> --area <"Manchester"|"53.4,-2.3,53.5,-2.2"> --country <GB>
                  [--timezone Europe/London] [--limit 10] [--company <uuid>] [--dry-run] [--auto-approve]
  approvals       List outreach waiting for a human decision   [--company <uuid>] [--status pending]
  approve         Approve one queued message                   <approvalId> --by "<name or email>" [--note ...]
  reject          Reject one queued message                    <approvalId> --by "<name or email>" [--note ...]
  send-approved   Deliver messages a human approved            [--company <uuid>]
  opt-out         Suppress a business and take its preview down --prospect <source:ref> --contact <value> [--reason ...]`;

const runtimeFor = (flags: Flags, extra: {countryCode?: string; timezone?: string} = {}): CampaignRuntime => {
  const config = loadConfig();
  return buildRuntime(config, {
    ...(typeof flags.company === "string" ? {companyId: flags.company} : {}),
    dryRun: bool(flags, "dry-run"), autoApprove: bool(flags, "auto-approve"),
    countryCode: (extra.countryCode ?? "XX").toUpperCase(), ...(extra.timezone ? {timezone: extra.timezone} : {})
  });
};

const campaign = async (flags: Flags) => {
  const countryCode = text(flags, "country").toUpperCase();
  const runtime = runtimeFor(flags, {countryCode, ...(typeof flags.timezone === "string" ? {timezone: flags.timezone} : {})});
  if (bool(flags, "auto-approve") && process.env.OUTREACH_CHANNEL === "resend") throw new Error("--auto-approve cannot be combined with a live outreach channel");
  if (!runtime.policy.jurisdictions[countryCode]) throw new Error(`Outreach policy has no rules for ${countryCode}; add them (and check local law) before prospecting there`);
  for (const note of runtime.notes) console.log(`note: ${note}`);

  const agent = {...APPROVED_AGENTS.find(candidate => candidate.name === "Maha")!, companyId: runtime.companyId};
  const result = await runtime.pipeline.run({
    companyId: runtime.companyId, agent, query: text(flags, "query"), area: text(flags, "area"),
    limit: Number(text(flags, "limit", "10")), sources: [runtime.source]
  });

  console.log(`\ndiscovered ${result.discovered} · qualified ${result.qualified} · previews ${result.previewsPublished} · awaiting approval ${result.queuedForApproval} · sent ${result.sent}`);
  if (result.stopped.stopped) console.log(`stopped: ${result.stopped.reason}`);
  for (const skip of result.skipped) console.log(`skipped ${skip.prospectId} at ${skip.stage}: ${skip.reasons.join("; ")}`);
  for (const failure of result.failed) console.log(`failed ${failure.prospectId}: ${failure.error}`);
  if (runtime.store instanceof InMemoryStore) for (const message of runtime.store.recordsOf("outreach.messages") as Array<Record<string, unknown>>) console.log(`\n--- draft for ${message.prospectId} ---\nSubject: ${message.subject}\n${renderOutreachMessage(message as never)}`);
  if (result.queuedForApproval) console.log(`\n${result.queuedForApproval} message(s) need a human: wizer approvals`);
};

const approvals = async (flags: Flags) => {
  const runtime = runtimeFor(flags);
  if (!(runtime.approvals instanceof SupabaseApprovalGate)) throw new Error("Approvals live in Supabase; configure SUPABASE_URL and SUPABASE_SECRET_KEY");
  const rows = await runtime.approvals.list(runtime.companyId, text(flags, "status", "pending") as "pending");
  if (!rows.length) { console.log("Nothing waiting."); return; }
  for (const row of rows) {
    const payload = row.payload as {message?: {subject?: string; to?: string}; previewUrl?: string; warnings?: string[]};
    console.log(`\n${row.id}\n  ${row.kind} · ${row.subject} · requested ${row.requested_at}`);
    console.log(`  to: ${payload.message?.to ?? "?"}\n  subject: ${payload.message?.subject ?? "?"}\n  preview: ${payload.previewUrl ?? "?"}`);
    for (const warning of payload.warnings ?? []) console.log(`  warning: ${warning}`);
  }
  console.log(`\nApprove with: wizer approve <id> --by "your name"`);
};

const decide = async (status: "approved" | "rejected", positional: string[], flags: Flags) => {
  const runtime = runtimeFor(flags);
  if (!(runtime.approvals instanceof SupabaseApprovalGate)) throw new Error("Approvals live in Supabase; configure SUPABASE_URL and SUPABASE_SECRET_KEY");
  const approvalId = positional[0];
  if (!approvalId) throw new Error(`Usage: wizer ${status === "approved" ? "approve" : "reject"} <approvalId> --by "<name>"`);
  const decided = await runtime.approvals.decide({approvalId, companyId: runtime.companyId, status, decidedBy: text(flags, "by"), ...(typeof flags.note === "string" ? {note: flags.note} : {})});
  console.log(`${decided.status}: ${decided.subject}`);
  if (status === "approved") console.log("Deliver it with: wizer send-approved");
};

const sendApproved = async (flags: Flags) => {
  const runtime = runtimeFor(flags);
  for (const note of runtime.notes) console.log(`note: ${note}`);
  const pending = await runtime.store.query<Array<{messageId: string; approvalId: string; approvedBy: string; message: never; prospect: never; contact: never}>>("outreach.approved_pending", {companyId: runtime.companyId});
  if (!pending?.length) { console.log("Nothing approved is waiting to be sent."); return; }
  const history = await runtime.store.query<OutreachTouch[]>("outreach.touches", {companyId: runtime.companyId}) ?? [];
  const today = new Date().toISOString().slice(0, 10);
  let sentToday = await runtime.store.query<number>("outreach.sent_today", {companyId: runtime.companyId, day: today}) ?? 0;

  for (const entry of pending) {
    const message = entry.message as unknown as {prospectId: string; channel: OutreachTouch["channel"]; touch: number; previewUrl: string};
    const verdict = await runtime.gate.evaluate({prospect: entry.prospect, contact: entry.contact, message: entry.message, history, sentToday, now: new Date()});
    if (!verdict.allowed) { console.log(`held ${message.prospectId}: ${verdict.violations.join("; ")}`); continue; }
    await runtime.sender_channel.send({message: entry.message, approvedBy: entry.approvedBy});
    const sentAt = new Date().toISOString();
    sentToday += 1;
    history.push({prospectId: message.prospectId, channel: message.channel, sentAt, outcome: "sent"});
    await runtime.store.append("outreach.touches", {companyId: runtime.companyId, prospectId: message.prospectId, channel: message.channel, touch: message.touch, sentAt, outcome: "sent", approvalId: entry.approvalId});
    await runtime.store.append("events.publish", {id: randomUUID(), companyId: runtime.companyId, type: "outreach.sent", payload: {prospectId: message.prospectId, approvalId: entry.approvalId, previewUrl: message.previewUrl}, occurredAt: sentAt});
    console.log(`sent ${message.prospectId}`);
  }
};

const optOut = async (flags: Flags) => {
  const runtime = runtimeFor(flags);
  const prospectId = text(flags, "prospect"), contact = text(flags, "contact"), reason = text(flags, "reason", "requested no further contact");
  const at = new Date().toISOString();
  await runtime.optOut.handle({companyId: runtime.companyId, prospectId, contactValue: contact, reason, at});
  if (runtime.client) {
    const {data} = await runtime.client.from("demo_sites").select("id, prospects!inner(source, source_ref)").eq("company_id", runtime.companyId).eq("status", "published");
    for (const row of data ?? []) {
      const owner = row.prospects as unknown as {source: string; source_ref: string};
      if (`${owner.source}:${owner.source_ref}` !== prospectId) continue;
      await runtime.publisher.unpublish({siteId: row.id as string, reason});
      await runtime.store.append("demo_sites.removed", {siteId: row.id, reason});
      console.log(`preview ${row.id} removed`);
    }
  }
  console.log(`${prospectId} and ${contact} suppressed; they will never be contacted again.`);
};

const main = async () => {
  const {positional, flags} = parseArgs(process.argv.slice(2));
  const command = positional.shift();
  switch (command) {
    case "campaign": return campaign(flags);
    case "approvals": return approvals(flags);
    case "approve": return decide("approved", positional, flags);
    case "reject": return decide("rejected", positional, flags);
    case "send-approved": return sendApproved(flags);
    case "opt-out": return optOut(flags);
    default: console.log(USAGE); process.exitCode = command ? 1 : 0;
  }
};

main().catch(error => { console.error(`\n${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
