import { createHash } from "node:crypto";
import type { Store } from "../domain.js";
import { BusinessProspect, type ContactPoint } from "./domain.js";

export type RawBusinessRecord = {
  sourceRef: string; name: string; category?: string; website?: string | null; timezone?: string;
  address?: {line?: string; locality?: string; region?: string; postalCode?: string; countryCode: string};
  socialProfiles?: Array<{network: string; url: string}>; contacts?: ContactPoint[];
};

export type DirectoryTerms = {permitsDerivedStorage: boolean; maxRetentionDays: number | null; attributionRequired: boolean; termsUrl: string};

export interface BusinessDirectorySource {
  readonly name: string;
  readonly terms: DirectoryTerms;
  search(input: {query: string; area: string; limit: number; cursor?: string}): Promise<{records: RawBusinessRecord[]; cursor?: string}>;
}

export type DiscoveryReport = {prospects: BusinessProspect[]; rejected: Array<{sourceRef: string; reason: string}>; sourcesUsed: string[]};

const normalizeName = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const normalizeHost = (value: string | null | undefined) => {
  if (!value) return null;
  try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};
export const prospectFingerprint = (input: {name: string; countryCode: string; locality: string; postalCode: string; host: string | null}) =>
  createHash("sha256").update([normalizeName(input.name), input.countryCode.toUpperCase(), normalizeName(input.locality), input.postalCode.replace(/\s+/g, "").toUpperCase(), input.host ?? ""].join("|")).digest("hex").slice(0, 32);

export class ProspectDiscovery {
  constructor(private readonly store: Store, private readonly clock: () => Date = () => new Date()) {}

  private toProspect(companyId: string, source: BusinessDirectorySource, record: RawBusinessRecord) {
    const now = this.clock();
    const retainUntil = source.terms.maxRetentionDays === null ? null : new Date(now.getTime() + source.terms.maxRetentionDays * 86400000).toISOString();
    return BusinessProspect.parse({
      id: `${source.name}:${record.sourceRef}`, companyId, source: source.name, sourceRef: record.sourceRef,
      name: record.name, category: record.category ?? "",
      address: {line: record.address?.line ?? "", locality: record.address?.locality ?? "", region: record.address?.region ?? "", postalCode: record.address?.postalCode ?? "", countryCode: record.address?.countryCode ?? "XX"},
      timezone: record.timezone ?? "UTC", declaredWebsite: record.website ?? null,
      socialProfiles: record.socialProfiles ?? [], contacts: record.contacts ?? [],
      discoveredAt: now.toISOString(), retainUntil
    });
  }

  async discover(input: {companyId: string; query: string; area: string; limit: number; sources: BusinessDirectorySource[]}): Promise<DiscoveryReport> {
    const prospects: BusinessProspect[] = [], rejected: DiscoveryReport["rejected"] = [], sourcesUsed: string[] = [], seen = new Set<string>();
    const known = new Set(await this.store.query<string[]>("prospects.known_fingerprints", {companyId: input.companyId}) ?? []);
    for (const source of input.sources) {
      if (prospects.length >= input.limit) break;
      sourcesUsed.push(source.name);
      const {records} = await source.search({query: input.query, area: input.area, limit: input.limit - prospects.length});
      for (const record of records) {
        if (prospects.length >= input.limit) break;
        if (!record.address?.countryCode) { rejected.push({sourceRef: record.sourceRef, reason: "Record has no country and cannot be jurisdiction-checked"}); continue; }
        if (!source.terms.permitsDerivedStorage) { rejected.push({sourceRef: record.sourceRef, reason: `Source ${source.name} forbids derived storage; use it live only`}); continue; }
        const prospect = this.toProspect(input.companyId, source, record);
        const fingerprint = prospectFingerprint({name: prospect.name, countryCode: prospect.address.countryCode, locality: prospect.address.locality, postalCode: prospect.address.postalCode, host: normalizeHost(prospect.declaredWebsite)});
        if (seen.has(fingerprint) || known.has(fingerprint)) { rejected.push({sourceRef: record.sourceRef, reason: "Duplicate of a business already in the pipeline"}); continue; }
        seen.add(fingerprint);
        prospects.push(prospect);
        await this.store.append("prospects.upsert", {...prospect, fingerprint, attribution: source.terms.attributionRequired ? source.terms.termsUrl : null});
      }
    }
    return {prospects, rejected, sourcesUsed};
  }
}
