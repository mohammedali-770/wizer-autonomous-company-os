import { createHash, randomUUID } from "node:crypto";
import type { ReasoningModel } from "../domain.js";
import type { IntegrationGateway } from "../integrations.js";
import { DEMO_SITE_CONTENT_SCHEMA, type BusinessProspect, type DemoSite, type DemoSiteContent, type PresenceAssessment } from "./domain.js";

export type SenderIdentity = {legalName: string; websiteUrl: string; replyToEmail: string; takedownUrl: string};

const UNVERIFIABLE_CLAIMS: Array<{pattern: RegExp; description: string}> = [
  {pattern: /(?:[$€£₹]|\bUSD\b|\bEUR\b|\bAED\b)\s?\d/i, description: "prices"},
  {pattern: /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i, description: "opening hours"},
  {pattern: /\b(?:since|established|est\.)\s+(?:18|19|20)\d{2}\b/i, description: "founding dates"},
  {pattern: /\b(?:award[- ]winning|best in|#\s?1\b|number one|top[- ]rated|five[- ]star|\d(?:\.\d)?\s?stars?)\b/i, description: "rankings or ratings"},
  {pattern: /\b(?:certified|licensed|insured|guaranteed|accredited)\b/i, description: "credentials"},
  {pattern: /\b\d{1,3}(?:,\d{3})*\+?\s+(?:customers|clients|reviews|projects|years)\b/i, description: "track-record numbers"}
];
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character] as string);

export const disclosureFor = (prospect: BusinessProspect, sender: SenderIdentity, takedownToken: string) =>
  `Independent design preview prepared by ${sender.legalName}. Not affiliated with, endorsed by, or authorised by ${prospect.name}, and not an official page of the business. Nothing here is a statement by ${prospect.name}. Removal on request: ${sender.takedownUrl}?token=${takedownToken}`;

export const validateDemoContent = (content: DemoSiteContent, prospect: BusinessProspect) => {
  const violations: string[] = [];
  const prose = [content.headline, content.subheadline, content.about, content.callToAction, ...content.sections.flatMap(section => [section.title, section.body])].join("\n");
  for (const claim of UNVERIFIABLE_CLAIMS) if (claim.pattern.test(prose)) violations.push(`Preview states ${claim.description} that were never verified for this business`);
  const verified = new Set(prospect.contacts.map(contact => contact.value.replace(/[\s()-]/g, "").toLowerCase()));
  for (const found of [...(prose.match(EMAIL_PATTERN) ?? []), ...(prose.match(PHONE_PATTERN) ?? [])])
    if (!verified.has(found.replace(/[\s()-]/g, "").toLowerCase())) violations.push(`Preview invents a contact detail (${found}) that is not in the verified record`);
  if (!content.headline.trim() || !content.about.trim()) violations.push("Preview is missing required headline or about copy");
  return violations;
};

export const renderDemoHtml = (input: {prospect: BusinessProspect; content: DemoSiteContent; disclosure: string; sender: SenderIdentity}) => {
  const {prospect, content, disclosure, sender} = input;
  const placeholders = content.placeholders.length ? `<section class="todo"><h2>For ${escapeHtml(prospect.name)} to confirm</h2><ul>${content.placeholders.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(prospect.name)} — website preview</title>` +
    `<style>:root{color-scheme:light dark;--ink:#14181f;--bg:#fff;--muted:#5b6472;--line:#e3e7ee;--accent:#1c5fd4}@media(prefers-color-scheme:dark){:root{--ink:#eef1f6;--bg:#12151b;--muted:#9aa4b4;--line:#252b36;--accent:#7aa5ff}}` +
    `*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}` +
    `.notice{background:#fff4d6;color:#5b4300;padding:12px 20px;font-size:13px;border-bottom:1px solid #e8d9a8}@media(prefers-color-scheme:dark){.notice{background:#3a2f10;color:#ffe7a8;border-color:#5a4a1c}}` +
    `main{max-width:820px;margin:0 auto;padding:48px 20px 72px}h1{font-size:clamp(28px,5vw,44px);line-height:1.15;margin:0 0 12px}h2{font-size:20px;margin:36px 0 8px}` +
    `.sub{color:var(--muted);font-size:18px;margin:0 0 28px}.cta{display:inline-block;margin-top:28px;background:var(--accent);color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none}` +
    `.todo{margin-top:44px;border:1px dashed var(--line);border-radius:10px;padding:16px 20px;color:var(--muted)}footer{border-top:1px solid var(--line);margin-top:48px;padding-top:20px;color:var(--muted);font-size:13px}</style></head>` +
    `<body><div class="notice">${escapeHtml(disclosure)}</div><main><h1>${escapeHtml(content.headline)}</h1><p class="sub">${escapeHtml(content.subheadline)}</p><p>${escapeHtml(content.about)}</p>` +
    content.sections.map(section => `<h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.body)}</p>`).join("") +
    `<a class="cta" href="mailto:${escapeHtml(sender.replyToEmail)}">${escapeHtml(content.callToAction)}</a>${placeholders}` +
    `<footer>${escapeHtml(prospect.address.line || prospect.address.locality)} · Preview built by <a href="${escapeHtml(sender.websiteUrl)}">${escapeHtml(sender.legalName)}</a>. ` +
    `<a href="${escapeHtml(sender.takedownUrl)}">Ask us to take this preview down</a>.</footer></main></body></html>`;
};

