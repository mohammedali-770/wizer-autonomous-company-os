import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";
import {GlobalContextBuilder,LocalStore,MemoryFabric} from "../src/index.js";

const temp=async()=>join(await mkdtemp(join(tmpdir(),"wizer-")),"company.json");

describe("local store context",()=>{
  it("serves every domain the context builder asks for",async()=>{
    const store=new LocalStore();
    store.seedContext({strategy:{mission:"m"},finance:{cashJod:1}});
    const context=await new GlobalContextBuilder(store).build("company");
    expect(context.strategy).toEqual({mission:"m"});
    expect(context.finance).toEqual({cashJod:1});
    expect(context.operations).toBeNull();
    expect(context.recentEvents).toEqual([]);
    expect(context.decisions).toEqual([]);
    expect(context.openQuestions).toEqual([]);
  });
  it("names a domain it does not know instead of returning nothing",async()=>
    await expect(new LocalStore().query("context.vibes")).rejects.toThrow(/no context domain "vibes"/));
  it("names an unimplemented read rather than answering it",async()=>
    await expect(new LocalStore().query("finance.ledger")).rejects.toThrow(/does not implement the read "finance.ledger"/));
});

describe("local store memory",()=>{
  it("recalls by term overlap and ranks by score",async()=>{
    const store=new LocalStore();
    const memory=new MemoryFabric(store);
    await memory.remember({companyId:"c",kind:"decision",subject:"Sunday routing",content:"Sunday lateness traced to one driver covering two zones.",importance:0.8,sourceIds:[]});
    await memory.remember({companyId:"c",kind:"semantic",subject:"Roaster",content:"Roaster capacity is 180kg per week.",importance:0.4,sourceIds:[]});
    const hits=await memory.recall({companyId:"c",query:"why are Sunday deliveries late"});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toMatch(/Sunday lateness/);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });
  it("filters by kind",async()=>{
    const store=new LocalStore();
    const memory=new MemoryFabric(store);
    await memory.remember({companyId:"c",kind:"decision",subject:"Roaster",content:"Roaster is a single point of failure.",importance:0.9,sourceIds:[]});
    expect(await memory.recall({companyId:"c",query:"roaster",kinds:["semantic"]})).toEqual([]);
    expect(await memory.recall({companyId:"c",query:"roaster",kinds:["decision"]})).toHaveLength(1);
  });
  it("honours the recall limit",async()=>{
    const store=new LocalStore();
    const memory=new MemoryFabric(store);
    for(const n of [1,2,3,4]) await memory.remember({companyId:"c",kind:"episodic",subject:`late ${n}`,content:"delivery was late",importance:0.5,sourceIds:[]});
    expect(await memory.recall({companyId:"c",query:"late delivery",limit:2})).toHaveLength(2);
  });
});

describe("local store scheduler",()=>{
  const event=(id:string,at:string)=>({id,companyId:"c",type:"metric.changed",payload:{},occurredAt:at});
  it("claims only what is due, and only once",async()=>{
    const store=new LocalStore();
    store.schedule(event("a","2026-01-01T00:00:00.000Z"),event("b","2099-01-01T00:00:00.000Z"));
    const first=await store.query<Array<{id:string}>>("scheduler.claim_due",{now:"2026-06-01T00:00:00.000Z"});
    expect(first.map(e=>e.id)).toEqual(["a"]);
    expect(await store.query("scheduler.claim_due",{now:"2026-06-01T00:00:00.000Z"})).toEqual([]);
  });
});

describe("local store persistence",()=>{
  it("writes an auditable file and reopens from it",async()=>{
    const file=await temp();
    const store=await LocalStore.open(file);
    store.seedContext({strategy:{mission:"coffee"}});
    await store.append("reasoning.record",{agentId:"a",proposal:{objective:"fix routing"}});
    expect(JSON.parse(await readFile(file,"utf8")).log).toHaveLength(1);
    const reopened=await LocalStore.open(file);
    expect(reopened.log("reasoning.record")).toHaveLength(1);
    expect(await reopened.query("context.strategy")).toEqual({mission:"coffee"});
  });
  it("keeps the whole trail in order",async()=>{
    const store=new LocalStore();
    await store.append("events.publish",{type:"a"});
    await store.append("meeting.message",{topic:"t"});
    await store.append("events.publish",{type:"b"});
    expect(store.log().map(entry=>entry.operation)).toEqual(["events.publish","meeting.message","events.publish"]);
    expect(store.log("events.publish")).toHaveLength(2);
  });
});

describe("local store recall relevance",()=>{
  it("does not return a memory that shares no term with the query",async()=>{
    const store=new LocalStore();
    const memory=new MemoryFabric(store);
    await memory.remember({companyId:"c",kind:"semantic",subject:"Roaster",content:"Roaster capacity is 180kg per week.",importance:0.95,sourceIds:[]});
    expect(await memory.recall({companyId:"c",query:"why are Sunday deliveries late"})).toEqual([]);
  });
  it("falls back to importance when the query carries no usable terms",async()=>{
    const store=new LocalStore();
    const memory=new MemoryFabric(store);
    await memory.remember({companyId:"c",kind:"semantic",subject:"low",content:"minor note",importance:0.2,sourceIds:[]});
    await memory.remember({companyId:"c",kind:"semantic",subject:"high",content:"critical note",importance:0.9,sourceIds:[]});
    const hits=await memory.recall({companyId:"c",query:"a of"});
    expect(hits.map(hit=>hit.content)).toEqual(["critical note","minor note"]);
  });
  it("does not leak the internal hit count to callers",async()=>{
    const store=new LocalStore();
    await new MemoryFabric(store).remember({companyId:"c",kind:"decision",subject:"routing",content:"routing fixed",importance:0.5,sourceIds:[]});
    const [hit]=await new MemoryFabric(store).recall({companyId:"c",query:"routing"});
    expect(Object.keys(hit!).sort()).toEqual(["content","id","kind","score"]);
  });
});
