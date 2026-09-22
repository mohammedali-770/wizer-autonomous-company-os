import type { Store } from "./domain.js";
import type { PersistentEventBus } from "./event-bus.js";

export type ApprovalRisk="low"|"medium"|"high";
export type ApprovalRequest={id:string; companyId:string; agentId:string; agentName:string; capability:string; risk:ApprovalRisk; objective:string; provider:string; payload:unknown; requestedAt:string; causationId?:string};
export type ApprovalStatus="pending"|"granted"|"rejected"|"unknown";
export type ApprovalOutcome={request:ApprovalRequest; decision:"granted"|"rejected"; approvedBy:string; reason:string; decidedAt:string};
export type ApprovalQueueOptions={bus?:PersistentEventBus; agentIdentities?:readonly string[]};

export class ApprovalQueue {
  private readonly bus:PersistentEventBus|undefined;
  private readonly agentIdentities:string[];
  constructor(private readonly store:Store,options:ApprovalQueueOptions={}){
    this.bus=options.bus;
    this.agentIdentities=(options.agentIdentities??[]).map(identity=>identity.trim().toLowerCase()).filter(Boolean);
  }
  async request(input:Omit<ApprovalRequest,"requestedAt">):Promise<ApprovalRequest>{
    const existing=await this.status(input.id);
    if(existing!=="unknown") throw new Error(`Approval ${input.id} already exists and is ${existing}; a decided request cannot be reopened`);
    const request:ApprovalRequest={...input,requestedAt:new Date().toISOString()};
    await this.store.append("approval.requested",request);
    return request;
  }
  pending(companyId?:string):Promise<ApprovalRequest[]>{ return this.store.query<ApprovalRequest[]>("approvals.pending",{companyId}) }
  status(id:string):Promise<ApprovalStatus>{ return this.store.query<ApprovalStatus>("approvals.status",{id}) }
  grant(id:string,approvedBy:string,reason="Approved"):Promise<ApprovalOutcome>{ return this.decide(id,"granted",approvedBy,reason) }
  reject(id:string,approvedBy:string,reason="Rejected"):Promise<ApprovalOutcome>{ return this.decide(id,"rejected",approvedBy,reason) }
  private async decide(id:string,decision:"granted"|"rejected",approvedBy:string,reason:string):Promise<ApprovalOutcome>{
    const approver=(approvedBy??"").trim();
    if(!approver) throw new Error("An approval must name the person making it; the constitution requires every consequential action to be attributable");
    const request=(await this.pending()).find(candidate=>candidate.id===id);
    if(!request){
      const status=await this.status(id);
      throw new Error(status==="unknown"?`No approval request ${id} is on record`:`Approval ${id} was already ${status} and cannot be decided again`);
    }
    const reserved=new Set([request.agentId,request.agentName,...this.agentIdentities].map(identity=>identity.trim().toLowerCase()).filter(Boolean));
    if(reserved.has(approver.toLowerCase())) throw new Error(`${approver} is an agent of this company and may not approve ${request.capability}; no agent may approve its own exceptional authority`);
    const outcome:ApprovalOutcome={request,decision,approvedBy:approver,reason,decidedAt:new Date().toISOString()};
    await this.store.append(`approval.${decision}`,outcome);
    await this.bus?.publish({id:`${id}:${decision}`,companyId:request.companyId,type:`approval.${decision}`,payload:outcome,occurredAt:outcome.decidedAt,causationId:request.causationId??request.id});
    return outcome;
  }
}
