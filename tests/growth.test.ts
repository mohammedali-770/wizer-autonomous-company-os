import {beforeEach, describe, expect, it, vi} from "vitest";
import {APPROVED_AGENTS, AuthorityEngine, MemoryFabric, PersistentEventBus, IntegrationGateway, type Store} from "../src/index.js";
import {BusinessProspect, DemoSiteBuilder, DemoSitePublisher, OutreachComplianceGate, OutreachComposer, OutreachSender, OptOutHandler, ProspectDiscovery, WebPresenceAssessor, WebsiteOutreachPipeline, qualify, renderOutreachMessage, validateDemoContent, validateOutreachCopy, type BusinessDirectorySource, type OutreachPolicy, type SuppressionList} from "../src/growth/index.js";

const NOW = new Date("2026-09-02T12:00:00Z");
const clock = () => NOW;
const prospect = (overrides: Partial<ReturnType<typeof BusinessProspect.parse>> = {}) => BusinessProspect.parse({
  id: "osm:1", companyId: "c1", source: "osm", sourceRef: "1", name: "Zahra Bakery", category: "bakery",
  address: {line: "12 Mill Road", locality: "Manchester", region: "England", postalCode: "M1 2AB", countryCode: "GB"},
  timezone: "Europe/London", declaredWebsite: null, socialProfiles: [], discoveredAt: NOW.toISOString(),
  contacts: [{channel: "email", value: "hello@zahrabakery.co.uk", publiclyListed: true, consent: "none", source: "osm", collectedAt: NOW.toISOString()}],
  ...overrides
});
const policy: OutreachPolicy = {
  senderIdentity: {legalName: "Wizer Ltd", postalAddress: "1 Example Street, Manchester M1 1AA", replyToEmail: "hello@wizer.example", websiteUrl: "https://wizer.example"},
  allowedChannels: ["email", "contact_form"], jurisdictions: {GB: {unsolicitedBusinessEmail: "opt_out_allowed", phoneRequiresRegistryCheck: true}, DE: {unsolicitedBusinessEmail: "consent_required", phoneRequiresRegistryCheck: true}},
  maxTouchesPerProspect: 2, minDaysBetweenTouches: 7, quietHours: {startHour: 20, endHour: 8}, dailySendCap: 25, requireHumanApproval: true
};
const emptySuppression = (): SuppressionList => ({contains: async () => false, add: async () => {}});
const store = (): Store => ({query: async <T,>() => undefined as T, append: vi.fn(async () => {})});
const probe = (over: Partial<{resolves: boolean; status: number; title: string; textLength: number}> = {}) => ({
  resolve: async () => ({resolves: over.resolves ?? true}),
  fetch: async (url: string) => ({status: over.status ?? 200, finalUrl: url, title: over.title ?? "Zahra Bakery", textLength: over.textLength ?? 2400})
});

describe("presence assessment", () => {
  it("treats a missing website field as the strongest gap", async () => {
    const assessment = await new WebPresenceAssessor(probe(), null, clock).assess(prospect());
    expect(assessment.website).toBe("none");
    expect(qualify(assessment).qualified).toBe(true);
  });
  it("classifies a listed social page as social-only, not a website", async () => {
    const assessment = await new WebPresenceAssessor(probe(), null, clock).assess(prospect({declaredWebsite: "https://facebook.com/zahrabakery"}));
    expect(assessment.website).toBe("social_only");
  });
  it("classifies a parked or empty domain as broken", async () => {
    const assessment = await new WebPresenceAssessor(probe({title: "Coming soon", textLength: 40}), null, clock).assess(prospect({declaredWebsite: "https://zahrabakery.co.uk"}));
    expect(assessment.website).toBe("broken");
  });
  it("disqualifies a business that already has a working site", async () => {
    const assessment = await new WebPresenceAssessor(probe(), null, clock).assess(prospect({declaredWebsite: "https://zahrabakery.co.uk"}));
    expect(assessment.website).toBe("owned");
    expect(qualify(assessment).qualified).toBe(false);
  });
});

