import {afterEach, describe, expect, it, vi} from "vitest";
import {mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DryRunOutreachChannel, LocalDirectorySiteHost, InMemoryStore, InMemorySuppressionList, FixedApprovalGate, WizerEnv, extractJson, loadPolicy, overpassQuery, parseRobots, robotsAllows, extractTitle, visibleTextLength, toRecord, OpenStreetMapDirectory, AppleAppStoreDirectory, suppressionHash} from "../src/adapters/index.js";
import {IntegrationGateway, MemoryFabric, PersistentEventBus, APPROVED_AGENTS} from "../src/index.js";
import {DemoSiteBuilder, DemoSitePublisher, OutreachComplianceGate, OutreachComposer, OutreachSender, ProspectDiscovery, WebPresenceAssessor, WebsiteOutreachPipeline, type OutreachPolicy} from "../src/growth/index.js";

const scratch = () => mkdtempSync(join(tmpdir(), "wizer-"));
afterEach(() => vi.unstubAllGlobals());

describe("env and policy", () => {
  it("defaults everything a dry run needs and rejects a bad url", () => {
    expect(WizerEnv.parse({}).SITE_HOST).toBe("local");
    expect(WizerEnv.safeParse({SUPABASE_URL: "not-a-url"}).success).toBe(false);
  });
  it("refuses a policy with no jurisdictions and reads a valid one", () => {
    const directory = scratch();
    const valid = JSON.parse(readFileSync("outreach.policy.example.json", "utf8")) as OutreachPolicy;
    const emptyPath = join(directory, "empty.json");
    writeFileSync(emptyPath, JSON.stringify({...valid, jurisdictions: {}}));
    expect(() => loadPolicy(emptyPath)).toThrow(/no jurisdictions/);
    const goodPath = join(directory, "policy.json");
    writeFileSync(goodPath, JSON.stringify(valid));
    expect(loadPolicy(goodPath).jurisdictions.GB!.unsolicitedBusinessEmail).toBe("opt_out_allowed");
    expect(() => loadPolicy(join(directory, "missing.json"))).toThrow(/Copy outreach.policy.example.json/);
  });
});

describe("model json extraction", () => {
  it("unwraps fenced and prose-wrapped json", () => {
    expect(JSON.parse(extractJson('```json\n{"a":1}\n```')).a).toBe(1);
    expect(JSON.parse(extractJson('Here you go: {"a":2} hope that helps')).a).toBe(2);
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
  });
});

describe("robots and html parsing", () => {
  const robots = "User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: WizerPresenceBot\nDisallow: /\n";
  it("applies the most specific matching group", () => {
    expect(robotsAllows(parseRobots(robots, "wizerpresencebot"), "/")).toBe(false);
    const general = parseRobots(robots, "othercrawler");
    expect(robotsAllows(general, "/private")).toBe(false);
    expect(robotsAllows(general, "/private/ok")).toBe(true);
    expect(robotsAllows(general, "/")).toBe(true);
  });
  it("reads titles and visible text without scripts", () => {
    const html = "<html><head><title> Zahra &amp; Sons </title><style>a{color:red}</style></head><body><script>var x=1</script><p>Fresh bread daily</p></body></html>";
    expect(extractTitle(html)).toBe("Zahra & Sons");
    expect(visibleTextLength(html)).toBe("Fresh bread daily".length);
  });
});

