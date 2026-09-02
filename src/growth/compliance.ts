import type { BusinessProspect, ContactPoint, OutreachChannel, OutreachMessage, OutreachPolicy, OutreachTouch, SuppressionList } from "./domain.js";

export type ComplianceVerdict = {allowed: boolean; requiresHuman: boolean; violations: string[]; warnings: string[]};

const CONSENT_ONLY_CHANNELS: OutreachChannel[] = ["messaging"];
const MISLEADING_SUBJECT = /^\s*(?:re|fwd?)\s*:|\b(?:invoice|payment (?:due|overdue)|final notice|your account has been|urgent action required)\b/i;

const localHour = (at: Date, timezone: string) => {
  try { return Number(new Intl.DateTimeFormat("en-GB", {timeZone: timezone, hour: "2-digit", hour12: false}).format(at)); }
  catch { return at.getUTCHours(); }
};
const inQuietHours = (hour: number, window: {startHour: number; endHour: number}) =>
  window.startHour <= window.endHour ? hour >= window.startHour && hour < window.endHour : hour >= window.startHour || hour < window.endHour;

export class OutreachComplianceGate {
  constructor(private readonly policy: OutreachPolicy, private readonly suppression: SuppressionList) {}

  async evaluate(input: {prospect: BusinessProspect; contact: ContactPoint; message?: OutreachMessage; history: OutreachTouch[]; sentToday: number; now: Date; phoneRegistryChecked?: boolean}): Promise<ComplianceVerdict> {
    const {prospect, contact, message, history, now} = input, violations: string[] = [], warnings: string[] = [];
    const jurisdiction = this.policy.jurisdictions[prospect.address.countryCode.toUpperCase()];

    if (!this.policy.allowedChannels.includes(contact.channel)) violations.push(`Channel ${contact.channel} is not enabled in the outreach policy`);
    if (await this.suppression.contains({companyId: prospect.companyId, value: contact.value})) violations.push("Contact is on the suppression list");
    if (await this.suppression.contains({companyId: prospect.companyId, value: prospect.id})) violations.push("Business has asked not to be contacted again");
    if (!jurisdiction) violations.push(`No outreach rules configured for country ${prospect.address.countryCode}; refusing to contact on an unknown legal basis`);
    if (jurisdiction && contact.channel === "email" && jurisdiction.unsolicitedBusinessEmail === "consent_required" && contact.consent !== "opt_in") violations.push(`${prospect.address.countryCode} requires prior consent for unsolicited business email`);
    if (jurisdiction && contact.channel === "phone" && jurisdiction.phoneRequiresRegistryCheck && !input.phoneRegistryChecked) violations.push(`${prospect.address.countryCode} requires a do-not-call registry check before dialling`);
    if (CONSENT_ONLY_CHANNELS.includes(contact.channel) && contact.consent !== "opt_in") violations.push(`${contact.channel} outreach requires explicit opt-in`);
    if (!contact.publiclyListed && contact.consent !== "opt_in") violations.push("Contact detail was not publicly listed by the business and no opt-in exists");

    const touches = history.filter(touch => touch.prospectId === prospect.id);
    if (touches.some(touch => touch.outcome === "opted_out")) violations.push("Business already opted out of outreach");
    if (touches.length >= this.policy.maxTouchesPerProspect) violations.push(`Contact limit reached (${touches.length}/${this.policy.maxTouchesPerProspect})`);
    const last = touches.map(touch => Date.parse(touch.sentAt)).sort((a, b) => b - a)[0];
    if (last !== undefined && now.getTime() - last < this.policy.minDaysBetweenTouches * 86400000) violations.push(`Last contact was less than ${this.policy.minDaysBetweenTouches} days ago`);
    if (input.sentToday >= this.policy.dailySendCap) violations.push(`Daily send cap of ${this.policy.dailySendCap} reached`);
    if (["phone", "messaging"].includes(contact.channel) && inQuietHours(localHour(now, prospect.timezone), this.policy.quietHours)) violations.push(`Local time in ${prospect.timezone} is inside configured quiet hours`);

    if (message) {
      if (!message.optOutInstruction.trim()) violations.push("Message has no opt-out instruction");
      if (!message.senderIdentityBlock.includes(this.policy.senderIdentity.legalName)) violations.push("Message does not identify the sender by legal name");
      if (!message.senderIdentityBlock.includes(this.policy.senderIdentity.postalAddress)) violations.push("Message does not carry the sender's postal address");
      if (!message.contactSourceDisclosure.trim()) violations.push("Message does not say where the contact detail came from");
      if (!/^https:\/\//.test(message.previewUrl)) violations.push("Preview link must be an https URL");
      if (MISLEADING_SUBJECT.test(message.subject)) violations.push("Subject line imitates a reply or a transactional notice");
      if (message.body.toLowerCase().includes(`${prospect.name.toLowerCase()} website`) && !message.body.includes("preview")) warnings.push("Body may read as if the preview were the business's own site");
    }
    if (/@(?:gmail|yahoo|hotmail|outlook|icloud)\./i.test(contact.value)) warnings.push("Contact address is a consumer mailbox; treat it as personal data under stricter rules");

    return {allowed: violations.length === 0, requiresHuman: this.policy.requireHumanApproval, violations, warnings};
  }
}

export class OptOutHandler {
  constructor(private readonly suppression: SuppressionList, private readonly onTakedown?: (input: {prospectId: string; reason: string}) => Promise<unknown>) {}

  async handle(input: {companyId: string; prospectId: string; contactValue: string; reason: string; at: string}) {
    await this.suppression.add({companyId: input.companyId, value: input.contactValue, reason: input.reason, at: input.at});
    await this.suppression.add({companyId: input.companyId, value: input.prospectId, reason: input.reason, at: input.at});
    if (this.onTakedown) await this.onTakedown({prospectId: input.prospectId, reason: input.reason});
    return {suppressed: [input.contactValue, input.prospectId], previewRemoved: Boolean(this.onTakedown)};
  }
}