describe("discovery", () => {
  const source = (terms: Partial<BusinessDirectorySource["terms"]> = {}): BusinessDirectorySource => ({
    name: "osm", terms: {permitsDerivedStorage: true, maxRetentionDays: 90, attributionRequired: true, termsUrl: "https://osm.example/terms", ...terms},
    search: async () => ({records: [
      {sourceRef: "1", name: "Zahra Bakery", address: {locality: "Manchester", postalCode: "M1 2AB", countryCode: "GB"}},
      {sourceRef: "2", name: "Zahra  bakery!", address: {locality: "Manchester", postalCode: "M1 2AB", countryCode: "GB"}},
      {sourceRef: "3", name: "No Country Cafe"}
    ]})
  });
  it("deduplicates by normalized identity and refuses records without a jurisdiction", async () => {
    const report = await new ProspectDiscovery(store(), clock).discover({companyId: "c1", query: "bakery", area: "Manchester", limit: 10, sources: [source()]});
    expect(report.prospects).toHaveLength(1);
    expect(report.rejected.map(entry => entry.reason)).toEqual([expect.stringContaining("Duplicate"), expect.stringContaining("no country")]);
  });
  it("refuses to store derived records from sources whose terms forbid it", async () => {
    const report = await new ProspectDiscovery(store(), clock).discover({companyId: "c1", query: "bakery", area: "Manchester", limit: 10, sources: [source({permitsDerivedStorage: false})]});
    expect(report.prospects).toHaveLength(0);
    expect(report.rejected[0]!.reason).toContain("forbids derived storage");
  });
});

describe("demo site", () => {
  const content = {headline: "Zahra Bakery, Manchester", subheadline: "Fresh bakery on Mill Road", about: "Zahra Bakery is a bakery in Manchester.", sections: [{title: "Visit", body: "Find us on Mill Road in Manchester."}], callToAction: "Get this site", placeholders: ["What are your opening hours?"]};
  it("rejects invented facts about the business", () => {
    expect(validateDemoContent({...content, about: "Award-winning bakery serving Manchester since 1994, open 7am to 6pm."}, prospect())).toEqual([
      expect.stringContaining("opening hours"), expect.stringContaining("founding dates"), expect.stringContaining("rankings")
    ]);
  });
  it("rejects contact details that are not in the verified record", () => {
    expect(validateDemoContent({...content, about: "Call us on +44 7700 900123."}, prospect())[0]).toContain("invents a contact detail");
  });
  it("builds a non-indexable, disclosed preview and refuses to publish without both", async () => {
    const model = {complete: vi.fn(async () => JSON.stringify(content))};
    const site = await new DemoSiteBuilder(model, {legalName: "Wizer Ltd", websiteUrl: "https://wizer.example", replyToEmail: "hello@wizer.example", takedownUrl: "https://wizer.example/remove"}, clock).build({prospect: prospect(), assessment: {prospectId: "osm:1", website: "none", app: "none", gapScore: 1, confidence: .8, signals: [], assessedAt: NOW.toISOString()}});
    expect(site.html).toContain('content="noindex,nofollow,noarchive"');
    expect(site.disclosure).toContain("Not affiliated with");
    const gateway = {execute: vi.fn(async () => ({url: "https://preview.wizer.example/abc"}))} as unknown as IntegrationGateway;
    await expect(new DemoSitePublisher(gateway).publish({companyId: "c1", site: {...site, html: "<html></html>"}, prospect: prospect()})).rejects.toThrow(/non-indexable/);
    expect((await new DemoSitePublisher(gateway).publish({companyId: "c1", site, prospect: prospect()})).previewUrl).toBe("https://preview.wizer.example/abc");
  });
  it("refuses model copy that claims the business commissioned the work", () => {
    expect(validateOutreachCopy({subject: "Your new site", body: "As requested, your new website is live."}).length).toBe(2);
  });
});

