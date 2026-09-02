import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "../domain.js";
import type { ApprovalGate, BusinessProspect, ContactPoint, OutreachMessage, OutreachTouch, SuppressionList } from "../growth/domain.js";
import { suppressionHash } from "./memory-store.js";

export const createServiceClient = (url: string, secretKey: string): SupabaseClient =>
  createClient(url, secretKey, {auth: {persistSession: false, autoRefreshToken: false}});

const splitExternalId = (externalId: string) => {
  const separator = externalId.indexOf(":");
  if (separator < 1) throw new Error(`Prospect id "${externalId}" is not in source:reference form`);
  return {source: externalId.slice(0, separator), sourceRef: externalId.slice(separator + 1)};
};
const externalIdOf = (row: {source: string; source_ref: string}) => `${row.source}:${row.source_ref}`;
const asUuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
const fail = (context: string, error: {message: string} | null) => { if (error) throw new Error(`${context}: ${error.message}`); };

export class SupabaseStore implements Store {
  private readonly prospectIds = new Map<string, string>();
  constructor(private readonly client: SupabaseClient, private readonly companyId: string) {}

  private async prospectUuid(externalId: string) {
    const cached = this.prospectIds.get(externalId);
    if (cached) return cached;
    const {source, sourceRef} = splitExternalId(externalId);
    const {data, error} = await this.client.from("prospects").select("id").eq("company_id", this.companyId).eq("source", source).eq("source_ref", sourceRef).maybeSingle();
    fail(`Looking up prospect ${externalId}`, error);
    if (!data) throw new Error(`Prospect ${externalId} is not stored yet`);
    this.prospectIds.set(externalId, data.id as string);
    return data.id as string;
  }

  private async recordEvent(type: string, payload: unknown) {
    const {error} = await this.client.from("events").insert({company_id: this.companyId, type, payload});
    fail(`Recording ${type}`, error);
  }

