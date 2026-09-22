import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";
import {AutonomousScheduler,GlobalContextBuilder,IntegrationGateway,MemoryFabric,PersistentEventBus,SqliteStore,integrationFingerprint,type CompanyEvent,type IntegrationAdapter} from "../src/index.js";

const available=await (async()=>{try{await import("node:sqlite");return true}catch{return false}})();
const sqlite=available?describe:describe.skip;
const at=(hour:string)=>`2026-09-22T${hour}:00.000Z`;
const event=(id:string,type:string,hour:string):CompanyEvent=>({id,companyId:"c",type,payload:{hour},occurredAt:at(hour)});
const file=async()=>join(await mkdtemp(join(tmpdir(),"wizer-")),"company.db");

sqlite("sqlite store answers the same contract",()=>{
  it("serves context domains and collections",async()=>{
    const store=await SqliteStore.open();
    store.seedContext({strategy:{mission:"m"},finance:{cashJod:1}});
    const context=await new GlobalContextBuilder(store).build("company");
    expect(context.strategy).toEqual({mission:"m"});
    expect(context.operations).toBeNull();
    expect(context.recentEvents).toEqual([]);
    await expect(store.query("context.vibes")).rejects.toThrow(/no context domain "vibes"/);
    await expect(store.query("finance.ledger")).rejects.toThrow(/does not implement the read/);
  });
  it("recalls by term overlap and refuses an unrelated memory",async()=>{
    const store=await SqliteStore.open();
    const memory=new MemoryFabric(store);
    await memory.remember({companyId:"c",kind:"decision",subject:"Sunday routing",content:"Sunday lateness traced to one driver.",importance:0.8,sourceIds:[]});
    await memory.remember({companyId:"c",kind:"semantic",subject:"Roaster",content:"Roaster capacity is 180kg per week.",importance:0.95,sourceIds:[]});
    const hits=await memory.recall({companyId:"c",query:"why are Sunday deliveries late"});
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toMatch(/Sunday lateness/);
    expect(await memory.recall({companyId:"c",query:"roaster",kinds:["decision"]})).toEqual([]);
  });
  it("keeps the evidence trail in order",async()=>{
    const store=await SqliteStore.open();
    await store.append("events.publish",{id:"a",type:"x"});
    await store.append("reasoning.record",{agentId:"ali"});
    expect(store.log().map(entry=>entry.operation)).toEqual(["events.publish","reasoning.record"]);
    expect(store.log("reasoning.record")).toHaveLength(1);
  });
});

sqlite("sqlite closes the lost-batch gap",()=>{
  it("redelivers what a throwing handler never reached",async()=>{
    const store=await SqliteStore.open(":memory:",{leaseMs:0});
    const bus=new PersistentEventBus(store); const scheduler=new AutonomousScheduler(store,bus);
    const seen:string[]=[]; let exploded=false;
    bus.on("metric.changed",async event=>{ seen.push(event.id); if(event.id==="b"&&!exploded){ exploded=true; throw new Error("handler exploded") } });
    store.schedule(event("a","metric.changed","08:00"),event("b","metric.changed","08:30"),event("c","metric.changed","09:00"));
    await expect(scheduler.tick(new Date(at("10:00")))).rejects.toThrow(/handler exploded/);
    expect(seen).toEqual(["a","b"]);
    expect(await scheduler.tick(new Date(at("10:00")))).toBe(1);
    expect(seen).toEqual(["a","b","c"]);
  });
  it("still refuses to deliver anything twice",async()=>{
    const store=await SqliteStore.open(":memory:",{leaseMs:0});
    const bus=new PersistentEventBus(store); const scheduler=new AutonomousScheduler(store,bus);
    let deliveries=0;
    bus.on("metric.changed",async()=>{deliveries++});
    store.schedule(event("a","metric.changed","08:00"));
    for(const _ of [1,2,3]) await scheduler.tick(new Date(at("10:00")));
    expect(deliveries).toBe(1);
  });
  it("does not hand the same event to two runs inside the lease",async()=>{
    const store=await SqliteStore.open(":memory:",{leaseMs:60_000});
    const first=new PersistentEventBus(store), second=new PersistentEventBus(store);
    const seen:string[]=[];
    first.on("*",async event=>{seen.push(`first:${event.id}`)});
    second.on("*",async event=>{seen.push(`second:${event.id}`)});
    store.schedule(event("a","metric.changed","08:00"));
    const claimed=await store.query<CompanyEvent[]>("scheduler.claim_due",{now:at("09:00")});
    expect(claimed).toHaveLength(1);
    expect(await new AutonomousScheduler(store,second).tick(new Date(at("09:00")))).toBe(0);
    expect(seen).toEqual([]);
  });
});

