import type { Agent, CompanyContext, ReasoningModel, Store, WorkProposal } from "./domain.js";
import { AuthorityEngine } from "./authority.js";
export class AgentRuntime {
  constructor(private readonly model:ReasoningModel,private readonly store:Store,private readonly authority=new AuthorityEngine()){}
  async deliberate(agent:Agent,context:CompanyContext,trigger:unknown):Promise<WorkProposal>{
    const raw=await this.model.complete([{role:"system",content:`You are ${agent.name}, ${agent.title}. Mandate: ${agent.mandate}. Reasoning personality: ${JSON.stringify(agent.personality)}. Use the entire supplied company context. Generate work at runtime; never use canned scenarios or answers. Return only JSON matching WorkProposal. Constitution is binding.`},{role:"user",content:JSON.stringify({context,trigger})}],{model:agent.modelPolicy.model as string|undefined,temperature:0.2});
    const proposal=JSON.parse(raw) as WorkProposal; if(!proposal.objective||!Array.isArray(proposal.requestedActions))throw new Error("Model returned invalid work proposal");
    await this.store.append("reasoning.record",{agentId:agent.id,trigger,proposal}); return proposal;
  }
  authorize(agent:Agent,proposal:WorkProposal){return proposal.requestedActions.map(action=>({action,decision:this.authority.evaluate(agent,action.capability,action.risk)}))}
}