  async query<T>(operation: string, input?: unknown): Promise<T> {
    const request = (input ?? {}) as Record<string, unknown>;
    switch (operation) {
      case "prospects.known_fingerprints": {
        const {data, error} = await this.client.from("prospects").select("fingerprint").eq("company_id", this.companyId).is("deleted_at", null);
        fail("Reading known prospects", error);
        return (data ?? []).map(row => row.fingerprint as string) as T;
      }
      case "outreach.touches": {
        const {data, error} = await this.client.from("outreach_messages").select("channel, sent_at, status, prospects(source, source_ref)").eq("company_id", this.companyId).not("sent_at", "is", null);
        fail("Reading outreach history", error);
        const touches: OutreachTouch[] = (data ?? []).map(row => {
          const prospect = row.prospects as unknown as {source: string; source_ref: string};
          const status = row.status as string;
          return {prospectId: externalIdOf(prospect), channel: row.channel as OutreachTouch["channel"], sentAt: row.sent_at as string, outcome: (["sent", "bounced", "replied", "opted_out"].includes(status) ? status : "sent") as OutreachTouch["outcome"]};
        });
        return touches as T;
      }
      case "outreach.sent_today": {
        const day = String(request.day ?? new Date().toISOString().slice(0, 10));
        const {count, error} = await this.client.from("outreach_messages").select("id", {count: "exact", head: true}).eq("company_id", this.companyId).gte("sent_at", `${day}T00:00:00Z`).lte("sent_at", `${day}T23:59:59.999Z`);
        fail("Counting today's sends", error);
        return (count ?? 0) as T;
      }
      case "growth.campaign_signals": {
        const {data, error} = await this.client.from("events").select("payload").eq("company_id", this.companyId).eq("type", "growth.campaign_signal").order("occurred_at", {ascending: true}).limit(50);
        fail("Reading campaign signals", error);
        return (data ?? []).map(row => row.payload) as T;
      }
      case "memory.recall": {
        const {data, error} = await this.client.from("memories").select("id, kind, content, valid_to").eq("company_id", this.companyId).ilike("content", `%${String(request.query ?? "")}%`).order("importance", {ascending: false}).limit(Number(request.limit ?? 12));
        fail("Recalling memory", error);
        return (data ?? []).map(row => ({...row, score: 0})) as T;
      }
      case "scheduler.claim_due": {
        const {data, error} = await this.client.from("events").select("id, company_id, type, payload, occurred_at").eq("company_id", this.companyId).is("processed_at", null).lte("occurred_at", String(request.now ?? new Date().toISOString())).limit(25);
        fail("Claiming due events", error);
        const rows = data ?? [];
        if (rows.length) fail("Marking events processed", (await this.client.from("events").update({processed_at: new Date().toISOString()}).in("id", rows.map(row => row.id))).error);
        return rows.map(row => ({id: row.id, companyId: row.company_id, type: row.type, payload: row.payload, occurredAt: row.occurred_at})) as T;
      }
      case "outreach.approved_pending": {
        const {data, error} = await this.client.from("outreach_messages")
          .select("id, channel, recipient, touch, subject, body, sender_identity_block, contact_source_disclosure, opt_out_instruction, composed_at, approval_id, demo_sites(preview_url), prospects(*, prospect_contacts(*))")
          .eq("company_id", this.companyId).eq("status", "pending_approval").not("approval_id", "is", null);
        fail("Reading messages awaiting delivery", error);
        const approvalIds = (data ?? []).map(row => row.approval_id as string);
        if (!approvalIds.length) return [] as T;
        const {data: approvals, error: approvalError} = await this.client.from("approvals").select("id, status, decided_by").in("id", approvalIds).eq("status", "approved");
        fail("Reading approvals", approvalError);
        const approved = new Map((approvals ?? []).map(row => [row.id as string, row.decided_by as string | null]));
        return (data ?? []).filter(row => approved.has(row.approval_id as string)).map(row => {
          const prospectRow = row.prospects as unknown as Record<string, unknown> & {prospect_contacts: Array<Record<string, unknown>>};
          const contacts: ContactPoint[] = prospectRow.prospect_contacts.map(contact => ({channel: contact.channel as ContactPoint["channel"], value: contact.value as string, publiclyListed: contact.publicly_listed as boolean, consent: contact.consent as ContactPoint["consent"], source: contact.source as string, collectedAt: contact.collected_at as string}));
          const prospect: BusinessProspect = {
            id: externalIdOf(prospectRow as unknown as {source: string; source_ref: string}), companyId: this.companyId,
            source: prospectRow.source as string, sourceRef: prospectRow.source_ref as string, name: prospectRow.name as string,
            category: (prospectRow.category as string) ?? "", address: prospectRow.address as BusinessProspect["address"],
            timezone: prospectRow.timezone as string, declaredWebsite: (prospectRow.declared_website as string | null) ?? null,
            socialProfiles: (prospectRow.social_profiles as BusinessProspect["socialProfiles"]) ?? [], contacts,
            discoveredAt: prospectRow.discovered_at as string, retainUntil: (prospectRow.retain_until as string | null) ?? null
          };
          const message: OutreachMessage = {
            prospectId: prospect.id, channel: row.channel as OutreachMessage["channel"], to: row.recipient as string,
            subject: row.subject as string, body: row.body as string,
            previewUrl: ((row.demo_sites as unknown as {preview_url: string} | null)?.preview_url) ?? "",
            senderIdentityBlock: row.sender_identity_block as string, contactSourceDisclosure: row.contact_source_disclosure as string,
            optOutInstruction: row.opt_out_instruction as string, touch: row.touch as number, composedAt: row.composed_at as string
          };
          const contact = contacts.find(candidate => candidate.value === message.to) ?? contacts[0]!;
          return {messageId: row.id as string, approvalId: row.approval_id as string, approvedBy: approved.get(row.approval_id as string) ?? "human", message, prospect, contact};
        }) as T;
      }
      default:
        if (operation.startsWith("context.")) return null as T;
        throw new Error(`SupabaseStore has no query for ${operation}`);
    }
  }