sqlite("sqlite closes the concurrent-effect gap",()=>{
  const ask=(overrides:Record<string,unknown>={})=>({provider:"ops",operation:"driver.assign",payload:{zone:"Sunday"},idempotencyKey:"evt-1:driver.assign",...overrides});
  it("refuses a second run that starts the same effect while the first is in flight",async()=>{
    const store=await SqliteStore.open();
    let release=()=>{}; let entered=()=>{};
    const started=new Promise<void>(resolve=>{entered=resolve});
    const slow:IntegrationAdapter={async execute(){ entered(); await new Promise<void>(resolve=>{release=resolve}); return {ticket:"T-1"} }};
    const runA=new IntegrationGateway(store); runA.register("ops",slow);
    const runB=new IntegrationGateway(store); runB.register("ops",{async execute(){return {ticket:"DUPLICATE"}}});
    const inFlight=runA.execute(ask());
    await started;
    await expect(runB.execute(ask())).rejects.toThrow(/already reserved by another run/);
    release();
    expect(await inFlight).toEqual({ticket:"T-1"});
  });
  it("lets a second run reuse the finished result instead of repeating it",async()=>{
    const store=await SqliteStore.open();
    const runA=new IntegrationGateway(store); runA.register("ops",{async execute(){return {ticket:"T-1"}}});
    let second=0;
    const runB=new IntegrationGateway(store); runB.register("ops",{async execute(){second++;return {ticket:"DUPLICATE"}}});
    await runA.execute(ask());
    expect(await runB.execute(ask())).toEqual({ticket:"T-1"});
    expect(second).toBe(0);
  });
  it("lets a failed effect be retried by another run",async()=>{
    const store=await SqliteStore.open();
    const runA=new IntegrationGateway(store); runA.register("ops",{async execute(){throw new Error("ops desk offline")}});
    await expect(runA.execute(ask())).rejects.toThrow(/ops desk offline/);
    const runB=new IntegrationGateway(store); runB.register("ops",{async execute(){return {ticket:"T-2"}}});
    expect(await runB.execute(ask())).toEqual({ticket:"T-2"});
  });
  it("takes over a reservation whose run died, once the lease expires",async()=>{
    const store=await SqliteStore.open(":memory:",{leaseMs:0});
    await store.append("integration.requested",{provider:"ops",operation:"driver.assign",idempotencyKey:"evt-1:driver.assign",fingerprint:integrationFingerprint(ask())});
    const gateway=new IntegrationGateway(store); gateway.register("ops",{async execute(){return {ticket:"T-3"}}});
    expect(await gateway.execute(ask())).toEqual({ticket:"T-3"});
  });
  it("still refuses a key reused for different work",async()=>{
    const store=await SqliteStore.open();
    const gateway=new IntegrationGateway(store); gateway.register("ops",{async execute(){return {}}});
    await gateway.execute(ask());
    await expect(gateway.execute(ask({payload:{zone:"Monday"}}))).rejects.toThrow(/different payload/);
  });
});

sqlite("sqlite durability",()=>{
  it("recovers approvals, delivery and effects from the database",async()=>{
    const path=await file();
    const first=await SqliteStore.open(path);
    await first.append("approval.requested",{id:"evt-1:decision.approve",companyId:"c",capability:"decision.approve"});
    await first.append("approval.requested",{id:"evt-2:funds.transfer",companyId:"c",capability:"funds.transfer"});
    await first.append("approval.granted",{request:{id:"evt-1:decision.approve"},approvedBy:"mohammed"});
    first.schedule(event("a","metric.changed","08:00"));
    await first.append("events.publish",{id:"a"});
    first.close();
    const resumed=await SqliteStore.open(path);
    expect((await resumed.query<Array<{id:string}>>("approvals.pending",{companyId:"c"})).map(r=>r.id)).toEqual(["evt-2:funds.transfer"]);
    expect(await resumed.query("approvals.status",{id:"evt-1:decision.approve"})).toBe("granted");
    expect(await resumed.query("scheduler.claim_due",{now:at("12:00")})).toEqual([]);
    resumed.close();
  });
});

sqlite("sqlite keeps the trail honest",()=>{
  it("writes no evidence for an append it refused",async()=>{
    const store=await SqliteStore.open();
    const request={provider:"ops",operation:"driver.assign",idempotencyKey:"evt-1:driver.assign",fingerprint:"abc"};
    await store.append("integration.requested",request);
    await expect(store.append("integration.requested",request)).rejects.toThrow(/already reserved by another run/);
    expect(store.log("integration.requested")).toHaveLength(1);
    expect(store.log()).toHaveLength(1);
  });
  it("leaves the reservation untouched when a later append is refused",async()=>{
    const store=await SqliteStore.open();
    const request={provider:"ops",operation:"driver.assign",idempotencyKey:"k",fingerprint:"abc"};
    await store.append("integration.requested",request);
    await store.append("integration.completed",{...request,result:{ticket:"T-1"}});
    expect(await store.query("integrations.by_key",{idempotencyKey:"k"})).toMatchObject({status:"completed",fingerprint:"abc",result:{ticket:"T-1"}});
  });
});

sqlite("sqlite opening",()=>{
  it("creates the directory the database lives in",async()=>{
    const path=join(await mkdtemp(join(tmpdir(),"wizer-")),"nested","deeper","company.db");
    const store=await SqliteStore.open(path);
    await store.append("reasoning.record",{agentId:"ali"});
    expect(store.log()).toHaveLength(1);
    store.close();
  });
  it("explains a path it cannot open",async()=>{
    const blocker=join(await mkdtemp(join(tmpdir(),"wizer-")),"not-a-directory");
    await writeFile(blocker,"x");
    await expect(SqliteStore.open(join(blocker,"company.db"))).rejects.toThrow(/Cannot open the company database/);
  });
});
