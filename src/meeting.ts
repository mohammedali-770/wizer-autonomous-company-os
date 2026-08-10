import type { Agent, CompanyContext, ReasoningModel, Store } from "./domain.js";
export class ExecutiveMeetingRoom {
  constructor(private readonly model:ReasoningModel,private readonly store:Store){}
  async convene(input:{topic:string;context:CompanyContext;participants:Agent[]}){
    const transcript=[] as unknown[];
    for(const agent of input.participants){const response=await this.model.complete([{role:"system",content:`Speak as ${agent.name}, ${agent.title}, using this distinct reasoning personality: ${JSON.stringify(agent.personality)}. Address the live agenda from company evidence. Disagree honestly. Do not use scripted responses.`},{role:"user",content:JSON.stringify({topic:input.topic,context:input.context,transcript})}],{temperature:0.3});transcript.push({agentId:agent.id,name:agent.name,response});await this.store.append("meeting.message",{topic:input.topic,agentId:agent.id,response})}
    const synthesis=await this.model.complete([{role:"system",content:"Synthesize this executive discussion into decisions, dissent, assumptions, owners, deadlines, and unresolved questions. Do not erase minority views. Return JSON."},{role:"user",content:JSON.stringify(transcript)}],{temperature:0.1});const result={topic:input.topic,transcript,synthesis:JSON.parse(synthesis)};await this.store.append("meeting.completed",result);return result;
  }
}
