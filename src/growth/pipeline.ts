import { randomUUID } from "node:crypto";
import type { Agent, Store } from "../domain.js";
import { AuthorityEngine } from "../authority.js";
import { ConvergenceMonitor, type WorkSignal } from "../convergence.js";
import type { PersistentEventBus } from "../event-bus.js";
import type { MemoryFabric } from "../memory.js";
import { OutreachComplianceGate } from "./compliance.js";
import type { DemoSiteBuilder, DemoSitePublisher } from "./demo-site.js";
import type { ApprovalGate, BusinessProspect, ContactPoint, OutreachChannel, OutreachTouch } from "./domain.js";
import type { BusinessDirectorySource, ProspectDiscovery } from "./discovery.js";
import type { OutreachComposer, OutreachSender } from "./outreach.js";
import { qualify, type WebPresenceAssessor } from "./presence.js";

export type PipelineDeps = {
  store: Store; bus: PersistentEventBus; memory: MemoryFabric; discovery: ProspectDiscovery; assessor: WebPresenceAssessor;
  builder: DemoSiteBuilder; publisher: DemoSitePublisher; composer: OutreachComposer; sender: OutreachSender;
  gate: OutreachComplianceGate; approvals: ApprovalGate; authority?: AuthorityEngine; convergence?: ConvergenceMonitor; clock?: () => Date;
};

export type PipelineResult = {
  discovered: number; qualified: number; previewsPublished: number; queuedForApproval: number; sent: number;
  stopped: {stopped: boolean; reason: string};
  skipped: Array<{prospectId: string; stage: string; reasons: string[]}>;
  failed: Array<{prospectId: string; stage: string; error: string}>;
};

const CHANNEL_PREFERENCE: OutreachChannel[] = ["email", "contact_form", "postal", "phone", "messaging"];

export class WebsiteOutreachPipeline {
  private readonly authority: AuthorityEngine;
  private readonly convergence: ConvergenceMonitor;
  private readonly clock: () => Date;
  constructor(private readonly deps: PipelineDeps) {
    this.authority = deps.authority ?? new AuthorityEngine();
    this.convergence = deps.convergence ?? new ConvergenceMonitor();
    this.clock = deps.clock ?? (() => new Date());
  }

  private async emit(companyId: string, type: string, payload: unknown, correlationId: string) {
    await this.deps.bus.publish({id: randomUUID(), companyId, type, payload, occurredAt: this.clock().toISOString(), correlationId});
  }

  private pickContact(prospect: BusinessProspect): ContactPoint | null {
    for (const channel of CHANNEL_PREFERENCE) { const contact = prospect.contacts.find(candidate => candidate.channel === channel); if (contact) return contact; }
    return null;
  }

