import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it,vi} from "vitest";
import {IntegrationGateway,LocalStore,integrationFingerprint,type IntegrationAdapter} from "../src/index.js";

const file=async()=>join(await mkdtemp(join(tmpdir(),"wizer-")),"company.json");
const ask=(overrides:Record<string,unknown>={})=>({provider:"ops",operation:"driver.assign",payload:{zone:"Sunday",driver:"Rami"},idempotencyKey:"evt-1:driver.assign",...overrides});
const counting=(result:unknown={status:"ok"}):IntegrationAdapter&{calls:number}=>{
  const adapter={calls:0,async execute(){adapter.calls++;return result}};
  return adapter;
};

describe("integration idempotency",()=>{
  it("executes the side effect once however often the key is replayed",async()=>{
    const store=new LocalStore(); const adapter=counting({ticket:"T-1"});
    const gateway=new IntegrationGateway(store); gateway.register("ops",adapter);
    expect(await gateway.execute(ask())).toEqual({ticket:"T-1"});
    expect(await gateway.execute(ask())).toEqual({ticket:"T-1"});
    expect(await gateway.execute(ask())).toEqual({ticket:"T-1"});
    expect(adapter.calls).toBe(1);
  });
  it("records the suppressed replay as evidence instead of hiding it",async()=>{
    const store=new LocalStore(); const gateway=new IntegrationGateway(store); gateway.register("ops",counting());
    await gateway.execute(ask());
    await gateway.execute(ask());
    expect(store.log().map(entry=>entry.operation)).toEqual(["integration.requested","integration.completed","integration.duplicate"]);
  });
  it("collapses concurrent duplicates into one call",async()=>{
    const store=new LocalStore();
    let calls=0;
    const adapter:IntegrationAdapter={async execute(){calls++;await new Promise(resolve=>setTimeout(resolve,10));return {ticket:"T-1"}}};
    const gateway=new IntegrationGateway(store); gateway.register("ops",adapter);
    const results=await Promise.all([gateway.execute(ask()),gateway.execute(ask()),gateway.execute(ask())]);
    expect(calls).toBe(1);
    expect(results).toEqual([{ticket:"T-1"},{ticket:"T-1"},{ticket:"T-1"}]);
  });
  it("survives a restart, because the record is the trail",async()=>{
    const path=await file(); const adapter=counting({ticket:"T-1"});
    const first=new IntegrationGateway(await LocalStore.open(path)); first.register("ops",adapter);
    await first.execute(ask());
    const resumed=new IntegrationGateway(await LocalStore.open(path)); resumed.register("ops",adapter);
    expect(await resumed.execute(ask())).toEqual({ticket:"T-1"});
    expect(adapter.calls).toBe(1);
  });
});

describe("integration key reuse",()=>{
  it("refuses a key already spent on different work",async()=>{
    const store=new LocalStore(); const gateway=new IntegrationGateway(store); gateway.register("ops",counting());
    await gateway.execute(ask());
    await expect(gateway.execute(ask({payload:{zone:"Monday",driver:"Rami"}}))).rejects.toThrow(/already used for a completed action with a different payload/);
    await expect(gateway.execute(ask({operation:"driver.dismiss"}))).rejects.toThrow(/different payload/);
  });
  it("refuses a concurrent key collision too",async()=>{
    const store=new LocalStore();
    const gateway=new IntegrationGateway(store);
    gateway.register("ops",{async execute(){await new Promise(resolve=>setTimeout(resolve,10));return {}}});
    const first=gateway.execute(ask());
    await expect(gateway.execute(ask({payload:{zone:"Monday"}}))).rejects.toThrow(/already in flight for different work/);
    await first;
  });
  it("treats payloads as equal regardless of key order",()=>
    expect(integrationFingerprint({provider:"ops",operation:"x",payload:{a:1,b:{c:2,d:3}}}))
      .toBe(integrationFingerprint({provider:"ops",operation:"x",payload:{b:{d:3,c:2},a:1}})));
  it("treats a changed value as different work",()=>
    expect(integrationFingerprint({provider:"ops",operation:"x",payload:{a:1}}))
      .not.toBe(integrationFingerprint({provider:"ops",operation:"x",payload:{a:2}})));
});

