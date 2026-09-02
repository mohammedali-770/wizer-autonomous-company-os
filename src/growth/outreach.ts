import type { ReasoningModel } from "../domain.js";
import type { IntegrationGateway } from "../integrations.js";
import { OUTREACH_COPY_SCHEMA, type BusinessProspect, type ContactPoint, type DemoSite, type OutreachMessage, type OutreachPolicy, type PresenceAssessment } from "./domain.js";

const FORBIDDEN_CLAIMS: Array<{pattern: RegExp; description: string}> = [
  {pattern: /\bas (?:you )?requested\b|\byou asked (?:us )?(?:for|to)\b/i, description: "implies the business commissioned this work"},
  {pattern: /\byour (?:new )?(?:website|site) is (?:now )?live\b|\bwe(?:'ve| have) (?:updated|launched|published) your\b/i, description: "implies the preview is the business's own live site"},
  {pattern: /\b(?:on behalf of|official (?:page|site) (?:for|of))\b/i, description: "implies affiliation with the business"},
  {pattern: /\b(?:expires|offer ends|last chance|act now|only \d+ (?:spots|hours|days) left)\b/i, description: "manufactured urgency"},
  {pattern: /\byour (?:google|facebook|instagram) (?:listing|account) will\b/i, description: "implies consequences for the business's other accounts"}
];

export const validateOutreachCopy = (input: {subject: string; body: string}) =>
  FORBIDDEN_CLAIMS.filter(claim => claim.pattern.test(`${input.subject}\n${input.body}`)).map(claim => `Outreach copy ${claim.description}`);

export const renderOutreachMessage = (message: OutreachMessage) =>
  [message.body.trim(), `Preview (unlisted, nothing published in your name): ${message.previewUrl}`, message.contactSourceDisclosure, message.senderIdentityBlock, message.optOutInstruction].join("\n\n");

export class OutreachComposer {
  constructor(private readonly model: ReasoningModel, private readonly policy: OutreachPolicy, private readonly clock: () => Date = () => new Date()) {}

  private mandatedBlocks(prospect: BusinessProspect, contact: ContactPoint) {
    const {legalName, postalAddress, replyToEmail, websiteUrl} = this.policy.senderIdentity;
    return {
      contactSourceDisclosure: `We found ${contact.channel === "email" ? "this address" : "these details"} on your public ${prospect.source} listing. We have not published anything in your name and the preview is not search-indexed.`,
      senderIdentityBlock: `${legalName} · ${websiteUrl} · ${postalAddress}`,
      optOutInstruction: `If you would rather not hear from us, reply "stop" to ${replyToEmail} and we will delete the preview and your details, and never contact you again.`
    };
  }

  async compose(input: {prospect: BusinessProspect; assessment: PresenceAssessment; site: DemoSite; contact: ContactPoint; touch: number}): Promise<OutreachMessage> {
    const {prospect, assessment, site, contact} = input;
    if (!site.previewUrl) throw new Error("Cannot compose outreach before the preview is published");
    const raw = await this.model.complete([
      {role: "system", content: `You write one short, honest first-contact message from ${this.policy.senderIdentity.legalName} to a small business that has no working website. Say plainly that this is an unrequested message, that you built a free one-page preview from their public listing, and that they can have it, change it, or ignore it. No hype, no urgency, no claims about their business, no suggestion they asked for this or that anything was published in their name. Under 120 words, plain text, no links (the link is appended for you). Return only JSON: {subject, body}.`},
      {role: "user", content: JSON.stringify({business: {name: prospect.name, category: prospect.category, locality: prospect.address.locality}, whyContacted: assessment.signals.map(signal => signal.observation), previewHeadline: site.content.headline, openQuestions: site.content.placeholders})}
    ], {temperature: .4, responseSchema: OUTREACH_COPY_SCHEMA});
    const copy = JSON.parse(raw) as {subject: string; body: string};
    const violations = validateOutreachCopy(copy);
    if (violations.length) throw new Error(`Outreach copy rejected: ${violations.join("; ")}`);
    return {prospectId: prospect.id, channel: contact.channel, to: contact.value, subject: copy.subject, body: copy.body, previewUrl: site.previewUrl, touch: input.touch, composedAt: this.clock().toISOString(), ...this.mandatedBlocks(prospect, contact)};
  }
}

export class OutreachSender {
  constructor(private readonly gateway: IntegrationGateway, private readonly provider = "outreach_channel") {}

  async send(input: {message: OutreachMessage; approvedBy: string}) {
    const {message} = input;
    return this.gateway.execute({
      provider: this.provider, operation: `send.${message.channel}`,
      payload: {to: message.to, subject: message.subject, text: renderOutreachMessage(message), previewUrl: message.previewUrl},
      idempotencyKey: `outreach:${message.prospectId}:${message.touch}`, approvedBy: input.approvedBy
    });
  }
}
