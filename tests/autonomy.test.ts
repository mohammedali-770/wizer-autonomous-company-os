import {describe,expect,it} from "vitest";
import {AutonomousScheduler,LocalStore,PersistentEventBus,type CompanyEvent} from "../src/index.js";

const at=(hour:string)=>`2026-09-22T${hour}:00.000Z`;
const event=(id:string,type:string,hour:string):CompanyEvent=>({id,companyId:"c",type,payload:{hour},occurredAt:at(hour)});
const wire=()=>{const store=new LocalStore();const bus=new PersistentEventBus(store);return {store,bus,scheduler:new AutonomousScheduler(store,bus)}};

describe("scheduler and event bus",()=>{
  it("claims only what the clock has reached",async()=>{
    const {store,bus,scheduler}=wire();
    const seen:string[]=[];
    bus.on("metric.changed",async event=>{seen.push(event.id)});
    store.schedule(event("a","metric.changed","08:00"),event("b","metric.changed","11:00"));
    expect(await scheduler.tick(new Date(at("09:00")))).toBe(1);
    expect(seen).toEqual(["a"]);
    expect(await scheduler.tick(new Date(at("12:00")))).toBe(1);
    expect(seen).toEqual(["a","b"]);
  });
  it("delivers each event once, however often the clock runs",async()=>{
    const {store,bus,scheduler}=wire();
    let deliveries=0;
    bus.on("metric.changed",async()=>{deliveries++});
    store.schedule(event("a","metric.changed","08:00"));
    await scheduler.tick(new Date(at("23:00")));
    await scheduler.tick(new Date(at("23:00")));
    await scheduler.tick(new Date(at("23:00")));
    expect(deliveries).toBe(1);
  });
  it("routes by type and gives the wildcard every event",async()=>{
    const {store,bus,scheduler}=wire();
    const typed:string[]=[], all:string[]=[];
    bus.on("metric.changed",async e=>{typed.push(e.id)});
    bus.on("meeting.requested",async e=>{typed.push(e.id)});
    bus.on("*",async e=>{all.push(e.type)});
    store.schedule(event("a","metric.changed","08:00"),event("b","meeting.requested","09:00"),event("c","roaster.capacity","10:00"));
    await scheduler.tick(new Date(at("11:00")));
    expect(typed).toEqual(["a","b"]);
    expect(all).toEqual(["metric.changed","meeting.requested","roaster.capacity"]);
  });
  it("runs every handler registered for one type",async()=>{
    const {store,bus,scheduler}=wire();
    const order:string[]=[];
    bus.on("metric.changed",async()=>{order.push("first")});
    bus.on("metric.changed",async()=>{order.push("second")});
    store.schedule(event("a","metric.changed","08:00"));
    await scheduler.tick(new Date(at("09:00")));
    expect(order).toEqual(["first","second"]);
  });
  it("records every published event as evidence before any handler runs",async()=>{
    const {store,bus,scheduler}=wire();
    bus.on("metric.changed",async()=>{await store.append("reasoning.record",{})});
    store.schedule(event("a","metric.changed","08:00"));
    await scheduler.tick(new Date(at("09:00")));
    expect(store.log().map(entry=>entry.operation)).toEqual(["events.publish","reasoning.record"]);
  });
  it("delivers at most once, so a throwing handler forfeits the rest of the batch",async()=>{
    const {store,bus,scheduler}=wire();
    const seen:string[]=[];
    bus.on("metric.changed",async event=>{seen.push(event.id); if(event.id==="b") throw new Error("handler exploded")});
    store.schedule(event("a","metric.changed","08:00"),event("b","metric.changed","08:30"),event("c","metric.changed","09:00"));
    await expect(scheduler.tick(new Date(at("10:00")))).rejects.toThrow(/handler exploded/);
    expect(seen).toEqual(["a","b"]);
    expect(await scheduler.tick(new Date(at("10:00")))).toBe(0);
  });
});