describe("integration retries",()=>{
  it("lets a failed attempt be retried under the same key",async()=>{
    const store=new LocalStore();
    let calls=0;
    const gateway=new IntegrationGateway(store);
    gateway.register("ops",{async execute(){calls++; if(calls===1) throw new Error("ops desk offline"); return {ticket:"T-2"}}});
    await expect(gateway.execute(ask())).rejects.toThrow(/ops desk offline/);
    expect(await gateway.execute(ask())).toEqual({ticket:"T-2"});
    expect(calls).toBe(2);
  });
  it("retries a request that never reached an outcome, and the gap stays visible",async()=>{
    const store=new LocalStore(); const adapter=counting();
    const gateway=new IntegrationGateway(store); gateway.register("ops",adapter);
    await store.append("integration.requested",{...ask(),payload:undefined,fingerprint:integrationFingerprint(ask())});
    await gateway.execute(ask());
    expect(adapter.calls).toBe(1);
    expect(store.log().map(entry=>entry.operation)).toEqual(["integration.requested","integration.requested","integration.completed"]);
  });
});

describe("integration evidence",()=>{
  it("never writes the payload to the trail",async()=>{
    const store=new LocalStore(); const gateway=new IntegrationGateway(store);
    gateway.register("ops",counting({receipt:"ok"}));
    await gateway.execute(ask({payload:{driver:"Rami",phone:"+962790000000",iban:"JO94CBJO0010000000000131000302"}}));
    const trail=JSON.stringify(store.log());
    expect(trail).not.toContain("+962790000000");
    expect(trail).not.toContain("JO94CBJO0010000000000131000302");
    expect(trail).toContain("fingerprint");
  });
  it("keeps the approver on the request and the outcome",async()=>{
    const store=new LocalStore(); const gateway=new IntegrationGateway(store); gateway.register("ops",counting());
    await gateway.execute(ask({approvedBy:"mohammed"}));
    for(const entry of store.log()) expect(entry.input).toMatchObject({approvedBy:"mohammed"});
  });
  it("records a failure with its reason and no payload",async()=>{
    const store=new LocalStore(); const gateway=new IntegrationGateway(store);
    gateway.register("ops",{async execute(){throw new Error("roaster unreachable")}});
    await expect(gateway.execute(ask({payload:{secret:"hunter2"}}))).rejects.toThrow(/roaster unreachable/);
    const failure=store.log("integration.failed")[0]!;
    expect(failure.input).toMatchObject({error:expect.stringContaining("roaster unreachable")});
    expect(JSON.stringify(failure.input)).not.toContain("hunter2");
  });
  it("still refuses an unregistered provider before touching the trail",async()=>{
    const store=new LocalStore();
    await expect(new IntegrationGateway(store).execute(ask())).rejects.toThrow(/No adapter registered for ops/);
    expect(store.log()).toEqual([]);
  });
});

describe("integration result handling",()=>{
  it("records what the adapter returned, because that is the evidence the effect happened",async()=>{
    const store=new LocalStore(); const gateway=new IntegrationGateway(store);
    gateway.register("ops",{async execute(_operation,_input,key){return {ticket:`OPS-${key}`}}});
    await gateway.execute(ask());
    expect(store.log("integration.completed")[0]!.input).toMatchObject({result:{ticket:"OPS-evt-1:driver.assign"}});
  });
  it("cannot redact a payload an adapter hands back in its own result",async()=>{
    const store=new LocalStore(); const gateway=new IntegrationGateway(store);
    gateway.register("ops",{async execute(_operation,input){return {echoed:input}}});
    await gateway.execute(ask({payload:{iban:"JO94CBJO0010000000000131000302"}}));
    expect(JSON.stringify(store.log())).toContain("JO94CBJO0010000000000131000302");
  });
});