  async run(input: {companyId: string; agent: Agent; query: string; area: string; limit: number; sources: BusinessDirectorySource[]}): Promise<PipelineResult> {
    const correlationId = randomUUID();
    const result: PipelineResult = {discovered: 0, qualified: 0, previewsPublished: 0, queuedForApproval: 0, sent: 0, stopped: {stopped: false, reason: ""}, skipped: [], failed: []};

    let sendRequiresHuman = false;
    for (const capability of ["prospecting.discover", "demo.publish", "outreach.send"]) {
      const decision = this.authority.evaluate(input.agent, capability, capability === "outreach.send" ? "medium" : "low");
      if (!decision.allowed) { result.stopped = {stopped: true, reason: `${input.agent.name} lacks ${capability}: ${decision.reason}`}; return result; }
      if (capability === "outreach.send") sendRequiresHuman = decision.requiresHuman;
    }
    const history = await this.deps.store.query<WorkSignal[]>("growth.campaign_signals", {companyId: input.companyId, campaign: "website_outreach"}) ?? [];
    const converging = this.convergence.assess(history);
    if (!converging.continue) { result.stopped = {stopped: true, reason: converging.reason}; await this.emit(input.companyId, "growth.campaign_halted", {reason: converging.reason}, correlationId); return result; }

    const discovery = await this.deps.discovery.discover({companyId: input.companyId, query: input.query, area: input.area, limit: input.limit, sources: input.sources});
    result.discovered = discovery.prospects.length;
    await this.emit(input.companyId, "prospect.batch_discovered", {count: result.discovered, rejected: discovery.rejected, sources: discovery.sourcesUsed}, correlationId);

    const touches = await this.deps.store.query<OutreachTouch[]>("outreach.touches", {companyId: input.companyId}) ?? [];
    const today = this.clock().toISOString().slice(0, 10);
    let sentToday = await this.deps.store.query<number>("outreach.sent_today", {companyId: input.companyId, day: today}) ?? 0;

    for (const prospect of discovery.prospects) {
      try {
        const assessment = await this.deps.assessor.assess(prospect);
        await this.deps.store.append("prospects.presence_assessed", {companyId: input.companyId, ...assessment});
        const qualification = qualify(assessment);
        if (!qualification.qualified) { result.skipped.push({prospectId: prospect.id, stage: "qualify", reasons: qualification.reasons}); continue; }
        result.qualified += 1;

        const contact = this.pickContact(prospect);
        if (!contact) { result.skipped.push({prospectId: prospect.id, stage: "contact", reasons: ["No publicly listed contact point"]}); continue; }
        const precheck = await this.deps.gate.evaluate({prospect, contact, history: touches, sentToday, now: this.clock()});
        if (!precheck.allowed) { await this.emit(input.companyId, "outreach.blocked", {prospectId: prospect.id, stage: "precheck", violations: precheck.violations}, correlationId); result.skipped.push({prospectId: prospect.id, stage: "compliance", reasons: precheck.violations}); continue; }

        const built = await this.deps.builder.build({prospect, assessment});
        const site = await this.deps.publisher.publish({companyId: input.companyId, site: built, prospect});
        result.previewsPublished += 1;
        await this.deps.store.append("demo_sites.record", {companyId: input.companyId, ...site, html: "[stored by hosting adapter]"});
        await this.emit(input.companyId, "demo.published", {prospectId: prospect.id, siteId: site.id, previewUrl: site.previewUrl, indexable: false}, correlationId);

        const touch = touches.filter(entry => entry.prospectId === prospect.id).length + 1;
        const message = await this.deps.composer.compose({prospect, assessment, site, contact, touch});
        const verdict = await this.deps.gate.evaluate({prospect, contact, message, history: touches, sentToday, now: this.clock()});
        if (!verdict.allowed) {
          await this.deps.publisher.unpublish({siteId: site.id, reason: "Outreach blocked by compliance; preview removed"});
          await this.emit(input.companyId, "outreach.blocked", {prospectId: prospect.id, stage: "message", violations: verdict.violations}, correlationId);
          result.skipped.push({prospectId: prospect.id, stage: "compliance", reasons: verdict.violations});
          continue;
        }
        await this.deps.store.append("outreach.messages", {companyId: input.companyId, demoSiteId: site.id, ...message, warnings: verdict.warnings, status: "pending_approval"});

        const approval = sendRequiresHuman || verdict.requiresHuman
          ? await this.deps.approvals.request({companyId: input.companyId, kind: "outreach.send", subject: `${prospect.name} (${contact.channel})`, payload: {message, assessment, previewUrl: site.previewUrl, warnings: verdict.warnings}, idempotencyKey: `approval:outreach:${prospect.id}:${touch}`})
          : {approvalId: "auto", status: "approved" as const, approvedBy: input.agent.id};
        if (approval.status !== "approved") {
          result.queuedForApproval += 1;
          await this.emit(input.companyId, "outreach.approval_requested", {prospectId: prospect.id, approvalId: approval.approvalId, previewUrl: site.previewUrl}, correlationId);
          continue;
        }

        await this.deps.sender.send({message, approvedBy: approval.approvedBy ?? "human"});
        sentToday += 1;
        result.sent += 1;
        const sentAt = this.clock().toISOString();
        touches.push({prospectId: prospect.id, channel: message.channel, sentAt, outcome: "sent"});
        await this.deps.store.append("outreach.touches", {companyId: input.companyId, prospectId: prospect.id, channel: message.channel, sentAt, outcome: "sent", approvalId: approval.approvalId});
        await this.emit(input.companyId, "outreach.sent", {prospectId: prospect.id, channel: message.channel, previewUrl: site.previewUrl, approvalId: approval.approvalId}, correlationId);
        await this.deps.memory.remember({companyId: input.companyId, kind: "relationship", subject: prospect.name, content: `Sent a first-contact website preview to ${prospect.name} (${prospect.address.locality}) on ${sentAt}. Evidence of gap: ${assessment.signals.map(signal => signal.observation).join("; ")}.`, importance: .4, sourceIds: []});
      } catch (error) {
        result.failed.push({prospectId: prospect.id, stage: "pipeline", error: String(error)});
        await this.emit(input.companyId, "growth.pipeline_error", {prospectId: prospect.id, error: String(error)}, correlationId);
      }
    }

    await this.deps.store.append("growth.campaign_signals", {companyId: input.companyId, campaign: "website_outreach", fingerprint: `${input.query}|${input.area}`, goalId: "website_outreach", progress: result.discovered ? result.sent / result.discovered : 0, cost: result.discovered, at: this.clock().getTime()});
    await this.emit(input.companyId, "growth.campaign_run_completed", result, correlationId);
    return result;
  }
}
