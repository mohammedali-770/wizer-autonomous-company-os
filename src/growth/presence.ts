import type { AppPresence, BusinessProspect, PresenceAssessment, PresenceSignal, Qualification, WebsitePresence } from "./domain.js";

export interface WebProbe {
  resolve(hostname: string): Promise<{resolves: boolean}>;
  fetch(url: string): Promise<{status: number; finalUrl: string; title: string; textLength: number}>;
}
export interface AppDirectory {
  search(input: {name: string; locality: string; countryCode: string}): Promise<Array<{store: "apple" | "google"; title: string; publisher: string; url: string}>>;
}

const SOCIAL_HOSTS = ["facebook.com", "fb.me", "instagram.com", "linkedin.com", "tiktok.com", "x.com", "twitter.com", "yelp.com", "linktr.ee", "beacons.ai", "bio.link"];
const PLATFORM_HOSTS = ["business.site", "wixsite.com", "godaddysites.com", "square.site", "myshopify.com", "weebly.com", "blogspot.com", "wordpress.com", "shopsettings.com"];
const PARKED_MARKERS = ["domain for sale", "buy this domain", "parked", "coming soon", "under construction", "default web page", "index of /"];
const GAP_BY_PRESENCE: Record<WebsitePresence, number> = {none: 1, broken: .9, social_only: .72, platform_hosted: .38, owned: .05};
const BASE_CONFIDENCE: Record<WebsitePresence, number> = {none: .62, broken: .85, social_only: .88, platform_hosted: .85, owned: .9};

const hostOf = (value: string) => { try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const matchesHost = (host: string, list: string[]) => list.some(known => host === known || host.endsWith(`.${known}`));
const tokens = (value: string) => new Set(value.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(part => part.length > 2));
const overlap = (a: string, b: string) => { const left = tokens(a), right = tokens(b); if (!left.size) return 0; let hits = 0; for (const token of left) if (right.has(token)) hits += 1; return hits / left.size; };

export class WebPresenceAssessor {
  constructor(private readonly probe: WebProbe, private readonly apps: AppDirectory | null = null, private readonly clock: () => Date = () => new Date()) {}

  private async assessWebsite(prospect: BusinessProspect, signals: PresenceSignal[]): Promise<{presence: WebsitePresence}> {
    const at = this.clock().toISOString();
    if (!prospect.declaredWebsite) {
      signals.push({kind: "directory_field", observation: `${prospect.source} lists no website for this business`, evidenceUrl: null, observedAt: at});
      if (prospect.socialProfiles.length) signals.push({kind: "social", observation: `Only social profiles found: ${prospect.socialProfiles.map(profile => profile.network).join(", ")}`, evidenceUrl: prospect.socialProfiles[0]?.url ?? null, observedAt: at});
      return {presence: prospect.socialProfiles.length ? "social_only" : "none"};
    }
    const host = hostOf(prospect.declaredWebsite);
    if (!host) { signals.push({kind: "directory_field", observation: `Listed website "${prospect.declaredWebsite}" is not a usable URL`, evidenceUrl: null, observedAt: at}); return {presence: "broken"}; }
    if (matchesHost(host, SOCIAL_HOSTS)) { signals.push({kind: "social", observation: `Listed website points at a social or link-in-bio page (${host})`, evidenceUrl: prospect.declaredWebsite, observedAt: at}); return {presence: "social_only"}; }
    const dns = await this.probe.resolve(host);
    signals.push({kind: "dns", observation: dns.resolves ? `${host} resolves` : `${host} does not resolve`, evidenceUrl: null, observedAt: at});
    if (!dns.resolves) return {presence: "broken"};
    const response = await this.probe.fetch(prospect.declaredWebsite);
    signals.push({kind: "http", observation: `HTTP ${response.status} from ${response.finalUrl}`, evidenceUrl: response.finalUrl, observedAt: at});
    if (response.status >= 400 || response.status === 0) return {presence: "broken"};
    const parked = PARKED_MARKERS.some(marker => response.title.toLowerCase().includes(marker)) || response.textLength < 400;
    signals.push({kind: "content", observation: parked ? `Page looks parked or empty (title "${response.title}", ${response.textLength} chars of text)` : `Page returns real content (${response.textLength} chars of text)`, evidenceUrl: response.finalUrl, observedAt: at});
    if (parked) return {presence: "broken"};
    const finalHost = hostOf(response.finalUrl) ?? host;
    if (matchesHost(finalHost, SOCIAL_HOSTS)) return {presence: "social_only"};
    if (matchesHost(finalHost, PLATFORM_HOSTS)) return {presence: "platform_hosted"};
    return {presence: "owned"};
  }

  private async assessApp(prospect: BusinessProspect, signals: PresenceSignal[]): Promise<AppPresence> {
    if (!this.apps) return "unknown";
    const at = this.clock().toISOString();
    const results = await this.apps.search({name: prospect.name, locality: prospect.address.locality, countryCode: prospect.address.countryCode});
    const match = results.find(result => overlap(prospect.name, result.title) >= .6 || overlap(prospect.name, result.publisher) >= .6);
    signals.push({kind: "app_store", observation: match ? `Published app found: ${match.title} by ${match.publisher}` : `No app store listing matched "${prospect.name}"`, evidenceUrl: match?.url ?? null, observedAt: at});
    return match ? "published" : "none";
  }

  async assess(prospect: BusinessProspect): Promise<PresenceAssessment> {
    const signals: PresenceSignal[] = [];
    const website = await this.assessWebsite(prospect, signals);
    const app = await this.assessApp(prospect, signals);
    const gapScore = Math.min(1, GAP_BY_PRESENCE[website.presence] + (app === "none" && website.presence !== "owned" ? .02 : 0));
    const corroboration = new Set(signals.map(signal => signal.kind)).size;
    const confidence = Math.min(1, BASE_CONFIDENCE[website.presence] + (corroboration - 1) * .04);
    return {prospectId: prospect.id, website: website.presence, app, gapScore, confidence, signals, assessedAt: this.clock().toISOString()};
  }
}

export const qualify = (assessment: PresenceAssessment, thresholds = {gapScore: .7, confidence: .6}): Qualification => {
  const reasons: string[] = [];
  if (!["none", "broken", "social_only"].includes(assessment.website)) reasons.push(`Business already has a working site (${assessment.website})`);
  if (assessment.gapScore < thresholds.gapScore) reasons.push(`Gap score ${assessment.gapScore.toFixed(2)} is below ${thresholds.gapScore}`);
  if (assessment.confidence < thresholds.confidence) reasons.push(`Evidence confidence ${assessment.confidence.toFixed(2)} is below ${thresholds.confidence}; do not contact on a guess`);
  return {qualified: reasons.length === 0, reasons: reasons.length ? reasons : ["Verified absence of a working website"], gapScore: assessment.gapScore, confidence: assessment.confidence};
};
