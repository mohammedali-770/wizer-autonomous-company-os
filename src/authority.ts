import type { Agent } from "./domain.js";
export type AuthorityDecision={allowed:boolean;requiresHuman:boolean;reason:string};
export class AuthorityEngine {
  evaluate(agent:Agent, capability:string, risk:"low"|"medium"|"high"):AuthorityDecision {
    if(agent.status!=="active") return {allowed:false,requiresHuman:false,reason:"Agent is not active"};
    if(!agent.authority.includes(capability)) return {allowed:false,requiresHuman:false,reason:"Capability is outside delegated authority"};
    if(risk==="high"||["funds.transfer","contract.sign","production.delete","person.terminate","secrets.rotate","outreach.send","prospect.export"].includes(capability)) return {allowed:true,requiresHuman:true,reason:"Consequential action crosses the human approval boundary"};
    return {allowed:true,requiresHuman:false,reason:"Within delegated authority"};
  }
}
