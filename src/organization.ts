import type { ReasoningModel, Store } from "./domain.js";
export class OrganizationDesigner {
  constructor(private readonly model:ReasoningModel,private readonly store:Store){}
  async propose(companyContext:unknown,gapEvidence:unknown){const raw=await this.model.complete([{role:"system",content:"You are the People function. Propose a department or agent hire only when evidence shows a durable capability/capacity gap. Return JSON with action, role, mandate, evidence, alternatives, cost, successMeasures, reviewDate. Never invent a person or approve your own proposal."},{role:"user",content:JSON.stringify({companyContext,gapEvidence})}],{temperature:0.1});const proposal=JSON.parse(raw);await this.store.append("organization.proposal",proposal);return proposal}
}
