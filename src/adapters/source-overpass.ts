import type { BusinessDirectorySource, DirectoryTerms, RawBusinessRecord } from "../growth/discovery.js";
import type { ContactPoint } from "../growth/domain.js";

export type OverpassOptions = {countryCode: string; timezone?: string; endpoint?: string; userAgent?: string; timeoutMs?: number};

const CATEGORY_ALIASES: Record<string, string> = {
  bakery: "shop=bakery", butcher: "shop=butcher", florist: "shop=florist", hairdresser: "shop=hairdresser",
  barber: "shop=hairdresser", salon: "shop=beauty", restaurant: "amenity=restaurant", cafe: "amenity=cafe",
  dentist: "amenity=dentist", doctor: "amenity=doctors", pharmacy: "amenity=pharmacy", garage: "shop=car_repair",
  plumber: "craft=plumber", electrician: "craft=electrician", builder: "craft=builder", carpenter: "craft=carpenter",
  gym: "leisure=fitness_centre", nursery: "amenity=kindergarten", laundry: "shop=laundry", optician: "shop=optician",
  jeweller: "shop=jewelry", tailor: "craft=tailor", veterinary: "amenity=veterinary"
};
const TAG_FILTER = /^[a-z][a-z0-9_:]{0,30}=[A-Za-z0-9_.:;-]{1,40}$/;
const AREA_NAME = /^[\p{L}\p{N} .,'\/-]{2,60}$/u;
const BBOX = /^-?\d{1,3}(?:\.\d+)?(?:,-?\d{1,3}(?:\.\d+)?){3}$/;

export const overpassFilter = (query: string) => {
  const normalized = query.trim().toLowerCase();
  const mapped = CATEGORY_ALIASES[normalized] ?? normalized;
  if (!TAG_FILTER.test(mapped)) throw new Error(`Unsupported query "${query}". Use an OSM tag filter such as shop=bakery, or a known category (${Object.keys(CATEGORY_ALIASES).slice(0, 6).join(", ")}, …).`);
  const [key, value] = mapped.split("=");
  return {key: key!, value: value!, expression: `["${key}"="${value}"]`};
};

export const overpassQuery = (input: {query: string; area: string; limit: number}) => {
  const filter = overpassFilter(input.query), limit = Math.max(1, Math.min(input.limit, 200));
  if (BBOX.test(input.area.replace(/\s+/g, ""))) return {filter, ql: `[out:json][timeout:60];nwr${filter.expression}(${input.area.replace(/\s+/g, "")});out center tags ${limit};`};
  if (!AREA_NAME.test(input.area)) throw new Error(`Unsupported area "${input.area}". Use a place name or a "south,west,north,east" bounding box.`);
  return {filter, ql: `[out:json][timeout:60];area["name"="${input.area}"]->.searchArea;nwr${filter.expression}(area.searchArea);out center tags ${limit};`};
};

type OverpassElement = {type: string; id: number; tags?: Record<string, string>};

export const toRecord = (element: OverpassElement, defaults: {countryCode: string; timezone: string; category: string}): RawBusinessRecord | null => {
  const tags = element.tags ?? {};
  if (!tags.name) return null;
  const contacts: ContactPoint[] = [];
  const collectedAt = new Date().toISOString();
  const email = tags.email ?? tags["contact:email"];
  const phone = tags.phone ?? tags["contact:phone"] ?? tags["contact:mobile"];
  if (email) contacts.push({channel: "email", value: email.split(";")[0]!.trim(), publiclyListed: true, consent: "none", source: "openstreetmap", collectedAt});
  if (phone) contacts.push({channel: "phone", value: phone.split(";")[0]!.trim(), publiclyListed: true, consent: "none", source: "openstreetmap", collectedAt});
  const socialProfiles = (["facebook", "instagram", "twitter", "linkedin"] as const)
    .map(network => ({network: network as string, url: tags[`contact:${network}`] ?? tags[network] ?? ""}))
    .filter(profile => Boolean(profile.url));
  const housenumber = tags["addr:housenumber"] ?? "", street = tags["addr:street"] ?? "";
  return {
    sourceRef: `${element.type}/${element.id}`, name: tags.name,
    category: tags.cuisine ?? defaults.category,
    website: tags.website ?? tags["contact:website"] ?? tags.url ?? null,
    timezone: defaults.timezone,
    address: {
      line: `${housenumber} ${street}`.trim(),
      locality: tags["addr:city"] ?? tags["addr:town"] ?? tags["addr:village"] ?? tags["addr:suburb"] ?? "",
      region: tags["addr:state"] ?? tags["addr:county"] ?? "",
      postalCode: tags["addr:postcode"] ?? "",
      countryCode: (tags["addr:country"] ?? defaults.countryCode).toUpperCase().slice(0, 2)
    },
    socialProfiles, contacts
  };
};

export class OpenStreetMapDirectory implements BusinessDirectorySource {
  readonly name = "openstreetmap";
  readonly terms: DirectoryTerms = {permitsDerivedStorage: true, maxRetentionDays: null, attributionRequired: true, termsUrl: "https://www.openstreetmap.org/copyright"};
  constructor(private readonly options: OverpassOptions) {}

  async search(input: {query: string; area: string; limit: number}) {
    const {ql, filter} = overpassQuery(input);
    const response = await fetch(this.options.endpoint ?? "https://overpass-api.de/api/interpreter", {
      method: "POST", body: new URLSearchParams({data: ql}),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 90000),
      headers: {"user-agent": this.options.userAgent ?? "WizerProspecting/0.1", "content-type": "application/x-www-form-urlencoded"}
    });
    if (!response.ok) throw new Error(`Overpass returned ${response.status}: ${(await response.text()).slice(0, 200)}. Public Overpass instances rate-limit and go down; retry later or point OVERPASS_ENDPOINT at another instance.`);
    const payload = await response.json() as {elements?: OverpassElement[]};
    const defaults = {countryCode: this.options.countryCode, timezone: this.options.timezone ?? "UTC", category: `${filter.key}=${filter.value}`};
    const records = (payload.elements ?? []).map(element => toRecord(element, defaults)).filter((record): record is RawBusinessRecord => record !== null);
    return {records};
  }
}
