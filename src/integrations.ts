import type { Store } from "./domain.js";
export interface IntegrationAdapter { execute(operation:string,input:unknown,idempotencyKey:string):Promise<unknown> }
export type IntegrationRequest={provider:string; operation:string; payload:unknown; idempotencyKey:string; approvedBy?:string};
export type IntegrationRecord={status:"completed"|"failed"|"in_doubt"; fingerprint:string; result?:unknown; error?:string};

const stable=(value:unknown):string=>{
  if(value===undefined) return "undefined";
  if(value===null||typeof value!=="object") return JSON.stringify(value)??"null";
  if(Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
};
export const integrationFingerprint=(input:Pick<IntegrationRequest,"provider"|"operation"|"payload">):string=>{
  const text=`${input.provider}|${input.operation}|${stable(input.payload)}`;
  let low=0x811c9dc5,high=0x9e3779b9;
  for(let i=0;i<text.length;i++){ const code=text.charCodeAt(i); low=Math.imul(low^code,16777619)>>>0; high=Math.imul(high^(code+i),2246822519)>>>0 }
  return `${low.toString(16).padStart(8,"0")}${high.toString(16).padStart(8,"0")}`;
};

export class IntegrationGateway {
  private adapters=new Map<string,IntegrationAdapter>();
  private inFlight=new Map<string,{fingerprint:string; task:Promise<unknown>}>();
  constructor(private readonly store:Store){}
  register(name:string,adapter:IntegrationAdapter){this.adapters.set(name,adapter)}
  async execute(input:IntegrationRequest):Promise<unknown>{
    const adapter=this.adapters.get(input.provider); if(!adapter) throw new Error(`No adapter registered for ${input.provider}`);
    const fingerprint=integrationFingerprint(input);
    const running=this.inFlight.get(input.idempotencyKey);
    if(running){
      if(running.fingerprint!==fingerprint) throw new Error(`Idempotency key ${input.idempotencyKey} is already in flight for different work; reusing a key for a different action would make the audit trail unreliable`);
      return running.task;
    }
    const task=this.run(adapter,input,fingerprint);
    this.inFlight.set(input.idempotencyKey,{fingerprint,task});
    try{ return await task } finally { this.inFlight.delete(input.idempotencyKey) }
  }
  private async run(adapter:IntegrationAdapter,input:IntegrationRequest,fingerprint:string):Promise<unknown>{
    const evidence={provider:input.provider,operation:input.operation,idempotencyKey:input.idempotencyKey,fingerprint,...(input.approvedBy===undefined?{}:{approvedBy:input.approvedBy})};
    const prior=await this.store.query<IntegrationRecord|null>("integrations.by_key",{idempotencyKey:input.idempotencyKey});
    if(prior&&prior.fingerprint&&prior.fingerprint!==fingerprint)
      throw new Error(`Idempotency key ${input.idempotencyKey} was already used for ${prior.status==="completed"?"a completed":"a different"} action with a different payload; reusing a key for a different action would make the audit trail unreliable`);
    if(prior?.status==="completed"){ await this.store.append("integration.duplicate",evidence); return prior.result }
    await this.store.append("integration.requested",evidence);
    try{
      const result=await adapter.execute(input.operation,input.payload,input.idempotencyKey);
      await this.store.append("integration.completed",{...evidence,result});
      return result;
    }catch(error){
      await this.store.append("integration.failed",{...evidence,error:String(error)});
      throw error;
    }
  }
}