describe("compliance gate", () => {
  let gate: OutreachComplianceGate;
  beforeEach(() => { gate = new OutreachComplianceGate(policy, emptySuppression()); });
  const contact = () => prospect().contacts[0]!;
  const message = (over: Record<string, unknown> = {}) => ({
    prospectId: "osm:1", channel: "email" as const, to: "hello@zahrabakery.co.uk", subject: "A free one-page preview for Zahra Bakery",
    body: "We built a preview you can keep or ignore.", previewUrl: "https://preview.wizer.example/abc",
    senderIdentityBlock: "Wizer Ltd · https://wizer.example · 1 Example Street, Manchester M1 1AA",
    contactSourceDisclosure: "We found this address on your public osm listing.",
    optOutInstruction: "Reply stop and we delete everything.", touch: 1, composedAt: NOW.toISOString(), ...over
  });
  it("allows a compliant first contact but still demands human approval", async () => {
    const verdict = await gate.evaluate({prospect: prospect(), contact: contact(), message: message(), history: [], sentToday: 0, now: NOW});
    expect(verdict).toMatchObject({allowed: true, requiresHuman: true, violations: []});
  });
  it("blocks suppressed contacts", async () => {
    const suppressed = new OutreachComplianceGate(policy, {contains: async () => true, add: async () => {}});
    expect((await suppressed.evaluate({prospect: prospect(), contact: contact(), history: [], sentToday: 0, now: NOW})).violations).toContain("Contact is on the suppression list");
  });
  it("blocks unsolicited email where the jurisdiction requires consent", async () => {
    const german = prospect({address: {line: "", locality: "Berlin", region: "", postalCode: "10115", countryCode: "DE"}});
    expect((await gate.evaluate({prospect: german, contact: contact(), history: [], sentToday: 0, now: NOW})).violations[0]).toContain("requires prior consent");
  });
  it("fails closed on an unconfigured country", async () => {
    const other = prospect({address: {line: "", locality: "Amman", region: "", postalCode: "11118", countryCode: "JO"}});
    expect((await gate.evaluate({prospect: other, contact: contact(), history: [], sentToday: 0, now: NOW})).violations[0]).toContain("No outreach rules configured");
  });
  it("enforces frequency caps, prior opt-out, and daily caps", async () => {
    const recent = await gate.evaluate({prospect: prospect(), contact: contact(), history: [{prospectId: "osm:1", channel: "email", sentAt: "2026-08-30T12:00:00Z", outcome: "sent"}], sentToday: 0, now: NOW});
    expect(recent.violations[0]).toContain("less than 7 days ago");
    const optedOut = await gate.evaluate({prospect: prospect(), contact: contact(), history: [{prospectId: "osm:1", channel: "email", sentAt: "2026-01-01T12:00:00Z", outcome: "opted_out"}], sentToday: 0, now: NOW});
    expect(optedOut.violations).toContain("Business already opted out of outreach");
    const capped = await gate.evaluate({prospect: prospect(), contact: contact(), history: [], sentToday: 25, now: NOW});
    expect(capped.violations[0]).toContain("Daily send cap");
  });
  it("rejects messages missing identity, opt-out, or an honest subject", async () => {
    const bad = await gate.evaluate({prospect: prospect(), contact: contact(), message: message({optOutInstruction: " ", senderIdentityBlock: "Wizer Ltd", subject: "Re: your invoice", previewUrl: "http://preview.wizer.example/abc"}), history: [], sentToday: 0, now: NOW});
    expect(bad.allowed).toBe(false);
    expect(bad.violations).toEqual([
      "Message has no opt-out instruction", "Message does not carry the sender's postal address",
      "Preview link must be an https URL", "Subject line imitates a reply or a transactional notice"
    ]);
  });
  it("blocks contact details that were never publicly listed", async () => {
    const scraped = {...contact(), publiclyListed: false};
    expect((await gate.evaluate({prospect: prospect(), contact: scraped, history: [], sentToday: 0, now: NOW})).violations).toContain("Contact detail was not publicly listed by the business and no opt-in exists");
  });
  it("refuses to dial before a do-not-call registry check", async () => {
    const phoneGate = new OutreachComplianceGate({...policy, allowedChannels: ["phone"], quietHours: {startHour: 23, endHour: 0}}, emptySuppression());
    const phone = {channel: "phone" as const, value: "+441610000000", publiclyListed: true, consent: "none" as const, source: "osm", collectedAt: NOW.toISOString()};
    expect((await phoneGate.evaluate({prospect: prospect(), contact: phone, history: [], sentToday: 0, now: NOW})).violations[0]).toContain("do-not-call registry");
  });
});

describe("opt-out", () => {
  it("suppresses the business and takes the preview down", async () => {
    const added: string[] = [], takedown = vi.fn(async () => ({}));
    const handler = new OptOutHandler({contains: async () => false, add: async input => { added.push(input.value); }}, takedown);
    const result = await handler.handle({companyId: "c1", prospectId: "osm:1", contactValue: "hello@zahrabakery.co.uk", reason: "replied stop", at: NOW.toISOString()});
    expect(added).toEqual(["hello@zahrabakery.co.uk", "osm:1"]);
    expect(takedown).toHaveBeenCalledOnce();
    expect(result.previewRemoved).toBe(true);
  });
});

