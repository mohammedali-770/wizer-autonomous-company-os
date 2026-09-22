import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";
import {ApprovalQueue,LocalStore,PersistentEventBus,type CompanyEvent} from "../src/index.js";

const ROSTER=["Ali","Sami","00000000-0000-4000-8000-000000000004"];
const ask=(overrides:Record<string,unknown>={})=>({id:"evt-1:decision.approve",companyId:"c",agentId:"agent-ali",agentName:"Ali",capability:"decision.approve",risk:"high" as const,objective:"Hire a relief driver",provider:"ops",payload:{spend:1200},...overrides});
const wire=()=>{const store=new LocalStore();const bus=new PersistentEventBus(store);const seen:CompanyEvent[]=[];bus.on("*",async event=>{seen.push(event)});return {store,bus,seen,queue:new ApprovalQueue(store,{bus,agentIdentities:ROSTER})}};

describe("approval queue",()=>{
  it("parks a request until somebody decides it",async()=>{
    const {queue}=wire();
    await queue.request(ask());
    expect((await queue.pending()).map(r=>r.capability)).toEqual(["decision.approve"]);
    expect(await queue.status("evt-1:decision.approve")).toBe("pending");
  });
  it("records who granted it and publishes the resumption event",async()=>{
    const {queue,seen}=wire();
    await queue.request(ask());
    const outcome=await queue.grant("evt-1:decision.approve","mohammed","Runway allows it");
    expect(outcome).toMatchObject({decision:"granted",approvedBy:"mohammed",reason:"Runway allows it"});
    expect(await queue.pending()).toEqual([]);
    expect(await queue.status("evt-1:decision.approve")).toBe("granted");
    expect(seen.map(e=>e.type)).toEqual(["approval.granted"]);
    expect((seen[0]!.payload as {approvedBy:string}).approvedBy).toBe("mohammed");
  });
  it("publishes a rejection too, so the trail shows the road not taken",async()=>{
    const {queue,seen}=wire();
    await queue.request(ask());
    await queue.reject("evt-1:decision.approve","mohammed","Not with four months of runway");
    expect(await queue.status("evt-1:decision.approve")).toBe("rejected");
    expect(seen.map(e=>e.type)).toEqual(["approval.rejected"]);
  });
  it("carries the request forward so a handler can resume the exact work",async()=>{
    const {queue,seen}=wire();
    await queue.request(ask());
    await queue.grant("evt-1:decision.approve","mohammed");
    expect((seen[0]!.payload as {request:{capability:string;payload:unknown}}).request).toMatchObject({capability:"decision.approve",payload:{spend:1200}});
  });
});

describe("approval queue refusals",()=>{
  it("refuses an unsigned approval",async()=>{
    const {queue}=wire();
    await queue.request(ask());
    await expect(queue.grant("evt-1:decision.approve","  ")).rejects.toThrow(/must name the person/);
  });
  it("refuses the agent that asked, by name or by id",async()=>{
    for(const approver of ["Ali","ali","agent-ali"]){
      const {queue}=wire();
      await queue.request(ask());
      await expect(queue.grant("evt-1:decision.approve",approver)).rejects.toThrow(/may not approve|own exceptional authority/);
    }
  });
  it("refuses any other agent on the roster",async()=>{
    const {queue}=wire();
    await queue.request(ask({agentName:"Noor",agentId:"agent-noor"}));
    await expect(queue.grant("evt-1:decision.approve","Sami")).rejects.toThrow(/agent of this company/);
    await expect(queue.grant("evt-1:decision.approve","00000000-0000-4000-8000-000000000004")).rejects.toThrow(/agent of this company/);
  });
  it("refuses to decide the same request twice",async()=>{
    const {queue}=wire();
    await queue.request(ask());
    await queue.grant("evt-1:decision.approve","mohammed");
    await expect(queue.grant("evt-1:decision.approve","mohammed")).rejects.toThrow(/already granted and cannot be decided again/);
    await expect(queue.reject("evt-1:decision.approve","mohammed")).rejects.toThrow(/already granted/);
  });
  it("refuses to reopen a rejected request under the same id",async()=>{
    const {queue}=wire();
    await queue.request(ask());
    await queue.reject("evt-1:decision.approve","mohammed");
    await expect(queue.request(ask())).rejects.toThrow(/already exists and is rejected/);
  });
  it("names an id it has never seen",async()=>
    await expect(wire().queue.grant("evt-9:nope","mohammed")).rejects.toThrow(/No approval request evt-9:nope is on record/));
  it("does not publish anything when a decision is refused",async()=>{
    const {queue,seen}=wire();
    await queue.request(ask());
    await queue.grant("evt-1:decision.approve","mohammed");
    await queue.grant("evt-1:decision.approve","mohammed").catch(()=>{});
    expect(seen).toHaveLength(1);
  });
});

describe("approval queue durability",()=>{
  it("derives its state from the audit trail, so it survives a restart",async()=>{
    const file=join(await mkdtemp(join(tmpdir(),"wizer-")),"company.json");
    const first=new ApprovalQueue(await LocalStore.open(file));
    await first.request(ask());
    await first.request(ask({id:"evt-2:funds.transfer",capability:"funds.transfer"}));
    await first.grant("evt-1:decision.approve","mohammed");
    const resumed=new ApprovalQueue(await LocalStore.open(file));
    expect((await resumed.pending()).map(r=>r.id)).toEqual(["evt-2:funds.transfer"]);
    expect(await resumed.status("evt-1:decision.approve")).toBe("granted");
  });
  it("keeps companies apart",async()=>{
    const {queue}=wire();
    await queue.request(ask());
    await queue.request(ask({id:"other",companyId:"other-co"}));
    expect((await queue.pending("c")).map(r=>r.id)).toEqual(["evt-1:decision.approve"]);
    expect((await queue.pending("other-co")).map(r=>r.id)).toEqual(["other"]);
  });
});
