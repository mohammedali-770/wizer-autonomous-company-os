import type { Store } from "./domain.js";
export interface IntegrationAdapter { execute(operation:string,input:unknown,idempotencyKey:string):Promise<unknown> }
export class IntegrationGateway {
  private adapters=new Map<string,IntegrationAdapter>();
  constructor(private readonly store:Store){}
  register(name:string,adapter:IntegrationAdapter){this.adapters.set(name,adapter)}
  async execute(input:{provider:string;operation:string;payload:unknown;idempotencyKey:string;approvedBy?:string}){
    const adapter=this.adapters.get(input.provider); if(!adapter)throw new Error(`No adapter registered for ${input.provider}`);
    await this.store.append("integration.requested",{...input,payload:"[recorded separately]"});
    try{const result=await adapter.execute(input.operation,input.payload,input.idempotencyKey);await this.store.append("integration.completed",{...input,result});return result}catch(error){await this.store.append("integration.failed",{...input,error:String(error)});throw error}
  }
}
