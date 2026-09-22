import { AgentRuntime, APPROVED_AGENTS, ApprovalQueue, AutonomousScheduler, ConvergenceMonitor, ExecutiveMeetingRoom, GlobalContextBuilder, IntegrationGateway, LocalStore, MemoryFabric, PersistentEventBus, ollamaFromEnv, type ApprovalOutcome, type CompanyEvent, type IntegrationAdapter, type WorkSignal } from "./index.js";

const FILE=process.env.WIZER_STORE??".wizer/company.json";
const SEATS=Number(process.env.WIZER_SEATS??3);
const CEO=APPROVED_AGENTS[0]!, SAMI=APPROVED_AGENTS.find(a=>a.name==="Sami")??APPROVED_AGENTS[3]!;
const COMPANY=CEO.companyId;
const DAY="2026-09-22T";
const line=(label:string)=>console.log(`\n${"=".repeat(68)}\n${label}\n${"=".repeat(68)}`);
const fingerprint=(text:string)=>{let hash=0;for(const ch of text.toLowerCase().replace(/[^a-z0-9]+/g," ").trim())hash=(hash*31+ch.charCodeAt(0))|0;return `fp-${(hash>>>0).toString(36)}`};
const event=(id:string,type:string,at:string,payload:unknown):CompanyEvent=>({id,companyId:COMPANY,type,payload,occurredAt:`${DAY}${at}:00.000Z`});

const store=await LocalStore.open(FILE);
store.seedContext({
  strategy:{mission:"Supply single-origin coffee to offices in Amman",goals:["Reach 40 recurring office accounts","Hold gross margin above 55%"]},
  organization:{headcount:6,openRoles:["Delivery coordinator"]},
  operations:{deliveriesPerWeek:52,onTimeRate:0.86,roasterCapacityKgPerWeek:180},
  finance:{cashJod:38000,monthlyBurnJod:9500,runwayMonths:4},
  customers:{accounts:23,churnedLastQuarter:3,topComplaint:"Late Sunday deliveries"},
  product:{skus:7,bestSeller:"Ethiopia Guji 1kg"},
  risks:[{risk:"Single roaster, no backup",severity:"high"}],
  recent_events:[{type:"delivery.late",count:9,window:"last 14 days"}],
  decisions:[{decision:"Paused wholesale discounting",at:"2026-08-02"}],
  open_questions:["Is Sunday lateness a routing problem or a capacity problem?"]
});

const model=ollamaFromEnv();
line(`Wizer autonomous run — model ${process.env.LLM_MODEL??"llama3.2:3b"}, store ${FILE}`);
try{ await model.warmup() }catch(error){ console.error(`\n${(error as Error).message}\n`); process.exit(1) }

const bus=new PersistentEventBus(store);
const scheduler=new AutonomousScheduler(store,bus);
const runtime=new AgentRuntime(model,store);
const room=new ExecutiveMeetingRoom(model,store);
const memory=new MemoryFabric(store);
const monitor=new ConvergenceMonitor();
const gateway=new IntegrationGateway(store);
const opsDesk:IntegrationAdapter={async execute(operation,_input,idempotencyKey){ console.log(`      ops desk executed ${operation} (idempotency ${idempotencyKey})`); return {status:"recorded",ticket:`OPS-${idempotencyKey}`} }};
gateway.register("ops",opsDesk);

const approvals=new ApprovalQueue(store,{bus,agentIdentities:APPROVED_AGENTS.flatMap(agent=>[agent.id,agent.name])});
const history:WorkSignal[]=[];
const halted:string[]=[];

bus.on("metric.changed",async event=>{
  const verdict=monitor.assess(history);
  if(!verdict.continue){ halted.push(`${event.id}: ${verdict.reason}`); console.log(`   convergence monitor refused to act again — ${verdict.reason}`); return }
  const context=await new GlobalContextBuilder(store).build(COMPANY);
  let proposal;
  try{ proposal=await runtime.deliberate(CEO,context,event.payload) }
  catch(error){ console.log(`   deliberation failed: ${(error as Error).message}`); return }
  console.log(`   ${CEO.name} proposes: ${proposal.objective}`);
  history.push({fingerprint:fingerprint(proposal.objective),goalId:event.type,progress:proposal.confidence,cost:1,at:history.length});
  for(const {action,decision} of runtime.authorize(CEO,proposal)){
    if(!decision.allowed){ console.log(`      refused ${action.capability}: ${decision.reason}`); continue }
    if(decision.requiresHuman){
      await approvals.request({id:`${event.id}:${action.capability}`,companyId:COMPANY,agentId:CEO.id,agentName:CEO.name,capability:action.capability,risk:action.risk,objective:proposal.objective,provider:"ops",payload:action.input,causationId:event.id});
      console.log(`      parked ${action.capability} for a human: ${decision.reason}`); continue;
    }
    await gateway.execute({provider:"ops",operation:action.capability,payload:action.input,idempotencyKey:`${event.id}:${action.capability}`});
  }
  await memory.remember({companyId:COMPANY,kind:"decision",subject:proposal.objective,content:`${CEO.name} proposed "${proposal.objective}" after ${event.type}. Rationale: ${proposal.rationale}`,importance:proposal.confidence,sourceIds:[event.id]});
});