describe("openstreetmap source", () => {
  it("maps plain categories and rejects injection attempts", () => {
    expect(overpassQuery({query: "bakery", area: "Manchester", limit: 5}).ql).toContain('["shop"="bakery"]');
    expect(overpassQuery({query: "shop=bakery", area: "53.4,-2.3,53.5,-2.2", limit: 5}).ql).toContain("(53.4,-2.3,53.5,-2.2)");
    expect(() => overpassQuery({query: 'shop=bakery];out;["a"="b', area: "Manchester", limit: 5})).toThrow(/Unsupported query/);
    expect(() => overpassQuery({query: "bakery", area: 'M"]->.a;out;//', limit: 5})).toThrow(/Unsupported area/);
  });
  it("turns tags into a record and drops unnamed elements", () => {
    const record = toRecord({type: "node", id: 42, tags: {name: "Zahra Bakery", "addr:housenumber": "12", "addr:street": "Mill Road", "addr:city": "Manchester", "addr:postcode": "M1 2AB", "contact:email": "hello@zahra.example;other@x.example", "contact:facebook": "https://facebook.com/zahra"}}, {countryCode: "GB", timezone: "Europe/London", category: "shop=bakery"});
    expect(record).toMatchObject({sourceRef: "node/42", name: "Zahra Bakery", website: null});
    expect(record!.address).toMatchObject({line: "12 Mill Road", locality: "Manchester", countryCode: "GB"});
    expect(record!.contacts![0]).toMatchObject({channel: "email", value: "hello@zahra.example", publiclyListed: true});
    expect(record!.socialProfiles).toHaveLength(1);
    expect(toRecord({type: "node", id: 7, tags: {shop: "bakery"}}, {countryCode: "GB", timezone: "UTC", category: "shop=bakery"})).toBeNull();
  });
  it("declares openstreetmap terms and posts a bounded query", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({elements: [{type: "node", id: 1, tags: {name: "A Cafe"}}]}), {status: 200}));
    vi.stubGlobal("fetch", fetchMock);
    const source = new OpenStreetMapDirectory({countryCode: "GB", timezone: "Europe/London"});
    expect(source.terms).toMatchObject({permitsDerivedStorage: true, attributionRequired: true});
    const {records} = await source.search({query: "cafe", area: "Manchester", limit: 3});
    expect(records).toHaveLength(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [string, {body: URLSearchParams}])[1].body)).toContain("out+center+tags+3");
  });
  it("returns no app matches when the store lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", {status: 500})));
    expect(await new AppleAppStoreDirectory().search({name: "Zahra", locality: "Manchester", countryCode: "GB"})).toEqual([]);
  });
});

describe("site host and channel", () => {
  it("writes a preview file and refuses an indexable one", async () => {
    const directory = scratch();
    const host = new LocalDirectorySiteHost({directory, baseUrl: "https://previews.example"});
    const result = await host.execute("publish_preview", {siteId: "abc", html: "<html>hi</html>", indexable: false, takedownToken: "t", businessName: "Zahra"}) as {url: string; path: string};
    expect(result.url).toBe("https://previews.example/abc.html");
    expect(readFileSync(result.path, "utf8")).toContain("hi");
    await expect(host.execute("publish_preview", {siteId: "abc", html: "<html/>", indexable: true})).rejects.toThrow(/indexable/);
    await host.execute("unpublish_preview", {siteId: "abc"});
    expect(existsSync(result.path)).toBe(false);
  });
  it("writes dry-run mail to disk and refuses channels it cannot honour", async () => {
    const directory = scratch();
    const channel = new DryRunOutreachChannel({directory});
    await channel.execute("send.email", {to: "a@b.example", subject: "s", text: "body", previewUrl: "https://x.example"}, "outreach:osm:1:1");
    expect(readdirSync(directory)).toEqual(["outreach_osm_1_1.txt"]);
    await expect(channel.execute("send.phone", {to: "+44", subject: "s", text: "t"}, "k")).rejects.toThrow(/only sends email/);
  });
  it("hashes suppression values consistently regardless of case or padding", async () => {
    expect(suppressionHash(" A@B.example ")).toBe(suppressionHash("a@b.example"));
    const list = new InMemorySuppressionList(["a@b.example"]);
    expect(await list.contains({companyId: "c", value: "A@B.EXAMPLE"})).toBe(true);
  });
});

