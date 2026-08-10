import type { Store } from "./domain.js";
export type CompanyEvent={id:string;companyId:string;type:string;payload:unknown;occurredAt:string;causationId?:string;correlationId?:string};
export class PersistentEventBus {
  private handlers=new Map<string,Array<(event:CompanyEvent)=>Promise<void>>>();
  constructor(private readonly store:Store){}
  on(type:string,handler:(event:CompanyEvent)=>Promise<void>){this.handlers.set(type,[...(this.handlers.get(type)??[]),handler])}
  async publish(event:CompanyEvent){await this.store.append("events.publish",event); for(const h of [...(this.handlers.get(event.type)??[]),...(this.handlers.get("*")??[])])await h(event)}
}
export class AutonomousScheduler {
  constructor(private readonly store:Store,private readonly bus:PersistentEventBus){}
  async tick(now=new Date()){const due=await this.store.query<CompanyEvent[]>("scheduler.claim_due",{now:now.toISOString()}); for(const e of due)await this.bus.publish(e); return due.length}
}