bus.on("approval.granted",async event=>{
  const {request,approvedBy}=event.payload as ApprovalOutcome;
  console.log(`   ${approvedBy} approved ${request.capability} for "${request.objective}"`);
  await gateway.execute({provider:request.provider,operation:request.capability,payload:request.payload,idempotencyKey:request.id,approvedBy});
});

bus.on("approval.rejected",async event=>{
  const {request,approvedBy,reason}=event.payload as ApprovalOutcome;
  console.log(`   ${approvedBy} rejected ${request.capability}: ${reason}`);
  await memory.remember({companyId:COMPANY,kind:"decision",subject:`Rejected ${request.capability}`,content:`${approvedBy} rejected ${request.capability} for "${request.objective}". Reason: ${reason}`,importance:0.9,sourceIds:[request.id]});
});

bus.on("meeting.requested",async event=>{
  const context=await new GlobalContextBuilder(store).build(COMPANY);
  const topic=(event.payload as {topic:string}).topic;
  try{
    const meeting=await room.convene({topic,context,participants:APPROVED_AGENTS.slice(0,SEATS)});
    console.log(`   ${SEATS} seats spoke on "${topic}"`);
    console.log(`   synthesis: ${JSON.stringify(meeting.synthesis).slice(0,260)}`);
  }catch(error){ console.log(`   meeting failed: ${(error as Error).message}`) }
});

bus.on("roaster.capacity",async event=>{
  const context=await new GlobalContextBuilder(store).build(COMPANY);
  try{
    const proposal=await runtime.deliberate(SAMI,context,event.payload);
    console.log(`   ${SAMI.name} proposes: ${proposal.objective}`);
    for(const {action,decision} of runtime.authorize(SAMI,proposal))
      console.log(`      ${action.capability} (${action.risk}) -> ${decision.allowed?(decision.requiresHuman?"needs a human":"allowed"):"outside delegated authority"}`);
  }catch(error){ console.log(`   deliberation failed: ${(error as Error).message}`) }
});

line("The company's day is scheduled, then nobody calls anything");
const lateDelivery={type:"metric.changed",metric:"onTimeRate",from:0.94,to:0.86,zone:"Sunday"};
store.schedule(
  event("evt-1","metric.changed","08:00",lateDelivery),
  event("evt-2","meeting.requested","09:00",{topic:"Sunday deliveries are 8 points below target"}),
  event("evt-3","roaster.capacity","10:00",{type:"roaster.capacity",utilisation:0.97}),
  event("evt-4","metric.changed","11:00",lateDelivery),
  event("evt-5","metric.changed","12:00",lateDelivery),
  event("evt-6","metric.changed","13:00",lateDelivery)
);
console.log("6 events queued across the day. The scheduler claims each one only when its time arrives.");

line("Running the clock");
for(const hour of ["08:00","09:00","10:00","11:00","12:00","13:00"]){
  console.log(`\n--- ${hour} ---`);
  if(!await scheduler.tick(new Date(`${DAY}${hour}:30.000Z`))) console.log("   nothing due");
}
console.log(`\nA second pass over the same day claims ${await scheduler.tick(new Date(`${DAY}23:59:00.000Z`))} events: every one was already taken.`);

line("What the company would not do on its own");
const waiting=await approvals.pending(COMPANY);
for(const item of waiting) console.log(`  ${item.id}\n     ${item.agentName} wants ${item.capability} (${item.risk}) for "${item.objective}"`);
if(!waiting.length) console.log("  Nothing crossed the approval boundary this run.");
if(halted.length) for(const reason of halted) console.log(`  stopped: ${reason}`);

const first=waiting[0], second=waiting[1];
if(first){
  line("Who may not decide it");
  for(const [approver,why] of [[CEO.name,"the agent that asked for it"],["Sami","another agent on the roster"],["   ","nobody named"]] as Array<[string,string]>){
    try{ await approvals.grant(first.id,approver); console.log(`  NOT REFUSED — ${approver} approved it`) }
    catch(error){ console.log(`  ${why}: ${(error as Error).message}`) }
  }

  line("A person decides, and the work resumes on the bus");
  await approvals.grant(first.id,"mohammed","Runway supports one relief driver");
  if(second) await approvals.reject(second.id,"mohammed","The same objective was already approved once today");
  try{ await approvals.grant(first.id,"mohammed") }
  catch(error){ console.log(`   second attempt: ${(error as Error).message}`) }
  console.log(`\n   still waiting on a person: ${(await approvals.pending(COMPANY)).length}`);
}

line("The same instruction twice");
const replayKey="demo:driver.assign", replayPayload={zone:"Sunday",driver:"Rami"};
await gateway.execute({provider:"ops",operation:"driver.assign",payload:replayPayload,idempotencyKey:replayKey});
await gateway.execute({provider:"ops",operation:"driver.assign",payload:replayPayload,idempotencyKey:replayKey});
console.log("   the ops desk ran once, though the gateway was called twice");
try{ await gateway.execute({provider:"ops",operation:"driver.assign",payload:{zone:"Monday",driver:"Rami"},idempotencyKey:replayKey}); console.log("   NOT REFUSED") }
catch(error){ console.log(`   ${(error as Error).message}`) }

line("Audit trail");
const counts=new Map<string,number>();
for(const entry of store.log()) counts.set(entry.operation,(counts.get(entry.operation)??0)+1);
for(const [operation,count] of [...counts].sort()) console.log(`  ${operation.padEnd(24)} ${count}`);
console.log(`\nEvery line above is evidence in ${FILE}.`);