  async append(operation: string, input: unknown): Promise<void> {
    const payload = input as Record<string, any>;
    switch (operation) {
      case "events.publish": {
        const {error} = await this.client.from("events").insert({company_id: payload.companyId ?? this.companyId, type: payload.type, payload: payload.payload, correlation_id: payload.correlationId ?? null, causation_id: payload.causationId ?? null, occurred_at: payload.occurredAt});
        return fail("Publishing event", error);
      }
      case "memory.remember": {
        const {error} = await this.client.from("memories").insert({company_id: payload.companyId, kind: payload.kind, subject: payload.subject, content: payload.content, importance: payload.importance, valid_from: payload.validFrom ?? null, valid_to: payload.validTo ?? null});
        return fail("Storing memory", error);
      }
      case "prospects.upsert": {
        const {data, error} = await this.client.from("prospects").upsert({
          company_id: payload.companyId, source: payload.source, source_ref: payload.sourceRef, fingerprint: payload.fingerprint,
          name: payload.name, category: payload.category, address: payload.address, country_code: payload.address.countryCode,
          timezone: payload.timezone, declared_website: payload.declaredWebsite, social_profiles: payload.socialProfiles,
          attribution: payload.attribution ?? null, discovered_at: payload.discoveredAt, retain_until: payload.retainUntil
        }, {onConflict: "company_id,source,source_ref"}).select("id").single();
        fail("Storing prospect", error);
        this.prospectIds.set(payload.id, data!.id as string);
        if (payload.contacts?.length) {
          const {error: contactError} = await this.client.from("prospect_contacts").upsert(payload.contacts.map((contact: ContactPoint) => ({prospect_id: data!.id, channel: contact.channel, value: contact.value, publicly_listed: contact.publiclyListed, consent: contact.consent, source: contact.source, collected_at: contact.collectedAt})), {onConflict: "prospect_id,channel,value"});
          fail("Storing prospect contacts", contactError);
        }
        return;
      }
      case "prospects.presence_assessed": {
        const {error} = await this.client.from("presence_assessments").insert({company_id: payload.companyId, prospect_id: await this.prospectUuid(payload.prospectId), website: payload.website, app: payload.app, gap_score: payload.gapScore, confidence: payload.confidence, signals: payload.signals, assessed_at: payload.assessedAt});
        return fail("Storing presence assessment", error);
      }
      case "demo_sites.record": {
        const {error} = await this.client.from("demo_sites").upsert({id: payload.id, company_id: payload.companyId, prospect_id: await this.prospectUuid(payload.prospectId), content: payload.content, disclosure: payload.disclosure, checksum: payload.checksum, preview_url: payload.previewUrl, takedown_token: payload.takedownToken, indexable: false, status: "published", built_at: payload.builtAt});
        return fail("Storing preview record", error);
      }
      case "demo_sites.removed": {
        const {error} = await this.client.from("demo_sites").update({status: "removed", removed_at: new Date().toISOString(), removal_reason: payload.reason}).eq("id", payload.siteId);
        return fail("Recording preview takedown", error);
      }
      case "outreach.messages": {
        const {error} = await this.client.from("outreach_messages").upsert({
          company_id: payload.companyId, prospect_id: await this.prospectUuid(payload.prospectId), demo_site_id: payload.demoSiteId ?? null,
          channel: payload.channel, recipient: payload.to, touch: payload.touch, subject: payload.subject, body: payload.body,
          sender_identity_block: payload.senderIdentityBlock, contact_source_disclosure: payload.contactSourceDisclosure,
          opt_out_instruction: payload.optOutInstruction, compliance: {warnings: payload.warnings ?? []},
          status: payload.status ?? "pending_approval", approval_id: asUuid(payload.approvalId), composed_at: payload.composedAt
        }, {onConflict: "company_id,prospect_id,touch"});
        return fail("Storing outreach message", error);
      }
      case "outreach.approval_linked": {
        const {error} = await this.client.from("outreach_messages").update({approval_id: asUuid(payload.approvalId)}).eq("company_id", payload.companyId).eq("prospect_id", await this.prospectUuid(payload.prospectId)).eq("touch", payload.touch);
        return fail("Linking approval", error);
      }
      case "outreach.touches": {
        const {error} = await this.client.from("outreach_messages").update({status: payload.outcome, sent_at: payload.sentAt, approval_id: asUuid(payload.approvalId)})
          .eq("company_id", payload.companyId).eq("prospect_id", await this.prospectUuid(payload.prospectId)).eq("touch", payload.touch ?? 1);
        return fail("Recording outreach touch", error);
      }
      case "growth.campaign_signals":
        return this.recordEvent("growth.campaign_signal", payload);
      case "integration.requested": case "integration.completed": case "integration.failed": {
        const {error} = await this.client.from("integration_runs").upsert({company_id: this.companyId, operation: `${payload.provider}.${payload.operation}`, idempotency_key: payload.idempotencyKey, request: {provider: payload.provider, operation: payload.operation}, response: payload.result ?? payload.error ?? null, status: operation.split(".")[1]}, {onConflict: "company_id,idempotency_key"});
        return fail("Recording integration run", error);
      }
      default:
        return this.recordEvent(operation, payload);
    }
  }
}