export class DemoSiteBuilder {
  constructor(private readonly model: ReasoningModel, private readonly sender: SenderIdentity, private readonly clock: () => Date = () => new Date()) {}

  async build(input: {prospect: BusinessProspect; assessment: PresenceAssessment}): Promise<DemoSite> {
    const {prospect, assessment} = input;
    const verifiedFacts = {name: prospect.name, category: prospect.category, locality: prospect.address.locality, region: prospect.address.region, countryCode: prospect.address.countryCode, contacts: prospect.contacts.map(contact => ({channel: contact.channel, value: contact.value})), socialProfiles: prospect.socialProfiles};
    const raw = await this.model.complete([
      {role: "system", content: "You write a one-page website preview for a small business that currently has no working site. You may use ONLY the verified facts supplied. Never invent hours, prices, founding dates, ratings, awards, credentials, customer counts, staff names, or contact details. Anything a real owner would have to supply goes into `placeholders` as a short question, never into the prose. Write plain text without markup. Return only JSON: {headline, subheadline, about, sections:[{title, body}], callToAction, placeholders:[string]}."},
      {role: "user", content: JSON.stringify({verifiedFacts, gapEvidence: assessment.signals})}
    ], {temperature: .3, responseSchema: DEMO_SITE_CONTENT_SCHEMA});
    const content = JSON.parse(raw) as DemoSiteContent;
    content.sections = Array.isArray(content.sections) ? content.sections : [];
    content.placeholders = Array.isArray(content.placeholders) ? content.placeholders : [];
    const violations = validateDemoContent(content, prospect);
    if (violations.length) throw new Error(`Demo site rejected before publication: ${violations.join("; ")}`);
    const takedownToken = randomUUID();
    const disclosure = disclosureFor(prospect, this.sender, takedownToken);
    const html = renderDemoHtml({prospect, content, disclosure, sender: this.sender});
    return {id: randomUUID(), prospectId: prospect.id, content, html, disclosure, takedownToken, checksum: createHash("sha256").update(html).digest("hex"), indexable: false, builtAt: this.clock().toISOString(), previewUrl: null};
  }
}

export class DemoSitePublisher {
  constructor(private readonly gateway: IntegrationGateway, private readonly provider = "site_host") {}

  async publish(input: {companyId: string; site: DemoSite; prospect: BusinessProspect}): Promise<DemoSite> {
    if (!input.site.html.includes('name="robots" content="noindex')) throw new Error("Preview must be non-indexable before publication");
    if (!input.site.html.includes("Not affiliated with")) throw new Error("Preview must carry the unaffiliated-preview disclosure before publication");
    const result = await this.gateway.execute({provider: this.provider, operation: "publish_preview", payload: {siteId: input.site.id, html: input.site.html, indexable: false, takedownToken: input.site.takedownToken, businessName: input.prospect.name}, idempotencyKey: `preview:${input.site.prospectId}:${input.site.checksum.slice(0, 16)}`}) as {url: string};
    if (!result?.url) throw new Error("Hosting adapter returned no preview URL");
    return {...input.site, previewUrl: result.url};
  }

  async unpublish(input: {siteId: string; reason: string}) {
    return this.gateway.execute({provider: this.provider, operation: "unpublish_preview", payload: input, idempotencyKey: `takedown:${input.siteId}`});
  }
}