describe("wired pipeline", () => {
  const policy = JSON.parse(readFileSync("outreach.policy.example.json", "utf8")) as OutreachPolicy;
  it("runs discovery, probing, preview publication and drafting through the real adapters", async () => {
    const previews = scratch(), outbox = scratch();
    const osmResponse = {elements: [{type: "node", id: 1, tags: {name: "Zahra Bakery", "addr:housenumber": "12", "addr:street": "Mill Road", "addr:city": "Manchester", "addr:postcode": "M1 2AB", "contact:email": "hello@zahra.example"}}]};
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input instanceof URL ? input : (input as Request).url ?? input);
      if (url.includes("overpass")) return new Response(JSON.stringify(osmResponse), {status: 200});
      if (url.includes("itunes")) return new Response(JSON.stringify({results: []}), {status: 200});
      return new Response("", {status: 404});
    }));
    const model = {complete: vi.fn(async (messages: Array<{content: string}>) => messages[0]!.content.includes("website preview")
      ? JSON.stringify({headline: "Zahra Bakery, Manchester", subheadline: "A bakery on Mill Road", about: "Zahra Bakery is a bakery in Manchester.", sections: [], callToAction: "Make this yours", placeholders: ["What are your opening hours?"]})
      : JSON.stringify({subject: "A one-page preview for Zahra Bakery", body: "You did not ask for this message. We made a free preview from your public listing; keep it, change it, or ignore it."}))};
    const store = new InMemoryStore();
    const gateway = new IntegrationGateway(store);
    gateway.register("site_host", new LocalDirectorySiteHost({directory: previews, baseUrl: "https://previews.example"}));
    gateway.register("outreach_channel", new DryRunOutreachChannel({directory: outbox}));
    const sender = {legalName: policy.senderIdentity.legalName, websiteUrl: policy.senderIdentity.websiteUrl, replyToEmail: policy.senderIdentity.replyToEmail, takedownUrl: "https://example.com/remove-preview"};
    const pipeline = new WebsiteOutreachPipeline({
      store, bus: new PersistentEventBus(store), memory: new MemoryFabric(store), discovery: new ProspectDiscovery(store),
      assessor: new WebPresenceAssessor({resolve: async () => ({resolves: false}), fetch: async url => ({status: 0, finalUrl: url, title: "", textLength: 0})}, new AppleAppStoreDirectory()),
      builder: new DemoSiteBuilder(model, sender), publisher: new DemoSitePublisher(gateway),
      composer: new OutreachComposer(model, policy), sender: new OutreachSender(gateway),
      gate: new OutreachComplianceGate(policy, new InMemorySuppressionList()), approvals: new FixedApprovalGate("pending")
    });
    const agent = {...APPROVED_AGENTS.find(candidate => candidate.name === "Maha")!, companyId: "00000000-0000-4000-8000-000000000100"};
    const result = await pipeline.run({companyId: agent.companyId, agent, query: "bakery", area: "Manchester", limit: 5, sources: [new OpenStreetMapDirectory({countryCode: "GB", timezone: "Europe/London"})]});

    expect(result).toMatchObject({discovered: 1, qualified: 1, previewsPublished: 1, queuedForApproval: 1, sent: 0});
    const preview = readFileSync(join(previews, readdirSync(previews)[0]!), "utf8");
    expect(preview).toContain('content="noindex,nofollow,noarchive"');
    expect(preview).toContain("Not affiliated with, endorsed by, or authorised by Zahra Bakery");
    expect(readdirSync(outbox)).toEqual([]);
    const draft = store.recordsOf("outreach.messages")[0] as {optOutInstruction: string; senderIdentityBlock: string};
    expect(draft.senderIdentityBlock).toContain(policy.senderIdentity.postalAddress);
    expect(draft.optOutInstruction).toContain(policy.senderIdentity.replyToEmail);
    expect(store.recordsOf("events.publish").map(event => (event as {type: string}).type)).toContain("outreach.approval_requested");
  });
});