export class SupabaseSuppressionList implements SuppressionList {
  constructor(private readonly client: SupabaseClient) {}
  async contains(input: {companyId: string; value: string}) {
    const {data, error} = await this.client.from("outreach_suppression").select("value_hash").eq("company_id", input.companyId).eq("value_hash", suppressionHash(input.value)).maybeSingle();
    fail("Checking suppression list", error);
    return Boolean(data);
  }
  async add(input: {companyId: string; value: string; reason: string; at: string}) {
    const {error} = await this.client.from("outreach_suppression").upsert({company_id: input.companyId, value_hash: suppressionHash(input.value), reason: input.reason, created_at: input.at}, {onConflict: "company_id,value_hash"});
    fail("Adding to suppression list", error);
  }
}

export type ApprovalRecord = {id: string; kind: string; subject: string; status: "pending" | "approved" | "rejected"; payload: unknown; requested_at: string; decided_by: string | null};

export class SupabaseApprovalGate implements ApprovalGate {
  constructor(private readonly client: SupabaseClient) {}
  async request(input: {companyId: string; kind: string; subject: string; payload: unknown; idempotencyKey: string}) {
    const {error} = await this.client.from("approvals").upsert({company_id: input.companyId, kind: input.kind, subject: input.subject, payload: input.payload, idempotency_key: input.idempotencyKey}, {onConflict: "company_id,idempotency_key", ignoreDuplicates: true});
    fail("Requesting approval", error);
    const {data, error: readError} = await this.client.from("approvals").select("id, status, decided_by").eq("company_id", input.companyId).eq("idempotency_key", input.idempotencyKey).single();
    fail("Reading approval", readError);
    return {approvalId: data!.id as string, status: data!.status as "pending" | "approved" | "rejected", ...(data!.decided_by ? {approvedBy: data!.decided_by as string} : {})};
  }
  async list(companyId: string, status: "pending" | "approved" | "rejected" = "pending") {
    const {data, error} = await this.client.from("approvals").select("id, kind, subject, status, payload, requested_at, decided_by").eq("company_id", companyId).eq("status", status).order("requested_at", {ascending: true});
    fail("Listing approvals", error);
    return (data ?? []) as ApprovalRecord[];
  }
  async decide(input: {approvalId: string; companyId: string; status: "approved" | "rejected"; decidedBy: string; note?: string}) {
    const {data, error} = await this.client.from("approvals").update({status: input.status, decided_by: input.decidedBy, decided_at: new Date().toISOString(), note: input.note ?? null}).eq("id", input.approvalId).eq("company_id", input.companyId).eq("status", "pending").select("id, subject, status").maybeSingle();
    fail("Deciding approval", error);
    if (!data) throw new Error(`Approval ${input.approvalId} is not pending for this company`);
    return data as {id: string; subject: string; status: string};
  }
}