describe("pipeline", () => {
  const source: BusinessDirectorySource = {
    name: "osm", terms: {permitsDerivedStorage: true, maxRetentionDays: 90, attributionRequired: true, termsUrl: "https://osm.example/terms"},
    search: async () => ({records: [{sourceRef: "1", name: "Zahra Bakery", category: "bakery", timezone: "Europe/London", address: {line: "12 Mill Road", locality: "Manchester", postalCode: "M1 2AB", countryCode: "GB"}, contacts: [{channel: "email", value: "hello@zahrabakery.co.uk", publiclyListed: true, consent: "none", source: "osm", collectedAt: NOW.toISOString()}]}]})
  };
  const build = (approvalStatus: "pending" | "approved") => {
    const backing = store();
    const gateway = {execute: vi.fn(async (input: {operation: string}) => input.operation === "publish_preview" ? {url: "https://preview.wizer.example/abc"} : {id: "sent-1"})} as unknown as IntegrationGateway;
    const model = {complete: vi.fn(async (messages: Array<{content: string}>) => messages[0]!.content.includes("website preview")
      ? JSON.stringify({headline: "Zahra Bakery, Manchester", subheadline: "A bakery on Mill Road", about: "Zahra Bakery is a bakery in Manchester.", sections: [], callToAction: "Get this site", placeholders: ["What are your opening hours?"]})
      : JSON.stringify({subject: "A one-page preview for Zahra Bakery", body: "You did not ask for this message. We made a free preview from your public listing; keep it, change it, or ignore it."}))};
    const bus = new PersistentEventBus(backing);
    const sender = {legalName: "Wizer Ltd", websiteUrl: "https://wizer.example", replyToEmail: "hello@wizer.example", takedownUrl: "https://wizer.example/remove"};
    const pipeline = new WebsiteOutreachPipeline({
      store: backing, bus, memory: new MemoryFabric(backing), discovery: new ProspectDiscovery(backing, clock),
      assessor: new WebPresenceAssessor(probe(), null, clock), builder: new DemoSiteBuilder(model, sender, clock),
      publisher: new DemoSitePublisher(gateway), composer: new OutreachComposer(model, policy, clock), sender: new OutreachSender(gateway),
      gate: new OutreachComplianceGate(policy, emptySuppression()), approvals: {request: async () => ({approvalId: "a1", status: approvalStatus, approvedBy: approvalStatus === "approved" ? "user-1" : undefined})},
      clock
    });
    return {pipeline, gateway, events: backing.append as ReturnType<typeof vi.fn>};
  };
  const maha = APPROVED_AGENTS.find(agent => agent.name === "Maha")!;

  it("publishes a preview and queues the send for a human instead of sending it", async () => {
    const {pipeline, gateway} = build("pending");
    const result = await pipeline.run({companyId: "c1", agent: maha, query: "bakery", area: "Manchester", limit: 5, sources: [source]});
    expect(result).toMatchObject({discovered: 1, qualified: 1, previewsPublished: 1, queuedForApproval: 1, sent: 0});
    expect((gateway.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0].operation)).toEqual(["publish_preview"]);
  });
  it("sends only once a human has approved", async () => {
    const {pipeline, gateway} = build("approved");
    const result = await pipeline.run({companyId: "c1", agent: maha, query: "bakery", area: "Manchester", limit: 5, sources: [source]});
    expect(result.sent).toBe(1);
    const send = (gateway.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]).find(call => call.operation === "send.email");
    expect(send.approvedBy).toBe("user-1");
    expect(send.payload.text).toContain("reply \"stop\"");
    expect(send.payload.text).toContain("1 Example Street");
  });
  it("stops before discovery when the agent lacks outreach authority", async () => {
    const {pipeline} = build("approved");
    const jafar = APPROVED_AGENTS.find(agent => agent.name === "Jafar")!;
    expect((await pipeline.run({companyId: "c1", agent: jafar, query: "bakery", area: "Manchester", limit: 5, sources: [source]})).stopped.stopped).toBe(true);
  });
  it("keeps outreach.send behind the human approval boundary for every agent", () => {
    expect(new AuthorityEngine().evaluate(maha, "outreach.send", "low").requiresHuman).toBe(true);
  });
});

describe("rendered message", () => {
  it("always carries the preview link, source disclosure, identity, and opt-out", () => {
    const text = renderOutreachMessage({prospectId: "osm:1", channel: "email", to: "x@y.z", subject: "s", body: "b", previewUrl: "https://preview.wizer.example/abc", senderIdentityBlock: "Wizer Ltd · 1 Example Street", contactSourceDisclosure: "Found on your public listing.", optOutInstruction: "Reply stop.", touch: 1, composedAt: NOW.toISOString()});
    expect(text).toContain("https://preview.wizer.example/abc");
    expect(text).toContain("Found on your public listing.");
    expect(text).toContain("Reply stop.");
  });
});
